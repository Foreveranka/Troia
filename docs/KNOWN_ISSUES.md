# Troia — Known Issues (engineering)

> Engineering gaps in the testnet PoC — not the business/scope risks (those live in
> [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md)). Each item states what is true, why it is money-safe
> today, and what closes it.

They are grouped, because they are three different kinds of thing and a reader deserves to know which is which.
**A. Defects** — the code does not do what it says it does. These are not testnet concessions; testnet only means
the money is valueless, so none of them can hurt anyone today. **B. Deliberate deferrals** — not built, because the
PoC does not need it. **C. Unproven** — built and unit-tested, but never exercised against a live chain.

Tags mark **when** each must close: `[mainnet-blocker]` before real money moves, `[public-deploy]` the day this runs
on more than one instance or machine, `[test-gap]` proven by tests but not yet by a live run, `[housekeeping]`
operational polish with no money-safety edge.

---

# A. Defects — the code does not do what it says it does

## 1. `[mainnet-blocker]` A crash in the charge window can strand a paid order (customer charged, merchant unpaid)

Seven append-only logs under `TROIA_DATA_DIR/<troyPool-id>/` survive a crash: the double-entry journal, the
settlement evidence (which carries each order's frozen facts and doubles as the settlement work-list), the
write-ahead list of authorized `pay()` hashes, the chain observations, the reconciled marks, and the payout tail's
cursor + suspects. They have an explicit crash contract (ARCHITECTURE §7b), and a durable-log failure exits the
process rather than degrading quietly.

Deliberately **volatile**: the `OrderRow`s, the reservation ledger, the pending-settlement store, the operator
sequence snapshot, and the bounded-retry counters (`deadRetries` / `reversalRetries` / `revertOtherRetries` —
in-memory `Map`s, not on the `OrderRow`). A restart resets those counters, so a retry budget restarts from zero on
recovery. For `deadRetries`/`reversalRetries` this is inert in the PoC (the same crash erases the work-list, so
nothing is re-driven — see below); `revertOtherRetries` has the widest blast radius, because its loop state
(`UsdcSubmitted`) IS in the poll worker's recovery set and each iteration burns a fresh operator sequence, so once
the durable store lands a durably-paused pool could re-open up to `maxRevertOtherRetries` fresh seq-burns per
restart. All three counters must move onto the durable `OrderRow` alongside the durable sequence store when it does.

- **Consequence.** An order that was submitted but had not yet landed is forgotten by a restart, and `/status` and
  `/receipt` answer `404` for it — as they do for an order that failed cleanly, since a clean failure leaves no
  durable record either. A **settled** order does survive: both endpoints fall back to the durable evidence log, so
  it keeps answering `completed` with its real transaction hash. (It answered `NotFound` when this was first
  observed in the `2026-07-10` live run; that fallback was the fix.)
- **Why that is safe, in the direction that matters most.** The on-chain `Processed(tx_id)` guard and the
  single-use operator sequence each cap USDC delivery at one per order. The durable evidence row keeps a confirmed
  settlement armed. No crash can produce a second payout.
- **And the direction it is NOT safe in — stated plainly.** An order sitting in `SolvencyReserved` when the process
  dies is lost, and the customer can already have paid on the hosted form that state opened. The charge then exists
  at iyzico and nothing on our side records it: the write-ahead journal is written at submit time and the evidence
  log after confirmation, so both are still empty. On restart the poll worker's work-list is the in-memory registry
  the crash erased, so nobody re-drives the order, nobody voids the sale, and the merchant is never paid. The
  customer is charged and unsettled, with no automatic unwind. On testnet this costs nothing (the cards are
  valueless); on mainnet it is a real customer-facing exposure, and it is the strongest single argument for the fix
  below.
- **What closes it.** A real database — one transaction, all the rows — behind the same `Store` / `DurableLog`
  interfaces. Recovery would then find the charged order and drive it (the sale re-retrieve is already idempotent),
  or void it. This changes the money path's crash semantics, so it is a deliberate later step — but it is the one
  gap on this page that is not merely tidiness.

## 2. `[mainnet-blocker]` The pool refill can mint twice across a crash

`settleAndRebalance` refills the pool from an order's collected TRY. Its guard against a double refill is durable —
`ledger.hasRef(ref)` reads a set the journal rebuilds at boot, and the ref derives from the order, not from a counter
— but it is read **before** the mint, and the write that makes it true (`ledger.recordTopUp`) runs **after** the mint
has already landed on chain. A crash inside that window leaves the mint landed and unbooked. On restart the evidence
log re-arms the order (it is the settlement work-list, §1), `hasRef` is still false, and `SimulatedRebalance`'s dedup
cache is in-memory and gone — so the order mints a **second** time.

No hardware failure is needed to reach it: a durable-log write failure immediately after a successful mint throws, and
the process exits by design (§1), with the mint unbooked.

- **Why it is money-safe today.** Testnet USDC is self-issued and valueless, and the error is **positive** — the pool
  ends up holding more than the books say, never less. No customer is short-changed, no merchant unpaid.
- **What it costs anyway.** One top-up is booked against two mints, so the drift is permanent and the solvency
  tripwire alarms on it forever with nothing able to clear it. An alarm that cannot be cleared is an alarm people
  learn to ignore.
- **Why it blocks mainnet.** There, `topUp` becomes a real CEX buy + withdrawal behind the same `RebalanceProvider`
  seam. The same window then spends real fiat twice.
- **What closes it.** A durable mint-intent written **before** `topUp` and cleared after `recordTopUp` — the same
  write-ahead discipline the `pay()` path already uses (`persistInFlight` precedes `submitPay`, ARCHITECTURE §3). The
  mint path has no write-ahead journal today.

## 3. `[mainnet-blocker]` An escalated order is never latched — it re-escalates every tick

When the poll worker cannot prove what happened to a burned-but-unproven sequence, it quarantines the order:
`applyEscalate` writes a loss flag (in-memory, §1) and stops. But it writes **only** the flag — no state transition, no
`registry.put`. The order therefore keeps its `UsdcSubmitted` / `UsdcPending` state, which is in the worker's
`RECOVERY_STATES`, so the next tick re-selects it and escalates it again. Forever. `flagLoss` is an unconditional push
with no dedup, so each tick appends another loss row for the same order.

The driver's own contract states the invariant that was never implemented: _"recovery must not re-drive a loss-flagged
order."_ Nothing anywhere reads the loss flag. Note the asymmetry: the **core**'s route into `LossReview` does latch,
because `LossReview` sits deliberately outside `RECOVERY_STATES`. Only the driver's escalate path — the one with no
core event — does not.

- **Why it is money-safe.** `applyEscalate` moves no money, burns no sequence, and submits nothing.
- **What it costs.** The loss report — the very thing meant to hand the order to a human — fills with thousands of
  duplicate rows for one order, and `losses[]` grows without bound. On the observe branch it also spends one Stellar
  RPC read per order per tick, forever.
- **Why it blocks mainnet.** Because the escalate path never changes state, such an order keeps answering `processing`
  on `GET /status`, never `review` (ARCHITECTURE §2). A real customer's charge would sit in an unresolved USDC state
  while the status endpoint reports it as merely in progress, and the loss report that should hand it to a human is
  buried under its own duplicates. The quarantine that most needs a person is the one that never surfaces — which is
  precisely the claim this project is built on.
- **What closes it.** A durable parked state (or a loss-flag read in `Store` that the work-list skips), plus making
  `flagLoss` idempotent per `(orderId, bucket)`.

---

# B. Deliberate deferrals — not built because the PoC does not need it

## 4. `[public-deploy]` Solvency assumes exactly one backend process

The pool's reservation gate is an in-process lock (`Mutex`), so `reserve()`'s check and commit are serialized on a
single event loop. **Two backend processes against the same pool would hold two independent locks and could both
reserve the same last coin.**

- **Why it has never bitten.** The PoC runs one process. The contract's own `balance >= amount` guard is the
  second, independent shield: an over-committed backend still cannot make the chain overdraw the pool.
- **What closes it.** A shared lock — the database row lock that arrives with §1, or a lease/advisory lock.
- **Watch this before any public deployment.** A platform that runs two instances, or overlaps a new instance with
  the old one during a redeploy, silently removes the backend half of invariant ③a.

## 5. `[public-deploy]` `/intent` is unauthenticated; rate limiting is per-IP

`POST /intent` takes no credential — anyone who can reach the backend can call it. That is **not a theft path**: the
caller pays the TRY themselves (the backend prices the order server-side), and every field is re-validated
fail-closed, so a forged call can neither misroute funds nor dictate a price. What a forged call can do is **cost** —
each accepted intent reserves the pool and opens a hosted form.

- **The mitigation in place.** A per-IP cap on `/intent` (`@fastify/rate-limit`, default 20/min). `GET /status` is
  deliberately exempt, so the extension's 3-second poll is never throttled. This stops a naive single-source flood.
- **What it does NOT stop, stated plainly.** The cap keys on `request.ip`. Two ways around it: a distributed or
  rotating-IP caller spends a few requests per IP and never trips a per-IP cap, so it can still fill the pool with
  reservations and make honest shoppers see `409 PoolInsufficient`; and under `trustProxy`, `request.ip` honors
  `X-Forwarded-For`, so a directly-exposed backend with no sanitizing proxy in front lets a client spoof and rotate
  the key. The counter is in-memory — per process, so a second backend keeps its own count (§4).
- **Why it is safe today.** The PoC runs one process on the operator's own machine, iyzico is sandbox (no real charge
  is possible), and the pool holds valueless testnet USDC. The exposure is availability, not loss.
