# Troia

Custodial TRY→USDC settlement bridge on Stellar (testnet PoC). A Turkish user pays TRY with a Troy card;
the operator settles the merchant in USDC from a Stellar pool that is pre-funded and automatically topped up from the collected TRY. The spread is revenue.

> _"A settlement layer that makes every lira accountable hash-by-hash — it never silently loses money;
> the one irreversible loss bucket (`LOSS_REVIEW`) is surfaced, never hidden."_ Honest proof boundary:
> **`signed ≠ settled`**.

## Where to start

| If you have...                   | Read                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 minutes to evaluate this       | [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md), then run `just verify`                                                                                  |
| a repo to clone and run          | [`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md)                                                                                                            |
| a question about the trust model | [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)                                                                                                    |
| a question about the design      | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design contract) / [`docs/ROADMAP.md`](docs/ROADMAP.md) (build plan)                                  |
| a question about risk            | [`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md) (business/scope) + [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) (engineering gaps) |

## Verify it yourself

You do not have to trust our verdicts. Clone it, `pnpm install`, and run three checks that need **no keys, no
network, and no live services** — the network is patched to throw and the attempt count is asserted to be zero.
The verifier never trusts the report's own signer field: it re-derives every signature against an operator key
supplied from **outside** the report, so a report that names and self-signs with an attacker's key cannot pass.
`just verify` / `just verify-tampered` prove that re-derivation and the tamper-catch on a deterministic demo corpus;
`just verify-live` re-derives a **real testnet payout** pinned to Troia's canonical operator (the committed
[deployment record](docs/DEPLOYMENTS.md) — the code fails any report naming a different key). None of them query
Horizon, so for that real payout open its `tx_hash` on the explorer to confirm it landed (`signed ≠ settled`):

```bash
just verify           # an honest reconciliation report re-derives from its embedded evidence
just verify-live      # so does a report from a REAL testnet payout — even after a testnet reset
just verify-tampered  # a forged report is caught by re-derivation, not merely rejected
```

The last one is the point: the verifier recomputes every verdict and ignores what the report claims, so a report
that lies about its own outcome cannot pass. A real `pay()` settled **74 USDC** pool → merchant on testnet, tx
[`cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded).
`just ci` runs the full gate — every suite this repo owns.

## Toolchain

- Node 22, pnpm 11
- Rust 1.95, `wasm32v1-none` target, stellar CLI 26.0.0
- `just` (task runner)

## Commands

| Command               | What                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just ci`             | The full gate — every suite, nothing skipped (a subset of GitHub Actions: CI additionally diffs the committed recon fixture for regeneration honesty and does a release wasm build) |
| `just build`          | Build all TypeScript packages (this, not `just test`, typechecks)                                                                                                                   |
| `just test`           | The packages Vitest suite only — no typecheck, no extension, no Rust                                                                                                                |
| `just lint`           | ESLint over the workspace                                                                                                                                                           |
| `just format`         | Prettier write                                                                                                                                                                      |
| `just contract-build` | `stellar contract build` (Soroban wasm)                                                                                                                                             |

`just verify` runs today (offline, network-blocked reconciliation proof — see
[`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)); `just fund` verifies the one deployed pool and wires the apps to it — `just bootstrap` is what deploys one (see
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)); `just demo` runs the full live demo — real testnet payouts →
a recon-report → offline verify (one order is a deliberate mismatch the reconciler catches). `just preflight`
smokes every live dependency (operator fees, pool USDC, oracle, iyzico) before a run, and `just serve` stands up
the backend for the Phase-4.5 end-to-end live-smoke — a real charge driving a real `pay()` (see
[`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md)).

**Paying in the demo:** the iyzico **sandbox** hosted form takes valueless test cards (no real money). Troy cards
(all succeed): Akbank `9792072000017956`, QNB `9792023757123604` / `9792020000000001` / `9792030000000000`,
Vakıfbank `6500528865390837` / `6501700194147183`. Any future expiry (e.g. `12/30`), any 3-digit CVC. The **3DS
OTP is shown in parentheses on the verification screen** — enter what it displays. Decline (fail-closed path):
Visa `4111111111111129`. Full list: [iyzico test cards](https://docs.iyzico.com/en/add-ons/test-cards).

## Secret boundary

Secrets live **only** in `.env` (git-ignored); the repo carries `.env.example` placeholders and nothing else that
is secret. It does carry `deployment.testnet.json` — the five **public** identifiers of the one deployment
(issuer, USDC asset contract, `TroyPool`, operator, admin) plus the backend URL and storefront origins, the same
identifiers published in
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md). An offline test asserts it holds no secret seed. `NetworkConfig` (in `packages/config`) holds **non-secret** values only — RPC url, network passphrase,
contract/SAC addresses, and public G-addresses. Any network-specific literal outside `packages/config` is a
bug and is caught by a guard test.

## Status

The money-safety core is built and tested offline: the settlement state machine, memo/identity derivation,
sequence allocator, deterministic FX oracle + commission pricing (FX-risk commission **plus a PSP cost
pass-through**, sized to the real ~21-day iyzico valör), double-entry ledger, the `TroyPool` Soroban contract,
the iyzico direct-sale adapter, and the reviewer-verifiable reconciler (`just verify` passes offline).
Settlement is **money-first** — the reversible TRY charge is taken before the irreversible USDC payout.

The live testnet rails are deployed — three keypairs, the USDC SAC, and a seeded `TroyPool` (`just bootstrap`; see
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)) — and a real on-chain `pay()` money path is proven. The iyzico
fiat leg is validated against the sandbox (a real charge; `classifyIyzicoResult` calibrated to iyzico's real
success shape + decline codes).

