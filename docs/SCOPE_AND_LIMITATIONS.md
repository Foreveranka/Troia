# Troia — Scope & Limitations

> Honesty is a maturity signal. This document states plainly what Troia proves today, what it does **not**, and
> what is deliberately deferred. A hidden risk is a disqualifying risk; everything below is on the table.

Troia is a **custodial TRY→USDC settlement bridge on Stellar**, delivered as a **testnet proof-of-concept**. A
Turkish user pays TRY with a Troy card via iyzico; the operator settles the merchant in USDC from a pre-funded
Stellar pool; the FX spread is the revenue. Positioning: _a settlement layer that makes every lira accountable
hash-by-hash — it never silently loses money, and the one irreversible loss bucket is surfaced, never hidden._

---

## 1. The frame: proof-first, phased maturity

We build **inside-out**: the money-safety core and the reviewer-verifiable reconciler first (on fixtures), then
the real rails, then the storefront. This is a sequencing choice, not a hedge — the reconciliation/proof layer
is hardened _before_ real money moves, so the guarantees are demonstrable rather than asserted.

Testnet is where those guarantees are exercised end-to-end with **zero real-money risk** (the USDC is
self-minted; see §3). The mathematics, the double-pay shields, the solvency mechanism, the price-lock, and the
reconciler are **identical** to what a mainnet deployment would run — mainnet is a config swap plus three
provider implementations plus a time-budget re-validation (ADR-9), not a rewrite.

---

## 2. What is proven today (offline, no network, no secrets)

- **Money-safety state machine** — a pure, total reducer; every transition is table-listed and tested;
  terminal states are idempotent under at-least-once redelivery. The irreversible USDC leg is ordered **last**
  (money-first: charge the reversible TRY leg before the irreversible USDC payout), so a failure unwinds via a
  same-day void rather than stranding funds.
- **Double-pay shield (USDC)** — order-pinned sequence (single-writer) means a second submission is rejected at
  protocol level (`txBAD_SEQ`); the contract's `Processed(tx_id)` guard is the second, different-field shield.
- **Solvency mechanism** — backend reservation **and** the contract's `balance >= amount` guard both gate a
  payout; a `/intent` that cannot reserve gets a hard `409` before any charge is possible.
- **Zero-trust pricing** — the ₺ price is computed **server-side** as four legible lines: the FX oracle **mid**,
  the **FX-risk commission** (μ·n + z·σ·√n + margin, with n = the real iyzico settlement valör ~21 days), and a
  **PSP cost pass-through** grossed up `÷(1−rate)+fixed` so the net still covers mid+FX+margin after the
  provider's cut. A client-supplied price _or currency_ is ignored; the same frozen price is what the form charges.
- **Deterministic FX oracle** — median / distinct-source quorum / symmetric staleness band / fail-closed on
  disagreement, all on injected quotes (no AI, no live network in the tested path).
- **Reconciler + `just verify`** — the self-verifying evidence artifact, offline and network-blocked. See
  [`RECONCILIATION.md`](RECONCILIATION.md). This is the reviewer centerpiece and it works today.
