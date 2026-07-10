# Troia — Demo Script (3–5 minute proof walkthrough)

> The demo's job is to make one claim undeniable: **Troia never silently loses money, and you can verify it
> yourself, offline, in seconds.** Everything below is scripted so the run is deterministic and honest — each
> beat is labeled **[runs today]** (zero setup) or **[runs live — stack up]** so nothing is oversold.

One-line pitch to open with: _"A custodial TRY→USDC settlement layer that makes every lira accountable
hash-by-hash. Don't trust me — run one command and check the math yourself."_

---

## The arc (what the reviewer will see)

1. The whole system compiles, tests, and lints clean. **[runs today]**
2. The reviewer-verifiable reconciler passes offline — and _fails_ on a tampered report. **[runs today]**
3. The money-first settlement flow, narrated end-to-end, with the honest `signed ≠ settled` boundary. **[runs today]**
4. "Pay with Troy card" — the storefront + browser extension settling a real order live on testnet. **[runs live — stack up]**

Total budget: ~5 minutes. Keep Act 2 the emotional center (a reviewer cannot get it anywhere else); Act 4 is the
payoff — the same money-first flow from Act 3, now moving real testnet USDC through a real card charge.

---

## Pre-flight (before recording)

- Toolchain per `README.md`: Node 22, pnpm, Rust + `wasm32v1-none`, stellar CLI 26.0.0, `just`.
- `pnpm install` once. No `.env` and no network are needed for the runnable acts.
- Terminal with a legible font; commands typed live (they are short) so the reviewer sees there is no sleight of hand.

---

## Act 1 — The gate is green (~45s) **[runs today]**

> "First, the whole thing is real code under test — not slides."

```bash
just build      # all TypeScript packages compile (tsc, strict)
just test       # 581 TypeScript tests across 81 files
just lint       # ESLint clean
cargo test      # 14 Soroban contract tests (unit + integration + fuzz conservation)
```

Say, while it runs: _"The money core, the FX oracle, the state machine, the iyzico adapter, the Soroban pool —
all offline-testable, all green. Nothing here needs my servers to be up."_

---

## Act 2 — Prove it yourself, offline (~90s) **[runs today] — the centerpiece**

> "Here's the part that matters. This is how you know a lira was accounted for without trusting me."

```bash
just verify
```

Point at the output line:

```json
{
  "ok": true,
  "summary": { "total": 3, "matched": 2, "mismatch": 1, "unsettled": 0 },
  "ordersVerified": 3,
  "networkAttempts": 0,
  "failures": []
}
```

Narrate the three things that make the `0` exit code meaningful:

1. **Offline, provably.** `networkAttempts: 0`, and a startup canary confirmed the network block is _armed_ — a
   deliberate connection attempt threw. This didn't "happen not to call out"; it _could not_.
2. **It recomputes, it doesn't trust.** The verifier ignores the report's own verdicts and re-derives each one
   from the embedded signed transaction and chain snapshot — pinned operator key, real Stellar tx hash.
3. **`ord-003` is a deliberate mismatch, and it's caught.** Local DB says 0.6 USDC; the signed tx and the chain
   both say 0.5. Verdict `CORRUPT_LOCAL`, and `signature_valid` is still `true` — so the evidence proves the
   error is in _our records_, and the chain is the authority.

Then break it on purpose — this forges the report in a temp file and re-verifies the forgery:

```bash
just verify-tampered
```

```json
{"tamperDetected":true,"verifierExit":1,"ok":false,...,"failures":["ord-003: verdict MATCHED != recomputed CORRUPT_LOCAL","ord-003: status matched != recomputed mismatch"]}
```

The verifier exited `1` — it _read_ the forged report and the recomputation disagreed. Say: _"A report that lies
about its own outcome cannot pass. That's the guarantee."_ Point to [`RECONCILIATION.md`](RECONCILIATION.md) for
the full model.

---

## Act 3 — The money-first flow, narrated (~75s) **[runs today — narration]**

> "Now, how the money actually moves — and why it's ordered the way it is."

Walk the flow (screen: a diagram or the state list; no live payment needed):