- **What closes it.** A reservation budget keyed on the order/session rather than the IP, and/or authenticating
  `/intent` (a token the storefront mints). Both are public-deployment work, not correctness work.

## 6. `[housekeeping]` No log rotation

Boot refuses to open a log at or above 2 GiB (`2**31` bytes, where `readFileSync` hard-fails) with an explanatory
error rather than truncating it. At the payout tail's cadence the cursor log — the fastest-growing of the seven —
takes years to approach that. Rotation is a later operational concern, not a correctness one.

---

# C. Unproven — built, but never exercised against the chain

## 7. `[test-gap]` Paths proven by tests, not yet by the chain

Every item here is code that exists and passes its unit tests. What is missing is the live shot. None of them is
blocked by testnet — they are simply experiments nobody has staged yet, and each would turn a sentence in these docs
into a fact on chain.

- **`ROGUE PAYOUT` has never fired against a real unauthorized outflow.** The live runs proved only the negative —
  that an authorized payout is not accused, including after a restart erased the in-memory order registry. Submitting
  a `pay()` that bypasses the backend (so its hash never reaches the write-ahead journal) would prove the positive,
  and it is the sharpest claim this system makes.
- **The revert-code read path** is exercised only by fakes. A _successful_ live `pay()` is proven; a
  landed-and-**reverted** `pay()`'s diagnostic events are the one shape only a live failing transaction confirms.
  `pause()`ing the pool and then submitting a `pay()` produces exactly that transaction, and
  `scripts/probe-revert.mjs` is the check already written for it.
- **`CHAIN_DIVERGENCE`** (a different transaction settled this order) and both blind-spot states
  (`never-watched`, `aged-out`) are exercised by unit tests only.
- **The contract's `upgrade()` has never been exercised positively.** Only its auth gate is tested
  (`unauthorized_cannot_upgrade` reverts). No test uploads a second wasm, upgrades to it, and asserts the pool's
  state survived — that needs a real v2 artifact, and faking one would test the host rather than our logic. Until it
  is run, "upgradeable" is a claim about the code path, not about a swap anyone has performed.
- **Concurrency is unit-proven, not load-proven.** The solvency race (many simultaneous checkouts competing for the
  last coin) is proven offline, including the mutation check that removing the lock makes the same workload
  over-commit — but never against the live rails. Note the shape of that gap before spending on it: `reserve()`
  performs its check and commit inside one lock acquisition, and the offline test injects a yield at the single
  `await` inside that critical section — the widest interleaving the runtime permits. **No network call runs inside
  the pool mutex.** A live burst would therefore exercise a narrower window than the test already does. What remains
  genuinely untested is throughput, not correctness — and the multi-process hazard in §4, which no single-process
  load test can find.
