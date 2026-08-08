# Troia — Known Issues (engineering)

> Engineering gaps in the testnet PoC — not the business/scope risks (those live in
> [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md)). Each item states what is true, why it is money-safe
> today, and what closes it.

They are grouped, because they are two different kinds of thing and a reader deserves to know which is which.
**A. Defects** — the code does not do what it says it does. These are not testnet concessions; testnet only means
the money is valueless, so none of them can hurt anyone today. **B. Deliberate deferrals** — not built, because the
PoC does not need it. (Paths that are built and unit-tested but not yet live-proven are a separate, softer thing —
testing maturity, not a defect — and live in [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md).)

Tags mark **when** each must close: `[mainnet-blocker]` before real money moves, `[public-deploy]` the day this runs
on more than one instance or machine, `[housekeeping]` operational polish with no money-safety edge. (Paths proven by
tests but not yet by a live chain — once tagged `[test-gap]` here — now live in
[`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md), per the note above.)

**All of these are deferred to Phase 2 — the regulated mainnet build (ADR-10), a separate phase by design.** On the
testnet PoC every item is money-safe today: the USDC is self-issued and valueless, no path double-pays a merchant or
short-changes a customer, and the worst any of them does is strand a charged order for a human to resolve or raise a
false/uncleared alarm. Two of them (`[public-deploy]`) would also bite a public **demo** deploy before mainnet — each
names its one-line interim mitigation. Deferring is a scheduling choice, not a claim that any of them stopped being
real; each entry says exactly what it is and what closes it.

---

# A. Defects — the code does not do what it says it does

## 1. `[mainnet-blocker]` A crash in the charge window can strand a paid order (customer charged, merchant unpaid)

Seven append-only logs under `TROIA_DATA_DIR/<troyPool-id>/` survive a crash: the double-entry journal, the
settlement evidence (which carries each order's frozen facts and doubles as the settlement work-list), the
write-ahead list of authorized `pay()` hashes, the chain observations, the reconciled marks, and the payout tail's
cursor + suspects. They have an explicit crash contract (ARCHITECTURE §3b), and a durable-log failure exits the
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
- **What closes it — Phase 2.** A real database — one transaction, all the rows — behind the same `Store` /
  `DurableLog` interfaces. Recovery would then find the charged order and drive it (the sale re-retrieve is already
  idempotent), or void it. It changes the money path's crash semantics, so it belongs to the mainnet build, not a
  testnet patch — but it is the one gap on this page that is not merely tidiness, and it is the reason mainnet is a
  deliberate later phase.
- **Status update (2026-08-08, later the same day): LIVE-PROVEN.** The exact scenario above was rehearsed
  against the recorded testnet pool: an order was paid on the hosted form while the backend was DEAD, and on
  restart the durable store recovered it, the poll worker re-retrieved the sale, and the payout settled and
  reconciled with zero alarms (DEPLOYMENTS.md, "Channel accounts live drill — the crash variant").
- **Status (2026-08-08): closed in code, not yet live-proven.** `@troia/composition` now wires a SQLite-backed
  `Store` + `OrderRegistry` (`order-db.ts`, `sqlite-order-store.ts`, `sqlite-order-registry.ts`) whenever a
  `TROIA_DATA_DIR` is set: order rows, the reservation ledger, the retry counters, the webhook dedup set, the loss
  flags and the poll worker's work-list all survive a restart, and boot replays unsettled reservations as held
  (fail-closed) while dropping settled ones (their payout is already in the fresh chain read). An order parked in
  `SolvencyReserved` at the crash is re-driven by the existing poll worker paths — the charged-and-forgotten window
  above no longer exists on the durable deployment. Covered by unit + factory-level restart tests; a deliberate
  crash/restart drill against the live testnet has not been run yet, and the multi-instance half (§3) remains open —
  the reserve CHECK→COMMIT is still serialized by the in-process mutex, not a cross-process lock.

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
  seam. The same window then spends real fiat twice. So the CEX swap does not retire this bug — it is what makes it
  dangerous; the fix must land **before or with** that swap, never after.
- **What closes it — Phase 2, with the rebalance/on-ramp work.** A durable mint-intent written **before** `topUp` and
  cleared after `recordTopUp` — the same write-ahead discipline the `pay()` path already uses (`persistInFlight`
  precedes `submitPay`, ARCHITECTURE §4). The mint path has no write-ahead journal today. Safe to defer only because
  the window is unreachable in practice on the PoC (it needs a crash in the sub-second gap between the mint landing
  and its booking), not because it will be rewritten away.
- **Status (2026-08-08): closed in code, not yet live-proven.** The settlement worker now takes an optional
  `MintIntentJournal` (durable deploy: `SqliteMintIntentJournal` in the same `orders.db` as §1's store): the intent
  is written **before** `topUp` and cleared **after** `recordTopUp`. A ref left open by a previous life is refused —
  no second mint, ever — and surfaced at boot (`[mint-wal] UNRESOLVED MINT INTENT`) and per tick (`MINT BLOCKED`,
  edge-triggered) for a human to reconcile: if the mint landed, book it and `hasRef` auto-resolves the stale intent;
  if it never landed, clear the intent and the next tick mints normally. A clean same-life retry is not blocked (the
  rebalance provider's per-ref idempotency covers it). Pinned by worker-ordering tests and two-life journal tests;
  the CEX swap can now land behind this guard, not before it.

---

# B. Deliberate deferrals — not built because the PoC does not need it

## 3. `[public-deploy]` Solvency assumes exactly one backend process

The pool's reservation gate is an in-process lock (`Mutex`), so `reserve()`'s check and commit are serialized on a
single event loop. **Two backend processes against the same pool would hold two independent locks and could both
reserve the same last coin.**

- **Why it has never bitten.** The PoC runs one process. The contract's own `balance >= amount` guard is the
  second, independent shield: an over-committed backend still cannot make the chain overdraw the pool.
- **What closes it — Phase 2.** A shared lock — the database row lock that arrives with §1, or a lease/advisory lock.
- **Interim, for a public demo deploy.** Run exactly **one** backend instance: no autoscaling, and no overlapping a
  new instance with the old one during a redeploy. The single-process assumption then holds, and the contract guard
  covers the rest. A platform that quietly runs two instances removes the backend half of invariant ③a.
- **Status (2026-08-08): the SOLVENCY half is closed on the durable deployment.** The SQLite-backed store (§1's
  status note) runs reserve()'s CHECK→COMMIT inside one `BEGIN IMMEDIATE` transaction, so two processes sharing the
  same `orders.db` serialize at the database's write lock and cannot both reserve the same last coin — a blocked
  instance waits (busy_timeout) or fails fast, never interleaves. Pinned by two-connection tests. Running two
  instances remains **unsupported** for the rest of the system: the per-order locks and the operator sequence
  allocator are still per-process, so the one-instance rule above still stands — this closes the money-arithmetic
  hazard, not the deployment mode.

## 4. `[public-deploy]` `/intent` is unauthenticated; rate limiting is per-IP

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
  the key. The counter is in-memory — per process, so a second backend keeps its own count (§3).
- **Why it is safe today.** The PoC runs one process on the operator's own machine, iyzico is sandbox (no real charge
  is possible), and the pool holds valueless testnet USDC. The exposure is availability, not loss.
- **What closes it — Phase 2.** A reservation budget keyed on the order/session rather than the IP, and/or
  authenticating `/intent` (a token the storefront mints). Both are public-deployment work, not correctness work.
- **Interim, for a public demo deploy.** The exposure is availability only (sandbox charge, valueless pool), so the
  per-IP cap stays and, if the backend is exposed directly, front it with a proxy that sanitizes `X-Forwarded-For`
  so the cap key cannot be spoofed. Accept the residual reservation-flood risk knowingly — it costs nothing but a
  `409`.
- **Status (2026-08-08): the session gate is in.** A deployed server (`buildTestnetServerDeps`) now requires a
  short-lived HMAC session token on `POST /intent` (`401 SessionRequired` without one; `POST /session` mints them,
  per-IP limited) and counts accepted NEW orders against a per-session budget (`429 SessionBudgetExceeded`) — the
  reservation cost is keyed on a server-issued identity, not the caller's self-chosen IP, and the gate runs before
  any snapshot/oracle work. The idempotent duplicate-click replay burns no budget. The extension mints and caches
  the token transparently (one extra round-trip per ~15 min; self-heals on 401 after a backend restart — the secret
  is per-boot random on purpose). The per-IP caps stay as the outer layer. Honest residual: a distributed attacker
  can still farm sessions from many IPs — the budget bounds each one, but this raises cost rather than closing the
  distributed case; the offline suite keeps the gate off (`intentAuth` unset) by design.

## 5. `[housekeeping]` No log rotation

Boot refuses to open a log at or above 2 GiB (`2**31` bytes, where `readFileSync` hard-fails) with an explanatory
error rather than truncating it. At the payout tail's cadence the cursor log — the fastest-growing of the seven —
takes years to approach that. Rotation is a later operational concern, not a correctness one — **Phase 2 housekeeping**,
deferred because the ceiling is years away.

---

> **A note on live-but-unproven paths.** A few detection paths are built and unit-tested but not yet exercised
> against the chain (`CHAIN_DIVERGENCE`, the two payout-tail blind spots, a positive `upgrade()`, and load/soak).
> Those are testing-maturity gaps, not defects — the code is there and green — so they live under "what testnet has
> and has not proven" in [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md), not on this page. (The revert-read
> path and `ROGUE PAYOUT`, once in that list, were fired live on `2026-07-14` — see DEPLOYMENTS.md.)
