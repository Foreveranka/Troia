# Troia — Known Issues (engineering)

> This is the engineer's list, not the reviewer's risk list. Nothing here changes whether the project is worth
> funding; every item is a bounded implementation gap in a testnet proof-of-concept, with the reason it is safe and
> the shape of its fix. The risks that _do_ bear on the decision — inventory acquisition, unit economics,
> regulation, market size — live in [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md) and are stated there in
> full. Splitting the two is a claim about proportion, not a place to hide anything.

Each item states: what is true, why it is money-safe today, and what closes it.

---

## 1. Not everything survives a restart

Seven append-only logs under `TROIA_DATA_DIR/<troyPool-id>/` survive a crash: the double-entry journal, the
settlement evidence (which carries each order's frozen facts and doubles as the settlement work-list), the
write-ahead list of authorized `pay()` hashes, the chain observations, the reconciled marks, and the payout tail's
cursor + suspects. They have an explicit crash contract (ARCHITECTURE §7b), and a durable-log failure exits the
process rather than degrading quietly.

Deliberately **volatile**: the `OrderRow`s, the reservation ledger, the pending-settlement store, and the operator
sequence snapshot.

- **Consequence.** An order that was submitted but had not yet landed is forgotten by a restart.
- **Why that is safe, in the direction that matters most.** The on-chain `Processed(tx_id)` guard and the
  single-use operator sequence each cap USDC delivery at one per order. The durable evidence row keeps a confirmed
  settlement armed. No crash can produce a second payout.
- **And the direction it is NOT safe in — stated plainly.** An order sitting in `SolvencyReserved` when the process
  dies is lost, and that state is reached **after the hosted form is shown**. If the customer had already paid, the
  charge exists at iyzico and nothing on our side records it: the write-ahead journal is written at submit time and
  the evidence log after confirmation, so both are still empty. On restart the poll worker's work-list is the
  in-memory registry the crash erased, so nobody re-drives the order, nobody voids the sale, and the merchant is
  never paid. The customer is charged and unsettled, with no automatic unwind. On testnet this costs nothing (the
  cards are valueless); on mainnet it is a real customer-facing exposure, and it is the strongest single argument
  for the fix below.
- **What closes it.** A real database — one transaction, all the rows — behind the same `Store` / `DurableLog`
  interfaces. Recovery would then find the charged order and drive it (the sale re-retrieve is already idempotent),
  or void it. This changes the money path's crash semantics, so it is a deliberate later step — but it is the one
  gap on this page that is not merely tidiness.

## 2. `/status` and `/receipt` after a restart

Both endpoints fall back to the durable evidence log, so a **settled** order keeps answering `completed`, with its
real transaction hash, across a restart. (It answered `NotFound` when the defect was first observed in the
`2026-07-10` live run.)

The fallback cannot overstate the case: `handToReconciler` is the only writer of an evidence row, and it fires on
two of the three transitions into `UsdcConfirmed` (the third — `revertAlreadyProcessed` — deliberately writes none;
see §4). The only exit from `UsdcConfirmed` is `Reconciled`. So a row's existence pins the order to one of two
states, and both mean `completed` to a customer.

- **Still open.** An order **in flight** has no row and answers `404`. So does an order that failed cleanly:
  failure leaves no durable record. Both need the durable order rows from §1.

## 3. Solvency assumes exactly one backend process

The pool's reservation gate is an in-process lock (`Mutex`), so `reserve()`'s check and commit are serialized on a
single event loop. **Two backend processes against the same pool would hold two independent locks and could both
reserve the same last coin.**

- **Why it has never bitten.** The PoC runs one process. The contract's own `balance >= amount` guard is the
  second, independent shield: an over-committed backend still cannot make the chain overdraw the pool.
- **What closes it.** A shared lock — the database row lock that arrives with §1, or a lease/advisory lock.
- **Watch this before any public deployment.** A platform that runs two instances, or overlaps a new instance with
  the old one during a redeploy, silently removes the backend half of invariant ③a.

## 4. Two evidence gaps, named rather than papered over

- The `revertAlreadyProcessed → UsdcConfirmed` path writes **no evidence row** — deliberately, because the reverted
  transaction hash must never become a witness. Such an order is therefore absent from the durable work-list.
- The webhook's idempotency key is burned **before** `advance()`. If `advance()` then fails while the process
  survives, the webhook's drive is dropped and the poll worker re-drives the order on its next tick — the
  redundancy is what makes it safe, not the ordering. Be precise about the limit of that argument: after a genuine
  **crash** the poll worker has nothing to re-drive, because its work-list is the in-memory registry the crash
  erased. That is not a second defect; it is the §1 exposure seen from another angle, and it has the same fix.

## 5. Late sequence allocation, two-store crash window

The operator sequence is allocated late — on `chargeOk`, the first step of the USDC leg — so an abandoned checkout
consumes no sequence and the operator account stays gap-free. `allocate()` persists the sequence snapshot one
effect before the `OrderRow` is persisted with it.

A crash in that window is **money-safe** (the `Processed(tx_id)` guard, derived from the order id, and the
single-use sequence each cap delivery at one per order) and, for a completed charge, **self-heals**: recovery
re-retrieves the same sale, `chargeOk` fires again, the idempotent `allocate()` returns the same sequence, and the
payout submits. The only residual is a _theoretical_ liveness stranding of that sequence, and it is **not reachable
in the PoC** — the in-memory sequence store is wiped by the very crash, so the allocator re-bootstraps from the
live on-chain sequence on restart. A durable sequence store closes it by reconciling the order's sequence from
`activeSeqFor(orderId)` during recovery.

## 6. Paths proven by tests, not yet by the chain

- **`ROGUE PAYOUT` has never fired against a real unauthorized outflow.** The live runs proved only the negative —
  that an authorized payout is not accused, including after a restart erased the in-memory order registry. Staging
  a genuine unauthorized transfer on testnet would prove the positive.
- **`CHAIN_DIVERGENCE`** (a different transaction settled this order) and both blind-spot states
  (`never-watched`, `aged-out`) are exercised by unit tests only.
- **The revert-code read path** is exercised only by fakes. A _successful_ live `pay()` is proven; a
  landed-and-**reverted** `pay()`'s diagnostic events are the one shape only a live failing transaction confirms.
  `scripts/probe-revert.mjs` is the check for it once such a transaction exists on testnet.

## 7. No log rotation

Boot refuses to open a log at or above 2 GiB (`2**31` bytes, where `readFileSync` hard-fails) with an explanatory
error rather than truncating it. At the payout tail's
cadence the cursor log — the fastest-growing of the seven — takes years to approach that. Rotation is a later
operational concern, not a correctness one.

## 8. Concurrency is unit-proven, not load-proven

The SPIKE-3 solvency race (many simultaneous checkouts competing for the last coin) is proven offline, including
the mutation check that removing the lock makes the same workload over-commit. It has never been run against the
live rails.

Note the shape of that gap before spending on it: `reserve()` performs its check and commit inside one lock
acquisition, and the offline test injects a yield at the single `await` inside that critical section — the widest
interleaving the runtime permits. **No network call runs inside the pool mutex**: the destination snapshot and the
quote are fetched before `reserve()`, and the hosted checkout form is opened after it. A live burst would therefore
exercise a narrower window than the test already does. What remains genuinely untested is throughput, not
correctness — and the multi-process hazard in §3, which no single-process load test can find.