1. **`POST /intent`** — the backend prices the order **server-side** (FX oracle mid × commission), reserves the
   pool (hard `409` if it can't), and returns a hosted iyzico direct-sale form priced at exactly that frozen ₺.
   _A client cannot dictate the price or the currency._
2. **The customer pays TRY** on iyzico's hosted form (PAN never touches our servers).
3. **Only after the charge is confirmed** does the backend submit the **irreversible USDC leg** —
   `TroyPool.pay()`, a deterministic tx with an order-pinned sequence. USDC is **last** on purpose.
4. **Confirmation → done.** The merchant has USDC; the order reconciles.
5. **If USDC fails**, the sale is voided the same day — the reversible leg unwinds, no funds stranded. The only
   residual window (USDC sent but the TRY leg can't unwind) is surfaced as `review`, never hidden.

The customer only ever sees a coarse status — `pending → processing → completed`, or `failed` / `review`. The
USDC / crypto leg is never exposed to the storefront.

Close on the honest boundary: _"We prove what we signed with cryptography that survives a reset, and what
settled while the chain remembers it. We never blur the two."_

---

## Act 4 — "Pay with Troy card," live (~90s) **[runs live — stack up]**

> "And here it is actually moving money. Same flow as Act 3 — now with a real card and a real testnet payout."

Setup (before recording): `just serve` (backend on `:3000`), `npm run dev` in `app/storefront`, the extension
loaded unpacked. No tunnel is needed when the browser and the backend share a machine: iyzico redirects the
customer's browser to `TROIA_CALLBACK_URL`, and settlement is driven separately by the poll worker's pull.

1. **Shop like a customer.** On the demo storefront, sign in, add items, pick a shipping tier, reach the payment
   step. The customer sees only a ₺ total — never USDC, never a wallet, never a memo.
2. **The extension notices.** A "Pay with Troy card" banner appears at the bottom of the page. Say: _"The merchant
   integrated nothing. The extension read a standard SEP-7 payment request off the page, verified it fail-closed —
   allowlisted USDC issuer, valid destination, byte-exact memo — and only then offered to pay."_
3. **Pay with a Troy sandbox card.** Click the banner → iyzico's **hosted** card form opens in a new tab (the PAN
   never touches our servers or the extension). Use a Troy test card (see `README.md`); the 3DS OTP is shown in
   parentheses on the verification screen.
4. **Money-first, live.** The charge confirms first; **only then** does the backend submit the irreversible USDC
   leg. The banner reflects coarse status (`pending → processing → completed`) — the crypto leg is never shown.
5. **Order settled + verifiable.** The storefront shows the confirmation and "My Orders" with a **settlement tx
   link**. Open it: this is a real on-chain `pay()` moving USDC pool → merchant. In the proven run it was **74
   USDC**, tx `cd643d71…`.
6. **The pool refills itself.** ~30s later — the real iyzico valör is ~21 days, **compressed to `DEMO_VALOR_SECS`**
   for the demo — a background `settleTick` worker automatically refills the USDC pool from _this order's_ collected
   TRY, converted at the live CEX oracle rate, via a real issuer-signed SAC mint, so the pool grows by the
   commission. Say: _"On mainnet that same seam becomes a real CEX buy driven by an agent + on/off-ramp service —
   the backend doesn't change."_

Say, pointing at the explorer: _"The customer paid a lira price with a Troy card. On-chain, the merchant received
USDC — and neither of them had to see the other's world. That's the whole product in one screen."_

Optional trust beat: _"And if anything stalls, the banner never lies about money — a pre-payment timeout says 'you were not charged'; a post-payment delay says 'settlement is taking a little longer, you can safely close this'; and a double Pay click is a no-op."_

> Honest note for the reviewer: this is a single manual live smoke (one of two such runs; see DEPLOYMENTS.md) on **testnet** with iyzico **sandbox** (no real
> money). If recording without the stack up, narrate it over the confirmation screenshots + the explorer tx — do
> not fake a charge.

---

## What runs today vs. what is phase-gated

| Beat                                                                    | Status                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `just build` / `just test` / `cargo test` / `just lint`                 | ✅ **runs today** (zero setup)                                 |
| `just verify` (offline reconciler proof + tampered-report failure)      | ✅ **runs today** (zero setup)                                 |
| Money-first flow **narration** + public-status mapping                  | ✅ **runs today** (design + tests)                             |
| `just bootstrap` (friendbot + USDC SAC deploy + mint)                   | ✅ done (Phase 4.4)                                            |
| Live storefront (`app/storefront`, SEP-7 pay URI)                       | ✅ built (Phase 5.1)                                           |
| "Pay with Troy card" extension → real charge → real `pay()`             | ✅ **proven live** (tx `cd643d71…`) — needs stack up to re-run |
| `DEPLOYMENTS.md` explorer table (real deployed addresses + settlements) | ✅ done (Phase 4.4 + 5.2)                                      |
| Automatic TRY-driven pool rebalance (`settleTick` + issuer-signed mint) | ✅ built (compressed valör 30s; real-CEX buy is Phase-2)       |

Acts 1–3 run today with zero setup; Act 2 (the offline, zero-trust proof) is the reproducible centerpiece. Act 4
is proven — a real Troy sandbox card charge auto-drove a real on-chain `pay()` (74 USDC, tx `cd643d71…`) — but
re-running it live needs the stack up (`just serve` + storefront + extension). The remaining
polish is a public shareable deploy so Act 4 runs without a local machine.

---

## If recording a video

- Keep it to ~5 minutes; Act 2 gets the most time, Act 4 is the payoff.
- Show the terminal exit codes explicitly (`echo $?` after `just verify` and after the tampered run).
- In Act 4, show the real explorer tx — do not fake a charge. If the stack isn't up, narrate over confirmation
  screenshots + the on-chain `pay()` (tx `cd643d71…`) rather than staging a fake payment.
- Two undeniable beats to land: the tampered-report **failure** (Act 2) and the real settlement **tx** (Act 4).
