# Troia

Custodial TRY→USDC settlement bridge on Stellar (testnet PoC). A Turkish user pays TRY with a Troy card;
the operator settles the merchant in USDC from a Stellar pool that is pre-funded and automatically topped up from the collected TRY. The spread is revenue.

> _"A settlement layer that makes every lira accountable hash-by-hash — it never silently loses money;
> the one irreversible loss bucket (`LOSS_REVIEW`) is surfaced, never hidden."_ Honest proof boundary:
> **`signed ≠ settled`**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design contract and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for the phased build plan. For the reviewer-verifiable proof story, see [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md),
[`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md), and [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Toolchain

- Node 22, pnpm 11
- Rust 1.95, `wasm32v1-none` target, stellar CLI 26.0.0
- `just` (task runner)

## Commands

| Command               | What                                    |
| --------------------- | --------------------------------------- |
| `just build`          | Build all TypeScript packages           |
| `just test`           | Run the test suite (Vitest)             |
| `just lint`           | ESLint over the workspace               |
| `just format`         | Prettier write                          |
| `just contract-build` | `stellar contract build` (Soroban wasm) |

`just verify` runs today (offline, network-blocked reconciliation proof — see
[`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)); `just fund` bootstraps the live testnet rails (see
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

Secrets live **only** in `.env` (git-ignored). The repo contains `.env.example` placeholders and nothing
else. `NetworkConfig` (in `packages/config`) holds **non-secret** values only — RPC url, network passphrase,
contract/SAC addresses, and public G-addresses. Any network-specific literal outside `packages/config` is a
bug and is caught by a guard test.

## Status

The money-safety core is built and tested offline: the settlement state machine, memo/identity derivation,
sequence allocator, deterministic FX oracle + commission pricing (FX-risk commission **plus a PSP cost
pass-through**, sized to the real ~21-day iyzico valör), double-entry ledger, the `TroyPool` Soroban contract,
the iyzico direct-sale adapter, and the reviewer-verifiable reconciler (`just verify` passes offline).
Settlement is **money-first** — the reversible TRY charge is taken before the irreversible USDC payout.

The live testnet rails are deployed — three keypairs, the USDC SAC, and a seeded `TroyPool` (`just fund`; see
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

Remaining (not hidden): a public shareable deploy (storefront → Vercel, backend → Render) so the demo runs without
a local machine, and a 3–5 min proof video. The live run was a single manual smoke, not a load/soak test. See
[`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