The reviewer-verifiable demo runs end-to-end offline: `just verify` re-derives a recon-report and confirms it
(2 matched + 1 deliberate mismatch caught) with `networkAttempts: 0`.

The **full stack now settles a real order end-to-end on testnet.** The demo **storefront** (5.1) emits a USDC
SEP-7 at checkout; the MV3 **"Pay with Troy card" browser extension** (5.2) detects it, opens iyzico's hosted
form, and — after a real Troy **sandbox card** charge confirms — the backend auto-submits the irreversible USDC
leg. This was proven live: **74 USDC** settled pool → merchant, tx
[`cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded)
(see [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)). The extension holds no keys and signs nothing; it is scoped to
localhost / 127.0.0.1 on any port and fails closed. The money-first ordering — reversible TRY charge first, irreversible
USDC last — held over the live network.

The pool is now **automatically topped up** from the TRY collected. A background settlement worker (`settleTick`,
on `SETTLEMENT_TICK_MS`, default 5s) arms every money-good order and, after the settlement valör — the real iyzico
valör is **~21 days**, **compressed to `DEMO_VALOR_SECS` (default 30s)** for the demo so the refill is visible —
refills the pool from that order's collected TRY at the live oracle rate by minting real issuer-signed USDC into
the pool, so the pool grows by the commission. The system is seamed for a future **agent + on/off-ramp service**:
the agent owns the _decision_ (when / how much), an on/off-ramp provider owns the real fiat↔USDC _execution_; on
mainnet that seam becomes a real CEX buy with the backend unchanged. On testnet the refill is a self-issued SAC
mint, so the only Phase-2 piece is the real exchange buy that _economically acquires_ the USDC.

What the system knows about money now **survives a crash.** Seven append-only logs under `TROIA_DATA_DIR` (default
`data/<troyPool-id>/`) hold the double-entry journal, the settlement evidence, the write-ahead list of authorized
`pay()` hashes, the chain observations, the reconciled marks, and the payout tail's cursor + suspects. Each has an
explicit crash contract — a torn tail heals and reports; a damaged record that was fully written is fatal, never
silently dropped — and a durable-log failure stops the process rather than degrading quietly.

The chain now **answers for itself.** A payout tail reads the USDC token contract's own `transfer` events and
calls any outflow whose hash never reached the write-ahead journal a rogue payout — it could not have landed
otherwise, so no grace period is needed to be sure. A live reconciler finds each order's settlement through the
`tx_id` the _contract_ indexes (not the hash we recorded) and refuses to mark it reconciled unless the pool's code
was never replaced, the announced amount equals what the token contract actually moved, and the transaction is
still live on chain. Booked-vs-chain drift alarms after three consecutive readings, and throws rather than falling
silent when it cannot read the balance.

Both of those were **proven live on 2026-07-10**. A storefront checkout paid by a Troy sandbox card settled
**80 USDC** on chain (tx
[`d47f7fb9…`](https://stellar.expert/explorer/testnet/tx/d47f7fb92a149d61a6f576aa7f803d75e6d3b3dcb6b0119e5a12a7387683d1a5)).
The live audit found that settlement through the identifier the **contract** indexes — not through the hash we
recorded — passed all four gates, and marked the order reconciled. The books matched the chain to the stroop. Then
the server was killed and restarted against the same data directory: nothing was re-booked, re-minted, or
re-advanced, and our own payout was still recognised as authorized with the order registry gone. No alarm fired —
though alarms are logged rather than persisted, so that last point is the one thing here a clone cannot re-check.
See [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md).

Remaining (not hidden): a public shareable deploy (storefront → Vercel, backend → Render) so the demo runs without
a local machine, and a 3–5 min proof video. The live runs are single manual smokes, not a load/soak test. Orders
in flight (submitted, not yet landed) are still forgotten by a restart — safely, never toward a double pay. A
**settled** order survives one: `/status` and `/receipt` answer it from the durable evidence log. See
[`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
