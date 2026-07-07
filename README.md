# Troia

Custodial TRY→USDC settlement bridge on Stellar (testnet PoC). A Turkish user pays TRY with a Troy card;
the operator settles the merchant in USDC from a pre-funded Stellar pool. The spread is revenue.

> *"A settlement layer that makes every lira accountable hash-by-hash — it never silently loses money;
> the one irreversible loss bucket (`LOSS_REVIEW`) is surfaced, never hidden."* Honest proof boundary:
> **`signed ≠ settled`**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design contract and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for the phased build plan. For the reviewer-verifiable proof story, see [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md),
[`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md), and [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Toolchain

- Node 22, pnpm 11
- Rust 1.95, `wasm32v1-none` target, stellar CLI 26.0.0
- `just` (task runner)

## Commands

| Command | What |
|---|---|
| `just build` | Build all TypeScript packages |
| `just test` | Run the test suite (Vitest) |
| `just lint` | ESLint over the workspace |
| `just format` | Prettier write |
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

The live demo runs end-to-end: `just demo` drives real testnet payouts, builds a recon-report, and verifies it
offline (2 matched + 1 deliberate mismatch caught).

Wired offline, not yet live-run (remaining, not hidden): the Phase-4.5 composition that binds the real adapters +
the PSP-inclusive quote and stands up a server (`just serve`) is **built, type-checked, and offline-tested** — a
composition smoke proves the whole stack boots from the factory — so a real charge driving a real `pay()` is
realized in code. The network-facing halves are now **hardened for the live run** (per-attempt timeouts + bounded
retry on every RPC/oracle/iyzico call, so no hung source can wedge the poller or freeze a checkout) and gated by a
**readiness preflight** (`just preflight`) plus a step-by-step runbook ([`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md)).
The remaining step is the **live run itself** behind a public webhook tunnel (which live-smokes the SDK/network
adapters for the first time), then the storefront (5.1) and the browser extension (5.2). See
[`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
