# Troia

Custodial TRY→USDC settlement bridge on Stellar (testnet PoC). A Turkish user pays TRY with a Troy card;
the operator settles the merchant in USDC from a pre-funded Stellar pool. The spread is revenue.

> *"A settlement layer that makes every lira accountable hash-by-hash — it never silently loses money;
> the one irreversible loss bucket (`LOSS_REVIEW`) is surfaced, never hidden."* Honest proof boundary:
> **`signed ≠ settled`**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design contract and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for the phased build plan.

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

`just fund` / `just demo` / `just verify` are stubs until Phases 4/5/3 respectively.

## Secret boundary

Secrets live **only** in `.env` (git-ignored). The repo contains `.env.example` placeholders and nothing
else. `NetworkConfig` (in `packages/config`) holds **non-secret** values only — RPC url, network passphrase,
contract/SAC addresses, and public G-addresses. Any network-specific literal outside `packages/config` is a
bug and is caught by a guard test.

## Status

Phase 0 (scaffold). No business logic yet — see the roadmap.
