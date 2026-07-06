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
- **Zero-trust pricing** — the ₺ price is computed **server-side** as four legible lines: the FX oracle **mid**,
  the **FX-risk commission** (μ·n + z·σ·√n + margin, with n = the real iyzico settlement valör ~21 days), and a
  **PSP cost pass-through** grossed up `÷(1−rate)+fixed` so the net still covers mid+FX+margin after the
  provider's cut. A client-supplied price *or currency* is ignored; the same frozen price is what the form charges.
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
- **iyzico is the sandbox.** The fiat leg runs against iyzico's sandbox with Troy test cards; a real direct-sale
  charge is proven (`paymentId 36418597`). The real settlement **valör** (iyzico blocking, 2–21 days, *not* the
  marketed T+1) **cannot be measured in the sandbox**, so the FX-risk window uses the researched conservative 21
  days. The `classifyIyzicoResult` success shape and closed terminal-decline `errorCode` set **are** calibrated
  against the sandbox — a real charge plus iyzico's published taxonomy and its declining test cards.
- **Unit economics are disclosed, not assumed.** The pricing model is complete and never loses money by
  construction (the PSP cut is grossed up, the FX-risk buffer is sized to the real valör). But the resulting
  all-in markup is **rail-dependent** — at current (calm) volatility ~7.8% on iyzico credit (4.29%), ~3.7% on a
  bank virtual-POS debit rail (1.04%) — and the FX-risk line is **data-driven**, so it rises when the market
  tenses. The economics close on the cheaper rails / a negotiated rate / a shorter valör — a go-to-market lever,
  surfaced here rather than hidden inside the FX.

---

## 4. Not yet wired (Phase 4.5 composition — deferred, not hidden)

Phase 4.4 is done: `just fund` deployed the live testnet rails (three keypairs, USDC SAC, a seeded `TroyPool`)
and a real on-chain `pay()` money path is proven — pool `100,000 → 99,999`, replay guard, double-pay revert
(see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)). What remains is the composition that joins the two proven legs into one
running system. These parts are implemented behind interfaces + injected seams but the live composition is not yet
stood up:

- **Backend↔rails composition** — the two legs are proven **separately** (a real iyzico charge; a real on-chain
  `pay()` via the CLI). Binding them — a factory that builds the real iyzico + `stellar-client` adapters from
  env/`NetworkConfig` and a server bootstrap — is not built, so a real charge does not yet *automatically* drive
  a real `pay()`. Our own `stellar-client` adapters are type-checked + fake-tested but not yet live-smoked.
- **Production `QuoteFn` wiring** — the full quote (oracle mid → FX-risk commission → margin → PSP pass-through,
  fed by `OFFLINE_DEFAULT_PRICING_POLICY`'s valör + iyzico-rate knobs) is unit-tested, but the live `/intent`
  still uses the injected `deps.quote` seam; binding the PSP-inclusive quote into the composition root is pending.
- **`PolicyConfig` knobs** — `reservationTtl`, retry budgets, and the pool low-water mark are policy decisions set
  conservatively (the preauth/capture timing items were dropped by the money-first reordering). The
  `classifyIyzicoResult` success shape + decline table are **already calibrated** (no longer pending).

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
