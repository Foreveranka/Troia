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
provider implementations plus a time-budget re-validation (ADR-9), not a rewrite. It is **not** turnkey, though:
the two `[mainnet-blocker]` gaps in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — a durable order store, and a write-ahead
journal on the refill mint — must close before real money moves.

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
  **PSP cost pass-through** grossed up `(net+fixed)÷(1−rate)` so the net still covers mid+FX+margin after the
  provider's cut. A client-supplied price _or currency_ is ignored; the same frozen price is what the form charges.
- **Deterministic FX oracle** — median / distinct-source quorum / symmetric staleness band / fail-closed on
  disagreement, all on injected quotes (no AI, no live network in the tested path).
- **Reconciler + `just verify`** — the self-verifying evidence artifact, offline and network-blocked. See
  [`RECONCILIATION.md`](RECONCILIATION.md). This is the reviewer centerpiece and it works today.
- **Crash durability with a stated contract** — an append-only log whose first write failure poisons it forever,
  so a partial write can only live in the physical tail; a torn tail is truncated and reported, and a damaged
  record that was fully written is **fatal**, never silently dropped. Every writer appends before it believes.
  Tested by injected crashes and by mutation (delete a guard, watch the test fail). ARCHITECTURE §3b, and now
  exercised against the live chain including a kill-and-restart — see [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **Chain-authoritative detection** — a payout tail that reads the USDC SAC's `transfer` events and calls any
  outflow whose hash is missing from the durable write-ahead journal a **rogue payout** (it could not have landed
  otherwise), plus a live reconciler that finds each order's settlement through the contract-indexed `tx_id` and
  refuses to mark it `Reconciled` unless the pool's code was never replaced, the announced amount equals what the
  token contract moved, and the tx is still live. It distinguishes **"we cannot see"** from **"it is not there"**:
  a payout that predates the tail's durable coverage floor, or whose transaction the RPC no longer returns, is
  reported as a blind spot rather than accused, and every alarm pages once per problem rather than every tick.
  RECONCILIATION.md §8. Both loops have now run against the live chain and reconciled a real payout, finding it by
  the contract's own index rather than by the hash we recorded — see [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **Soroban `TroyPool` contract** — `pay` with atomic check-and-transfer (no TOCTOU), replay guard, pause,
  role-gated admin/upgrade; unit + integration + fuzz (conservation) tests green.
- **Chrome MV3 "Pay with Troy card" extension** — the demo's actual money-path entry point, proven live e2e
  (see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)) and hardened: per-request fetch timeouts (15s intent / 8s poll), a phase-aware poll budget with
  honest give-up (never falsely claims "not charged"), tab-open-failure handling, a double-submit guard, memo
  parity pinned to core's golden vectors (malformed order ids fail closed), and an amount gate aligned with
  `toStroops` — 132 tests across 10 spec files. Holds no keys, signs nothing.

The full gate — TypeScript suite, Rust contract tests, lint, type-check, and the offline `just verify` — is the
acceptance bar for every change.

---

## 3. Testnet boundaries (deliberate, documented)

- **Self-minted USDC.** The pool is funded with our own testnet USDC (own issuer + SAC, unlimited mint). This
  means the **solvency _mechanism_** (reservation + contract guard) is fully exercised, but **economic solvency**
  — real inventory adequacy, i.e. actually having bought the USDC — is deferred. `SimulatedRebalance` (testnet
  mint) is a built + tested `packages/rebalance`; only the real-CEX buy that actually acquires the USDC (economic
  solvency) is Phase-2. The token is valueless; the ledger, solvency mechanism, and reconciliation logic are real.
  **This is the next funded milestone, not a hole**: the decision seam (`RebalancePolicy`) and the execution seam
  (`RebalanceProvider`) already exist and are exercised on every settlement — Phase-2 replaces one implementation
  behind them with a real exchange buy + withdrawal. The mechanism is proven; what money buys is the inventory.
- **`signed ≠ settled`** (see [`RECONCILIATION.md`](RECONCILIATION.md)) — a wiped testnet or a never-landed tx
  surfaces as `UNSETTLED`, never a false match.
