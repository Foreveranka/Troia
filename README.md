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
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)). `just demo` is a stub until Phase 5.3.

## Secret boundary

Secrets live **only** in `.env` (git-ignored). The repo contains `.env.example` placeholders and nothing
else. `NetworkConfig` (in `packages/config`) holds **non-secret** values only — RPC url, network passphrase,
contract/SAC addresses, and public G-addresses. Any network-specific literal outside `packages/config` is a
bug and is caught by a guard test.

## Status

The money-safety core is built and tested offline: the settlement state machine, memo/identity derivation,
sequence allocator, deterministic FX oracle + commission pricing, double-entry ledger, the `TroyPool` Soroban
contract, the iyzico direct-sale adapter, and the reviewer-verifiable reconciler (`just verify` passes offline).
Settlement is **money-first** — the reversible TRY charge is taken before the irreversible USDC payout.

The live testnet rails are deployed — three keypairs, the USDC SAC, and a seeded `TroyPool` (`just fund`; see
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)).

Not yet wired (deferred, not hidden): the backend's real-adapter composition and `PolicyConfig` calibration in
the iyzico sandbox (Phase 4.5), the storefront (5.1), the browser extension (5.2), and the live `just demo` run
(5.3). See [`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
