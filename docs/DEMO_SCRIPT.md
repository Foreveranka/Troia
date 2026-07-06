# Troia — Demo Script (3–5 minute proof walkthrough)

> The demo's job is to make one claim undeniable: **Troia never silently loses money, and you can verify it
> yourself, offline, in seconds.** Everything below is scripted so the run is deterministic and honest — each
> beat is labeled **[runs today]** or **[phase-gated]** so nothing is oversold.

One-line pitch to open with: *"A custodial TRY→USDC settlement layer that makes every lira accountable
hash-by-hash. Don't trust me — run one command and check the math yourself."*

---

## The arc (what the reviewer will see)

1. The whole system compiles, tests, and lints clean. **[runs today]**
2. The reviewer-verifiable reconciler passes offline — and *fails* on a tampered report. **[runs today]**
3. The money-first settlement flow, narrated end-to-end, with the honest `signed ≠ settled` boundary. **[narration today; live run phase-gated]**

Total budget: ~4 minutes. Keep Act 2 the emotional center — it is the part a reviewer cannot get anywhere else.

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
just test       # 413 TypeScript tests across 59 files
just lint       # ESLint clean
cargo test      # 14 Soroban contract tests (unit + integration + fuzz conservation)
```

Say, while it runs: *"The money core, the FX oracle, the state machine, the iyzico adapter, the Soroban pool —
all offline-testable, all green. Nothing here needs my servers to be up."*

---

## Act 2 — Prove it yourself, offline (~90s) **[runs today] — the centerpiece**

> "Here's the part that matters. This is how you know a lira was accounted for without trusting me."

```bash
just verify
```

Point at the output line:

```json
{"ok":true,"summary":{"total":3,"matched":2,"mismatch":1,"unsettled":0},"ordersVerified":3,"networkAttempts":0,"failures":[]}
```

Narrate the three things that make the `0` exit code meaningful:

1. **Offline, provably.** `networkAttempts: 0`, and a startup canary confirmed the network block is *armed* — a
   deliberate connection attempt threw. This didn't "happen not to call out"; it *could not*.
2. **It recomputes, it doesn't trust.** The verifier ignores the report's own verdicts and re-derives each one
   from the embedded signed transaction and chain snapshot — pinned operator key, real Stellar tx hash.
3. **`ord-003` is a deliberate mismatch, and it's caught.** Local DB says 0.6 USDC; the signed tx and the chain
   both say 0.5. Verdict `CORRUPT_LOCAL`, and `signature_valid` is still `true` — so the evidence proves the
   error is in *our records*, and the chain is the authority.

Then break it on purpose:

```bash
node --import ./packages/reconciler/bin/block-net.mjs \
     ./packages/reconciler/bin/verify.mjs \
     ./packages/reconciler/test/fixtures/recon-report.tampered.json
```

```json
{"ok":false,...,"failures":["ord-003: verdict MATCHED != recomputed CORRUPT_LOCAL","ord-003: status matched != recomputed mismatch"]}
```

Exit code `1`. Say: *"A report that lies about its own outcome cannot pass. That's the guarantee."* Point to
[`RECONCILIATION.md`](RECONCILIATION.md) for the full model.

---

## Act 3 — The money-first flow, narrated (~90s) **[narration today; live run phase-gated]**

> "Now, how the money actually moves — and why it's ordered the way it is."

Walk the flow (screen: a diagram or the state list; no live payment needed):

1. **`POST /intent`** — the backend prices the order **server-side** (FX oracle mid × commission), reserves the
   pool (hard `409` if it can't), and returns a hosted iyzico direct-sale form priced at exactly that frozen ₺.
   *A client cannot dictate the price or the currency.*
2. **The customer pays TRY** on iyzico's hosted form (PAN never touches our servers).
3. **Only after the charge is confirmed** does the backend submit the **irreversible USDC leg** —
   `TroyPool.pay()`, a deterministic tx with an order-pinned sequence. USDC is **last** on purpose.
4. **Confirmation → done.** The merchant has USDC; the order reconciles.
5. **If USDC fails**, the sale is voided the same day — the reversible leg unwinds, no funds stranded. The only
   residual window (USDC sent but the TRY leg can't unwind) is surfaced as `review`, never hidden.

The customer only ever sees a coarse status — `pending → processing → completed`, or `failed` / `review`. The
USDC / crypto leg is never exposed to the storefront.

Close on the honest boundary: *"We prove what we signed with cryptography that survives a reset, and what
settled while the chain remembers it. We never blur the two."*

---

## What runs today vs. what is phase-gated

| Beat | Status |
|---|---|
| `just build` / `just test` / `cargo test` / `just lint` | ✅ **runs today** |
| `just verify` (offline reconciler proof + tampered-report failure) | ✅ **runs today** |
| Money-first flow **narration** + public-status mapping | ✅ **runs today** (design + tests) |
| `just fund` (friendbot + USDC SAC deploy + mint) | ⏳ Phase 4.4 |
| Live storefront (`merchant-frontend`, SEP-7 pay URI) | ⏳ Phase 5.1 |
| `just demo` — deterministic N-order run on **live** testnet → fresh `recon-report.json` | ⏳ Phase 5.3 (live variant) |
| `DEPLOYMENTS.md` explorer table (real deployed addresses) | ⏳ Phase 4.4 |

When the live rails land (Phase 4.4), Act 3 upgrades from narration to a real `just demo` run that produces a
fresh report Act 2 then verifies — closing the loop on real testnet transactions. Until then, the proof that
matters most (Act 2) is fully reproducible today.

---

## If recording a video

- Keep it to 3–5 minutes; Act 2 gets the most time.
- Show the terminal exit codes explicitly (`echo $?` after `just verify` and after the tampered run).
- Do not fake a live payment. Narrate Act 3 honestly as design-under-test; mark the phase-gated parts as such.
- End on the tampered-report failure — a memorable, undeniable beat.
