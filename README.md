# Troia

**Documentation:** https://troiadocs.vercel.app

Custodial TRY→USDC settlement bridge on Stellar (testnet PoC). A Turkish user pays TRY with a Troy card;
the operator settles the merchant in USDC from a Stellar pool that is pre-funded and automatically topped up from the collected TRY. The spread is revenue.

> _"A settlement layer that makes every lira accountable hash-by-hash — it never silently loses money;
> the one irreversible loss bucket (`LossReview`) is surfaced, never hidden."_ Honest proof boundary:
> **`signed ≠ settled`** (see [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)).

## Where to start

**New here? Read in this order:**

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) **§1–2** — system context, then the settlement ordering (the money-safety heart).
2. Same doc, **§3 (Package layout)** + **§7 (Invariants)** — what the pieces are, and the rule each one upholds.
3. [`packages/core/src/state-machine.ts`](packages/core/src/state-machine.ts) alongside **§4 (State machine)** — the code next to its spec.

**Which doc do I need?**

| I want to…                                 | Read                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| evaluate this in 5 minutes                 | [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md), then run `just verify` |
| clone and run it live                      | [`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md)                           |
| install & use the browser extension        | [`docs/EXTENSION.md`](docs/EXTENSION.md)                             |
| understand the trust model (`just verify`) | [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)                   |
| understand the design                      | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                       |
| see the known engineering gaps             | [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)                       |
| see the scope / testnet boundaries         | [`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md)     |
| find deploy addresses & live proofs        | [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)                         |

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
that lies about its own outcome cannot pass. A real `pay()` has settled USDC pool → merchant on testnet — see
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md).
`just ci` runs the full gate — every suite this repo owns.

The **live stack** (backend + storefront + extension) settles on the deployment's own operator/issuer keys, which
are never shared: the on-chain `pay()` is authorized by the operator's key behind the backend, and any other key
fails its `require_auth()`. While the stack runs only on the operator's own machine, a reviewer reproduces the proof
offline (above) and **watches** the live runs via [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md); once it is publicly
deployed, a reviewer can drive the hosted storefront directly — the settlement is still authorized by the operator's
key behind the backend, never the reviewer's. To stand up your own testnet deployment instead, see
[`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md).

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
| `just verify`         | Offline, network-blocked reconciliation proof (see [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md))                                                                              |
| `just preflight`      | Smoke every live dependency (operator fees, pool USDC, oracle, iyzico) before a run                                                                                                 |
| `just serve`          | Stand up the backend for the end-to-end live-smoke — a real charge driving a real `pay()` (see [`docs/LIVE_SMOKE.md`](docs/LIVE_SMOKE.md))                                          |
| `just fund`           | Verify the one deployed pool and re-wire the apps to it; never deploys another                                                                                                      |
| `just bootstrap`      | Deploy the pool (first time, or after a testnet reset) — refuses while a live pool is recorded (see [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md))                                   |
| `just demo`           | Full live demo: real testnet payouts → a recon-report → offline verify (one order a deliberate mismatch the reconciler catches)                                                     |

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

The money-safety core is built and tested offline — the settlement state machine, memo/identity derivation, the
sequence allocator, a deterministic FX oracle with commission pricing, a double-entry ledger, the `TroyPool`
Soroban contract, the iyzico direct-sale adapter, and the reviewer-verifiable reconciler (design in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); `just verify` proves the reconciler offline, see
[`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)). Settlement is **money-first** — the reversible TRY charge is
taken before the irreversible USDC payout. The full stack now settles a real order end-to-end on testnet: the
storefront emits a USDC SEP-7, the "Pay with Troy card" extension drives an iyzico sandbox charge, and the backend
auto-submits the `pay()`; the pool then tops itself up from the collected TRY, everything it books survives a
crash, and the chain answers for itself — a payout tail flags any outflow it never authorized, and a live
reconciler confirms each settlement by the contract's own index. The on-chain proofs are in
[`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md).

The honest boundary is **`signed ≠ settled`** ([`docs/RECONCILIATION.md`](docs/RECONCILIATION.md)): testnet
exercises every guarantee with valueless self-issued USDC, so the mechanism is identical to what mainnet would run
while economic solvency — actually acquiring the USDC — and the regulated mainnet phase stay deferred
([`docs/SCOPE_AND_LIMITATIONS.md`](docs/SCOPE_AND_LIMITATIONS.md)). When an irreversible loss can occur it surfaces
as `review`, never hidden, and it is **ours** by design, never the customer's — with one known crash-window
exception, stated in full in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

What remains is hardening, not the proof story: a public shareable deploy and a short proof video, a load/soak test
(the live runs are single manual smokes), and the `[mainnet-blocker]` gaps — chiefly a durable order store, since
an order still in flight is today forgotten by a restart (safely, never toward a double pay). Each gap is stated in
full, with why it is money-safe and what closes it, in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