- **The one residual _irreversible_ loss window is named, not hidden.** In the narrow case _USDC sent → the
  reversible TRY leg cannot be unwound_, the order lands in `LossReview` (customer-facing `review`) — surfaced with
  an evidence flag, never silently absorbed. When that loss occurs it is **ours**, never the customer's. On testnet
  no real value is at stake; the path is demonstrated as a maturity signal.
  There is a second, different failure — the charged-but-stranded order in §4 below. It is not an irreversible
  loss: the customer's charge can still be voided or refunded through iyzico. But after a crash nothing in this
  system remembers it, so the recovery is manual and only happens if the customer complains. Do not read "one loss
  window" as "one way to disappoint a customer."
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
  construction (the PSP cut is grossed up, the FX-risk buffer is sized to the real valör). The resulting all-in
  markup is **rail-dependent** — at current (calm) volatility ~7.8% on iyzico credit (4.29%), ~3.7% on a bank
  virtual-POS debit rail (1.04%) — and the FX-risk line is **data-driven**, so it rises when the market tenses.
  Three levers close it and all three are ordinary commercial work rather than research: the cheaper debit rail,
  a negotiated processor rate, and a shorter settlement valör (the FX-risk buffer shrinks with `√n`). We surface
  the number because a markup hidden inside an exchange rate is exactly what this project exists to end.

---

## 4. Live-run done; the residual limitations are operational (not hidden)

Phase 4.4 deployed the live testnet rails (three keypairs, USDC SAC, a seeded `TroyPool`) and proved a real
on-chain `pay()` money path — pool `100,000 → 99,999`, replay guard, double-pay revert (see
[`DEPLOYMENTS.md`](DEPLOYMENTS.md)). The Phase-4.5 **composition** that joins the two legs into one running system
is now **built, type-checked, and offline-tested**: a factory (`buildTestnetServerDeps`) assembles the real iyzico
provider + the `stellar-client` adapters + the PSP-inclusive quote into the backend's `ServerDeps`, a server
bootstrap (`just serve`) stands the app up, and a composition smoke proves the whole stack boots from that factory
and its fail-closed routes work. The Phase-4.5/5.2 **live run has now executed**: a real Troy sandbox card charge
automatically drove a real on-chain `pay()` end-to-end (74 USDC pool → merchant; see
[`DEPLOYMENTS.md`](DEPLOYMENTS.md)) — so the network-facing halves are now live-smoked, not just type-checked.
The remaining honest limitations are operational, not "unrun":

- **Two live runs, both single manual smokes — not a load/soak test.** The second run additionally exercised the durable logs, the payout tail, the live
  reconciler, and a kill-and-restart against the same data directory: no double mint, no re-advance, no false theft
  accusation, and the books matched the chain to the stroop. Both runs were hardened (per-attempt timeouts +
  bounded retry, so a hung source drops fail-closed rather than wedging the poller) and gated by a readiness
  preflight (`just preflight`). Concurrent-load behaviour against the live rails has not been exercised. See
  [`DEPLOYMENTS.md`](DEPLOYMENTS.md).
- **Solvency assumes exactly one backend process.** The pool's reservation gate is an in-process lock, so two
  backend instances against the same pool could each reserve the last coin. The contract's own `balance >= amount`
  guard is the second, independent shield — the chain still cannot overdraw — but the backend half of invariant ③a
  is removed. This matters the day the demo is deployed to a platform that runs two instances or overlaps them
  during a redeploy. See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) §3.
- **A crash between the charge and the payout strands the order.** The order rows are in memory. If the process
  dies after the customer has paid on the hosted form but before the USDC leg starts, nothing durable records the
  charge — the write-ahead journal is written at submit time, the evidence log after confirmation — so on restart
  the order is not re-driven, not voided, and the merchant is never paid. No double payout is possible in that
  window; but the customer is charged and unsettled with no automatic unwind. Valueless on testnet, real on
  mainnet. Durable order rows close it; see [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) §1. Together with the
  single-process lock above, this is why "durable store" is a mainnet prerequisite rather than a nicety.
- **The engineering gaps are enumerated separately.** Restart semantics, the two evidence gaps, late sequence
  allocation, log rotation, the unauthenticated `/intent`, and the refill mint's crash window are each stated in
  full — with why they are money-safe and what closes them — in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md). They are
  listed there rather than here because none of them changes whether this project is worth building, and putting
  them beside the risks that do would misstate their weight. Nothing has been dropped in the move.