- **Crash durability with a stated contract** — an append-only log whose first write failure poisons it forever,
  so a partial write can only live in the physical tail; a torn tail is truncated and reported, and a damaged
  record that was fully written is **fatal**, never silently dropped. Every writer appends before it believes.
  Tested by injected crashes and by mutation (delete a guard, watch the test fail). ARCHITECTURE §7b, and now
  exercised against the live chain including a kill-and-restart — see [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **Chain-authoritative detection** — a payout tail that reads the USDC SAC's `transfer` events and calls any
  outflow whose hash is missing from the durable write-ahead journal a **rogue payout** (it could not have landed
  otherwise), plus a live reconciler that finds each order's settlement through the contract-indexed `tx_id` and
  refuses to mark it `Reconciled` unless the pool's code was never replaced, the announced amount equals what the
  token contract moved, and the tx is still live. It distinguishes **"we cannot see"** from **"it is not there"**:
  a payout that predates the tail's durable coverage floor, or whose transaction the RPC no longer returns, is
  reported as a blind spot rather than accused, and every alarm pages once per problem rather than every tick.
  ARCHITECTURE §8a. Both loops have now run against the live chain and reconciled a real payout (tx `d47f7fb9…`),
  finding it by the contract's own index rather than by the hash we recorded — see [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **Soroban `TroyPool` contract** — `pay` with atomic check-and-transfer (no TOCTOU), replay guard, pause,
  role-gated admin/upgrade; unit + integration + fuzz (conservation) tests green.
- **Chrome MV3 "Pay with Troy card" extension** — the demo's actual money-path entry point, proven live e2e
  (tx `cd643d71…`) and hardened: per-request fetch timeouts (15s intent / 8s poll), a phase-aware poll budget with
  honest give-up (never falsely claims "not charged"), tab-open-failure handling, a double-submit guard, memo
  parity pinned to core's golden vectors (malformed order ids fail closed), and an amount gate aligned with
  `toStroops` — ~105 tests across 10 spec files. Holds no keys, signs nothing.

The full gate — TypeScript suite, Rust contract tests, lint, type-check, and the offline `just verify` — is the
acceptance bar for every change.

---

## 3. Testnet boundaries (deliberate, documented)

- **Self-minted USDC.** The pool is funded with our own testnet USDC (own issuer + SAC, unlimited mint). This
  means the **solvency _mechanism_** (reservation + contract guard) is fully exercised, but **economic solvency**
  — real inventory adequacy, i.e. actually having bought the USDC — is deferred. `SimulatedRebalance` (testnet
  mint) is a built + tested `packages/rebalance`; only the real-CEX buy that actually acquires the USDC (economic
  solvency) is Phase-2. The token is valueless; the ledger, solvency mechanism, and reconciliation logic are real.
- **`signed ≠ settled`.** We prove what we signed (cryptographically, reset-proof) and what settled (only while
  the chain remembers it). A wiped testnet or a never-landed tx surfaces as `UNSETTLED`, never as a false match.
- **The one residual loss window is named, not hidden.** In the narrow case _USDC sent → the reversible TRY leg
  cannot be unwound_, the order lands in `LossReview` (customer-facing `review`) — surfaced with an evidence
  flag, never silently absorbed. On testnet no real value is at stake; the path is demonstrated as a maturity
  signal.
- **iyzico is the sandbox.** The fiat leg runs against iyzico's sandbox with Troy test cards; a real direct-sale
  charge is proven (`paymentId 36418597`). The real settlement **valör** (iyzico blocking, 2–21 days, _not_ the
  marketed T+1) **cannot be measured in the sandbox**, so the FX-risk window uses the researched conservative 21
  days. The `classifyIyzicoResult` success shape and closed terminal-decline `errorCode` set **are** calibrated
  against the sandbox — a real charge plus iyzico's published taxonomy and its declining test cards.
- **Demo valör is compressed.** The real settlement valör (~21 days, above) is **compressed** for the demo to
  `DEMO_VALOR_SECS` (default **30s**, min 1) so the automatic TRY-driven rebalance bot refills the pool within the
  demo window. This is purely demo time-compression of the _settlement clock_; it is **separate** from the FX-risk
  pricing knob (`valorDays` = 21) that sizes the commission, which still uses the real ~21-day figure.
- **Unit economics are disclosed, not assumed.** The pricing model is complete and never loses money by
  construction (the PSP cut is grossed up, the FX-risk buffer is sized to the real valör). But the resulting
  all-in markup is **rail-dependent** — at current (calm) volatility ~7.8% on iyzico credit (4.29%), ~3.7% on a
  bank virtual-POS debit rail (1.04%) — and the FX-risk line is **data-driven**, so it rises when the market
  tenses. The economics close on the cheaper rails / a negotiated rate / a shorter valör — a go-to-market lever,
  surfaced here rather than hidden inside the FX.

---

## 4. Live-run done; the residual limitations are operational (not hidden)

Phase 4.4 deployed the live testnet rails (three keypairs, USDC SAC, a seeded `TroyPool`) and proved a real
on-chain `pay()` money path — pool `100,000 → 99,999`, replay guard, double-pay revert (see
[`DEPLOYMENTS.md`](DEPLOYMENTS.md)). The Phase-4.5 **composition** that joins the two legs into one running system
is now **built, type-checked, and offline-tested**: a factory (`buildTestnetServerDeps`) assembles the real iyzico
provider + the `stellar-client` adapters + the PSP-inclusive quote into the backend's `ServerDeps`, a server
bootstrap (`just serve`) stands the app up, and a composition smoke proves the whole stack boots from that factory
and its fail-closed routes work. The Phase-4.5/5.2 **live run has now executed**: a real Troy sandbox card charge
automatically drove a real on-chain `pay()` end-to-end (74 USDC pool → merchant, tx
[`cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded);
see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)) — so the network-facing halves are now live-smoked, not just type-checked.
The remaining honest limitations are operational, not "unrun":

- **Two live runs, both single manual smokes — not a load/soak test.** The second (`2026-07-10`, order
  `ST-7SRI0YDF`, 80 USDC, tx `d47f7fb9…`) additionally exercised the durable logs, the payout tail, the live
  reconciler, and a kill-and-restart against the same data directory: no double mint, no re-advance, no false theft
  accusation, no alarm, and the books matched the chain to the stroop. What it did **not** exercise: a genuinely
  unauthorized outflow (so `ROGUE PAYOUT` has never fired against a real one), `CHAIN_DIVERGENCE`, or either
  blind-spot state — those remain proven by tests, not by the chain. See [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **The first live run is a single manual smoke, not a load/soak test.** It proved the money-first path over the real
  SDK/RPC/iyzico network once, hardened (per-attempt timeouts + bounded retry so a hung source drops fail-closed
  rather than wedging the poller or freezing a checkout) and gated by a **readiness preflight** (`just preflight`).
  Concurrent-load behavior (the SPIKE-3 solvency race under many simultaneous webhooks) is unit-proven offline but
  not yet exercised against live rails.
- **The revert-code read path is exercised only by fakes.** A _successful_ live `pay()` is proven (above), but a
  landed-and-**reverted** `pay()`'s diagnostic events (the input to the revert-code read) are the one shape only a
  live failing tx confirms — `scripts/probe-revert.mjs` is the check for it once such a tx exists on testnet.
- **Durability is a file log, not a database — and it does not cover everything.** Seven append-only logs under
  `TROIA_DATA_DIR/<troyPool-id>/` now survive a crash: the double-entry journal, the evidence rows (which carry
  each order's frozen facts and act as the settlement work-list), the write-ahead list of authorized `pay()`
  hashes, the chain observations, the reconciled marks, and the payout tail's cursor + suspects. They have an
  explicit crash contract (ARCHITECTURE §7b) and a durable-log failure exits the process rather than degrading
  quietly. What is **still volatile**, deliberately: the `OrderRow`s themselves, the reservation ledger, the
  pending-settlement store, and the operator sequence snapshot. So **an order that was submitted but had not yet
  landed is forgotten by a restart.** That fails **safe** — the on-chain `Processed(tx_id)` guard and the
  single-use sequence both cap USDC delivery at one per order, and the durable evidence row means the settlement
  is still armed — never toward a double payout. A real database (one transaction, all the rows) is the mainnet
  swap, behind the same `Store` / `DurableLog` interfaces. There is also **no log rotation**: boot refuses above
  2 GiB with an explanatory error rather than truncating.
- **A restart still forgets an order that has not settled yet.** `GET /status/<orderId>` and `GET /receipt/<orderId>`
  now fall back to the durable evidence log, so a **settled** order keeps answering `completed` — with its real tx
  hash — across a restart (this was `NotFound` when first observed in the `2026-07-10` run). The fallback cannot
  overstate the case: `handToReconciler` is the only writer of an evidence row and fires on exactly the two
  transitions into `UsdcConfirmed`, whose only exit is `Reconciled`; both are `completed`. An order **still in
  flight** has no row and still answers `404` — honestly, because with the order rows gone we genuinely no longer
  know. So does an order that failed cleanly: failure leaves no durable record. Both would need durable order rows
  behind the same `Store` interface, which would also let the recovery worker resume in-flight orders after a
  restart — a change to the money path's crash semantics, and therefore deliberately not made here.
- **Two known evidence gaps, named rather than papered over.** The `revertAlreadyProcessed → UsdcConfirmed` path
  writes no evidence row (the reverted hash must not become a witness), so such an order is not picked up by the
  durable work-list; and the webhook's idempotency key is burned before `advance()`, so a crash in that window
  drops the webhook's drive (the poll worker re-drives it on the next tick).
- **Late sequence allocation, two-store crash window (durable-store only).** The operator sequence is allocated
  late — on `chargeOk`, the first step of the USDC leg — so an abandoned checkout consumes no sequence (a
  gap-free operator account). `allocate()` persists the sequence snapshot one effect before the `OrderRow` is
  persisted with that seq. A crash in that window is **money-safe** (the `Processed(tx_id)` guard, derived from order_id, + the
  single-use sequence shield both cap USDC delivery at one per order) and, for a completed charge, **self-heals**
  (recovery re-retrieves the same sale → `chargeOk` again → idempotent `allocate` returns the same seq →
  submit). The only residual is a _theoretical_ liveness stranding of that seq, and it is **not reachable in the
  PoC**: the in-memory sequence store is wiped by the very crash, so on restart the allocator re-bootstraps from
  the live on-chain sequence. A durable sequence store (Phase 2) closes it by reconciling the order's seq from
  `activeSeqFor(orderId)` on recovery.

None of these are blockers for the proof story above; the live end-to-end run is demonstrated, and what remains is
hardening (load/soak, the reverted-tx read path) — not "unrun."

---

## 5. Explicitly out of scope for this PoC (Phase-2, boundary only)

- **Real CEX rebalance (inventory acquisition only).** The automatic top-up trigger **is built and running**: a
  background settlement worker (`settleTick`) arms every money-good order and, after the settlement valör
  (demo-compressed to ~30s, see §3), refills the pool from that order's collected TRY at the live oracle rate by
  minting real issuer-signed USDC (`SimulatedRebalance` → `createSacMintClient`). The **only** deferred piece is
  the real-exchange buy+withdraw that _economically acquires_ the USDC (e.g. Binance/Bybit/OKX, the venues the
  oracle reads; async finality — invariant ③b). The system is seamed for a future **agent + on/off-ramp service**
  (the agent owns the _decision_, the on/off-ramp owns the real fiat↔USDC _execution_); on mainnet that seam
  replaces the testnet SAC mint with no change to the backend or the money-first core. The `poolLowWatermarkStroops`
  low-water mark only **warns** (`/intent → poolLow:true`) — it is **not** the trigger. See the treasury cash-flow
  cycle + timing (rebalance runs on iyzico's valör cadence, not pool drainage) in **ARCHITECTURE §5a**.
- **KYC** (a designed boundary, no-op on testnet; not yet a package).
- **HSM / multisig real thresholds** (the `Signer` boundary already exists in `stellar-client`; testnet
  threshold = 1, same flow shape).
- **Channel accounts for concurrency** (the single-writer sequence allocator is today's seam; a channel pool is
  Phase-2 with the allocator interface unchanged).
- **StellarPay / Beans extension adapters** (bonus rail; the demo storefront does not depend on them).
- **Extension origin scope.** The browser extension is deliberately scoped to **localhost / 127.0.0.1 on any
  port** (port-less `matches`/`host_permissions`), not `<all_urls>` and not a specific storefront origin. This
  keeps the reviewer's Chrome permission prompt honest and the attack surface small. A production build widens the
  allowlist to any storefront emitting a USDC SEP-7 — the DOM-scan mechanism is unchanged; only the manifest match
  patterns change.
- **Mainnet.** Mainnet is a **separate, regulated phase**. Turkish regulatory engagement (MASAK) is a deliberate
  post-code step, handled with counsel — it is future work, never an excuse for a gap in what is claimed here.

---

## 6. How to hold us to this

Everything in §2 is checkable from a clone: run the gate and run `just verify` (offline). Anything in §3–§5 is
stated as a limitation precisely so it cannot be mistaken for a claim. If a future document or demo asserts
something in §4 or §5 is done, treat this file as the contradicting authority until it is updated with evidence.
