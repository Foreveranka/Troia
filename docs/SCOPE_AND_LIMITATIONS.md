# Troia — Scope & Limitations

> Honesty is a maturity signal. This document states plainly what Troia proves today, what it does **not**, and
> what is deliberately deferred. A hidden risk is a disqualifying risk; everything below is on the table.

Troia is a **custodial TRY→USDC settlement bridge on Stellar**, delivered as a **testnet proof-of-concept**. A
Turkish user pays TRY with a Troy card via iyzico; the operator settles the merchant in USDC from a pre-funded
Stellar pool; the FX spread is the revenue. Positioning: *a settlement layer that makes every lira accountable
hash-by-hash — it never silently loses money, and the one irreversible loss bucket is surfaced, never hidden.*

---

## 1. The frame: proof-first, phased maturity

We build **inside-out**: the money-safety core and the reviewer-verifiable reconciler first (on fixtures), then
the real rails, then the storefront. This is a sequencing choice, not a hedge — the reconciliation/proof layer
is hardened *before* real money moves, so the guarantees are demonstrable rather than asserted.

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
- **Zero-trust pricing** — the ₺ price is computed **server-side** from the FX oracle mid × commission; a
  client-supplied price *or currency* is ignored, and the same frozen price is what the hosted form charges.
- **Deterministic FX oracle** — median / distinct-source quorum / symmetric staleness band / fail-closed on
  disagreement, all on injected quotes (no AI, no live network in the tested path).
- **Reconciler + `just verify`** — the self-verifying evidence artifact, offline and network-blocked. See
  [`RECONCILIATION.md`](RECONCILIATION.md). This is the reviewer centerpiece and it works today.
- **Soroban `TroyPool` contract** — `pay` with atomic check-and-transfer (no TOCTOU), replay guard, pause,
  role-gated admin/upgrade; unit + integration + fuzz (conservation) tests green.

The full gate — TypeScript suite, Rust contract tests, lint, type-check, and the offline `just verify` — is the
acceptance bar for every change.

---

## 3. Testnet boundaries (deliberate, documented)

- **Self-minted USDC.** The pool is funded with our own testnet USDC (own issuer + SAC, unlimited mint). This
  means the **solvency *mechanism*** (reservation + contract guard) is fully exercised, but **economic solvency**
  — real inventory adequacy, i.e. actually having bought the USDC — is deferred. The rebalance provider
  (`SimulatedRebalance` on testnet, a real-CEX buy on mainnet) is a designed Phase-4.4 / Phase-2 seam, not yet a
  built package. The token is valueless; the ledger, solvency mechanism, and reconciliation logic are real.
- **`signed ≠ settled`.** We prove what we signed (cryptographically, reset-proof) and what settled (only while
  the chain remembers it). A wiped testnet or a never-landed tx surfaces as `UNSETTLED`, never as a false match.
- **The one residual loss window is named, not hidden.** In the narrow case *USDC sent → the reversible TRY leg
  cannot be unwound*, the order lands in `LossReview` (customer-facing `review`) — surfaced with an evidence
  flag, never silently absorbed. On testnet no real value is at stake; the path is demonstrated as a maturity
  signal.
- **iyzico is the sandbox.** The fiat leg runs against iyzico's sandbox with Troy test cards. Real preauth
  validity windows and issuer capture behavior **cannot be measured in the sandbox**; `PolicyConfig` timing
  values are set conservatively and marked for measurement (Phase 4.5).

---

## 4. Not yet wired (Phase 4.4 / 4.5 — deferred, not hidden)

These are implemented behind interfaces and injected seams, but the live composition is not yet stood up:

- **Live Stellar rails** — friendbot XLM funding, USDC SAC deploy, and mint-to-pool (`just fund`) are stubbed;
  the storefront `just demo` end-to-end run against real testnet depends on them.
- **Production `QuoteFn` wiring** — the live CEX oracle → pricing path is unit-tested end-to-end, but is not yet
  wired into the backend composition root from environment config (the `deps.quote` seam is injected in tests).
- **`PolicyConfig` calibration** — `timebounds`, `preauth_validity`, `max_retry`, `reservation_ttl`, and the
  `classifyIyzicoResult` input→class table are to be measured and locked in the iyzico sandbox.

None of these are blockers for the proof story above; they are the remaining path to a live end-to-end run.

---

## 5. Explicitly out of scope for this PoC (Phase-2, boundary only)

- **Real CEX rebalance** — buying USDC on a real exchange (e.g. Binance/Bybit/OKX, the same venues the oracle
  reads); async `topUp` signature designed at the interface level, not yet built.
- **KYC** (a designed boundary, no-op on testnet; not yet a package).
- **HSM / multisig real thresholds** (the `Signer` boundary already exists in `stellar-client`; testnet
  threshold = 1, same flow shape).
- **Channel accounts for concurrency** (the single-writer sequence allocator is today's seam; a channel pool is
  Phase-2 with the allocator interface unchanged).
- **StellarPay / Beans extension adapters** (bonus rail; the demo storefront does not depend on them).
- **Mainnet.** Mainnet is a **separate, regulated phase**. Turkish regulatory engagement (MASAK) is a deliberate
  post-code step, handled with counsel — it is future work, never an excuse for a gap in what is claimed here.

---

## 6. How to hold us to this

Everything in §2 is checkable from a clone: run the gate and run `just verify` (offline). Anything in §3–§5 is
stated as a limitation precisely so it cannot be mistaken for a claim. If a future document or demo asserts
something in §4 or §5 is done, treat this file as the contradicting authority until it is updated with evidence.