- **What testnet has, and has not, proven live.** The end-to-end money path is demonstrated on chain, twice; so are
  the two sharpest detectors — the revert-code read and `ROGUE PAYOUT` (an unauthorized outflow flagged by the live
  payout tail), both fired on `2026-07-14` (see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)). What is **built and unit-tested
  but not yet fired on chain** — a testing-maturity gap, not a defect, since the code is there and green — is: the
  `CHAIN_DIVERGENCE` verdict (a different transaction settled this order) and the payout tail's two blind spots
  (`never-watched`, `aged-out`), exercised by unit tests only; a **positive** contract `upgrade()` (only the
  auth gate is tested — a real second wasm to upgrade to is Phase-2 work, and it must never be rehearsed on the live
  pool, where a bad wasm would brick it); and **load/soak** (the solvency race is proven offline, including the
  mutation check that removing the lock over-commits, but never against the live rails — what is untested there is
  throughput, not correctness). None of these blocks the proof story; each would turn a tested sentence into a
  chain fact, and all are Phase-2.

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
  cycle + timing (rebalance runs on iyzico's valör cadence, not pool drainage) in **ARCHITECTURE §6a**.
- **KYC** — the mainnet plan, not a testnet seam. There is no package, no port and no no-op implementation in the
  code today: unlike the three items below, this boundary does not exist yet, and the hosted form carries a fixed
  buyer record (the "KYC-stub" in the composition root). It arrives with the regulated mainnet phase (ADR-10),
  which is where it belongs.
- **HSM / multisig real thresholds** (the `Signer` boundary already exists in `stellar-client`; testnet
  threshold = 1, same flow shape).
- **Channel accounts for concurrency** (the single-writer sequence allocator is today's seam; a channel pool is
  Phase-2 with the allocator interface unchanged).
- **StellarPay / Beans extension adapters** (bonus rail; the demo storefront does not depend on them).
- **Extension origin scope.** The browser extension is deliberately scoped to **localhost / 127.0.0.1 on any
  port** (port-less `matches`/`host_permissions`), not `<all_urls>` and not a specific storefront origin. This
  keeps the reviewer's Chrome permission prompt honest and the attack surface small. A production build widens the
  allowlist to any storefront emitting a USDC SEP-7 — the DOM-scan mechanism is unchanged; only the manifest match
  patterns change. But widening it to a storefront we do not control first requires **SEP-7 request signing**,
  which is not built — see the next item.
- **SEP-7 request signing (`origin_domain` + `signature`) — the prerequisite for "works on any store".** Today the
  adapter validates the payee's _shape_ (valid strkey, allowlisted USDC issuer) but never its _authorship_, so a DOM
  injection on an allowlisted storefront origin could name any destination and all six checks would still pass. Not
  exploitable now: the only allowlisted origins are the local demo storefront, and an attacker who can inject there
  already owns the machine. It becomes real the moment a third-party origin joins the allowlist — which is exactly
  what "works on any store" means. The fix keeps the no-registry design (Troia never records a merchant): verify the
  request's `signature` against the `URI_REQUEST_SIGNING_KEY` published at
  `https://<origin_domain>/.well-known/stellar.toml`, **and** require `origin_domain` to equal the origin of the page
  the request was found on — `sender.origin` in the background worker is the unforgeable source. Both halves are
  needed: a valid signature only proves the request came from the domain it _claims_, so signature alone would let an
  injected request name an attacker's domain and sign under it. It is a prerequisite for the demo storefront too,
  which would have to sign server-side: a browser bundle cannot hold the shop's signing key.
- **Mainnet.** Mainnet is a **separate, regulated phase**. Turkish regulatory engagement (MASAK) is a deliberate
  post-code step, handled with counsel — it is future work, never an excuse for a gap in what is claimed here.
  **No regulator has been contacted yet.** The sequencing is intentional and, we think, the cheap order: prove the
  settlement and proof layer where a mistake costs nothing, then buy the licence that lets it hold real money.
  Reversing that order means paying for compliance on a system nobody has yet shown to be correct.

---

## 6. Where each kind of gap lives

Two documents, because two audiences ask different questions.

| Question                                                                 | Document                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Is this worth funding? What could make it fail as a business?            | **This file** — §3 testnet boundaries, §4 operational limits, §5 out of scope.                                                |
| I am going to read or run this code. What is unfinished, and is it safe? | [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — restart semantics, the single-process lock, evidence gaps, paths proven only by tests. |

The split is a claim about **proportion**, not a place to hide. Every item moved out of this file is stated in the
other one in full, with why it is money-safe and what closes it. If you would rather read one list, read both.

## 7. How to hold us to this

Everything in §2 is checkable from a clone: run the gate and run `just verify` (offline). Anything in §3–§5 is
stated as a limitation precisely so it cannot be mistaken for a claim. If a future document or demo asserts
something in §3, §4 or §5 is done, treat this file as the contradicting authority until it is updated with
evidence — and the same holds for [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) over the code it describes.
