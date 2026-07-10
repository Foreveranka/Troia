# Troia — Build Roadmap

> Careful, test-first, step-by-step. No rush. Each step is small, has a red→green→refactor cycle, and a
> concrete "done when" gate. We build **inside-out**: the money core and the reviewer-verifiable reconciler
> first (on fixtures), then the real rails, then the storefront/extension (showcase, not proof).
>
> Rule: nothing merges without a passing test. Deferred items are explicitly marked — they are NOT blockers.
> All code/comments/commits are English. No pushes without explicit confirmation.

Legend: 🔴 money-critical · 🟡 correctness · 🟢 plumbing/UX · ⏸ deferred (Phase-2, boundary only)

---

## Phase 0 — Scaffold & guardrails (no business logic yet)

Goal: a monorepo that compiles, lints, tests, and has the safety rails wired before any money code.

- **0.1** pnpm workspace + Cargo workspace + `.tool-versions` pin (node 22, rustc/stellar-cli 26.0.0).
- **0.2** TypeScript strict base config; ESLint + Prettier; Vitest runner.
- **0.3** `packages/config` — `NetworkConfig` interface + testnet instance (no secrets). Lint rule/grep test:
  no network-specific literal outside this package.
- **0.4** `.env.example` with the 5 secret placeholders; `.gitignore` for `.env`; secret-boundary README.
- **0.5** `justfile` skeleton: `just build`, `just test`, `just lint` (fund/demo/verify come later).
- **0.6** Empty `contracts/troy_pool` that `stellar contract build` compiles (env sanity).

**Done when:** `just build && just test && just lint` all pass on an empty-but-wired repo; contract compiles.

---

## Phase 1 — The money core on fixtures (no network, no iyzico) 🔴

This is where the design earns its keep. Everything here is pure/deterministic and unit-tested offline.

- **1.1 `deriveIds`** (`packages/core`). Implement the byte-exact preimage. **First red test:** golden-vector
  fixture (fixed `order_id` → fixed hex for memo/tx_id/idempotency_key). Two-implementer byte-identity is the
  acceptance. Locks ADR-12.
- **1.2 `PayoutIntent.build`** — memo fail-closed + flat `BuildError` in the exact control order. Tests: one
  leaf per `BuildError` variant, plus a multi-violation test asserting the deterministic winner. `build` stays
  pure (inject `AccountSnapshot`). Locks ①/ADR-6.
- **1.3 `SequenceAllocator`** — DB-authoritative single-writer. Tests: `allocate(order_id)` idempotent
  per-order (same order → same seq), `confirmBurned`, `reuseOnDead`, `release` precondition, `reallocate`.
  This is the zero-blocker starting point Elliot flagged. Locks ②.
- **1.4 State machine** — the 12-state, 22-event transition table as a pure reducer (reshaped for money-first / late-seq ordering in 4.6). Tests: property test that
  only table-listed transitions are reachable; write-ahead ordering; `UsdcDead` vs `UsdcReverted` seq inverse;
  terminal states accept no events. Strongest GO signal. Locks §3.
- **1.5 `pricing` + `oracle` (pure parts)** — median/quorum/deviation math with injected quotes (no live CEX
  yet). Tests: n=3 median+outlier, n=2 deviation→`OracleDeviationExceeded`, n≤1 fail-closed; spread math.
  Locks ⑤ freeze + ADR-2/4.
- **1.6 `ledger`** — double-entry append-only (fiat_in/crypto_out/spread/fee). Tests: entries balance.
- **1.7 composition smoke** (`packages/integration`) — one happy-path order threaded through the WHOLE
  core module-to-module (`deriveIds → build → allocate → state machine → oracle → pricing → ledger →
drift`), plus a fail-closed seam (tampered memo stops at `build`). Proves the modules **compose** —
  each was only unit-tested in isolation. Cheap insurance inserted before the Phase-2 Rust mode-switch.

**Done when:** the entire money core is green offline AND one order composes end-to-end through it; no
step touches the network or iyzico.

---

## Phase 2 — The Soroban contract 🔴

- **2.1 `TroyPool.pay()`** ✅ — `Error` enum + `__constructor` + atomic check-and-transfer (balance guard +
  `Processed(tx_id)` Persistent replay guard, same invocation, TOCTOU-free) + checks-effects-interactions
  (mark processed before transfer) + `PaymentMade` event. **`pause`/`unpause` pulled in here** (pay()'s
  `Paused` guard is untestable without them). 7 tests green (happy · replay-reverts-pays-once · insufficient ·
  invalid-amount · paused · unauthorized · constructor); release WASM + clippy clean; 0 adversarial findings.
- **2.2 Admin path** ✅ — `set_operator`/`set_admin`/`upgrade` under `admin.require_auth`; audit events
  (`AdminChanged`/`OperatorChanged`/`PauseSet`/`Upgraded`). `set_admin` is **single-step by design** — a
  fat-fingered handover bricking admin is an accepted operational footgun whose mitigation is mainnet
  multisig+timelock (ADR-14), not in-contract two-step (testnet is redeployable; plan defers admin hardening).
  Adversarial pass: 0 confirmed. 12 contract tests green; WASM + clippy clean.
- **2.3 Contract tests** ✅ — 14 tests: every `Error` variant reverts (not a silent no-op), multi-order
  real-SAC integration, and a deterministic **conservation fuzz** (`pool + Σ merchants == seed` and
  pay-at-most-once, 400 random interleavings). Fuzz teeth proven by mutation: disabling the replay guard
  makes it fail (`tx_id N settled twice`). On-chain conservation has no `reserved`/`fees` terms — those live
  off-chain (backend reservations, `packages/ledger`); on-chain the invariant is `pool == seed − Σ paid`.
  Positive `upgrade` swap (upload v2 wasm → upgrade → state preserved) is **deferred to Phase-4 deploy
  verification** (needs a real 2nd wasm artifact; unit-testing it tests the host, not our logic — the
  auth-gate is unit-tested here).

**Done when:** contract test suite green (unit + integration + fuzz); `stellar contract build` clean. ✅

---

## Phase 3 — The reconciler + evidence (reviewer centerpiece) 🔴

Built on **fixture XDR/tx_hash** so it stands before real `pay()` exists (ADR-13, J1: reconciler is the
first shippable output).

Crypto model was locked by a pre-code design audit (empirically verified against `@stellar/stellar-base@15`)
and the ARCHITECTURE §8 shorthand corrected first: `hash := Transaction.hash()` (real Stellar tx hash, NOT
`sha256(envelope)`); sig over `tx.hash()` by pinned operator + hint; verdict cascade **role-split** (tamper
vs divergence) + a 5th verdict `UNSETTLED`. Fixture = real Soroban `pay()` invocation (no footprint → real/
decodable but not submittable). `packages/reconciler` is keyless & buildless by construction (grep-guard).

- **3.1 `settlement_evidence`** ✅ — append-only, per-order-idempotent, `Object.freeze`d store of the opaque
  signed blob (never recomputed from intent). `(order_id, tx_hash, signed_xdr, seq, ledger_hint, ts)`.
- **3.2 Three-artifact reconciler** ✅ — `decode` (SCVal → projection) · `normalize` (one semantic comparator
  set) · `verify-crypto` (P1 hash-self-consistency · P2 pinned-operator sig by hint · P3 chain-bound) ·
  `resolveGroundTruth` (7-step total procedure) · `field-diff` (a↔c, `local_value` from the DB). 5-case
  truth table green.
- **3.3 `recon-report.json`** ✅ — embeds all three artifacts + `network.{passphrase, operator_public}` +
  summary; self-verifying, reset-proof for the signed parts.
- **3.4 `just verify`** ✅ — offline, positive-armed exit (`bin/block-net.mjs` patches net/tls/dns/http(s)/
  http2/dgram/fetch/WebSocket; startup canary must throw; `networkAttempts==0`; every order re-derived).
  Acceptance met: N=3 seed `troia-demo-0001` → `{total:3, matched:2, mismatch:1, unsettled:0}`,
  `ord-003.verdict==CORRUPT_LOCAL` with `signature_valid==true`, **exit 0 network-blocked**; a tampered report
  flips the exit code. Adversarial xhigh pass: 7 candidates → 1 confirmed (`amountEqual('','0')` conflation)
  → fixed (canonical-decimal guard) + regression-tested.

**Done when:** `just verify` exits 0 offline on the seeded fixture set; the corrupt-local case is caught. ✅

---

## Phase 4 — Real rails wired into the backend 🔴🟡

Now connect the core to the outside world, one provider at a time, behind interfaces.

- **4.1 `stellar-client`** — SAC transfer, deterministic tx build (source+seq+timebounds), submit + poll,
  `AccountSnapshot` loader. Deadness helpers (ledger closeTime, network seq read, all-hash scan).
- **4.2 `psp` (IyzicoSandbox)** — `initializeCheckoutForm`, `retrieveCheckoutFormResult`, `createPreAuth`,
  `createPostAuth`, `refund`, `cancel`, `verifyWebhookSignature`, `classifyIyzicoResult` (3-valued).
- **4.3 Backend orchestration (Fastify)** — the state machine driving real calls; write-ahead persistence;
  crash-recovery worker (read-then-decide). `POST /api/intent`, `GET /api/status/{id}`, `POST /api/webhooks/iyzico`
  (HMAC verify on raw body before parse; event_id dedupe).
- **4.4 `rebalance` (SimulatedRebalance)** + `just fund` — **✅ done**: the live testnet rails are deployed
  (three keypairs, USDC SAC, a seeded `TroyPool`) and a real on-chain `pay()` money path is proven — pool
  `100,000 → 99,999`, replay guard, double-pay revert (see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)).
- **4.5 Calibration + pricing + composition** — the money-first reordering (4.6) dropped the preauth/capture
  timing items. **Done:** `classifyIyzicoResult` calibrated against the live sandbox (real charge + published
  taxonomy + declining test cards); the pricing model completed with a **PSP cost pass-through** (gross-up) and
  the **real ~21-day valör**; and the **composition is wired offline** — `buildStellarPort` /
  `buildTestnetServerDeps` assemble the real adapters + the PSP-inclusive quote into `ServerDeps`, and a
  composition smoke boots the app from that factory (with injected bootstrap reads) and drives its fail-closed
  routes — all type-checked + offline-tested. The network-facing halves are now **hardened for the live run**
  (per-attempt timeouts + bounded retry on every RPC/oracle/iyzico call — a hung source drops fail-closed instead
  of wedging the poller or freezing a checkout; unit-tested offline + adversarially reviewed), gated by a
  **readiness preflight** (`just preflight`, which smokes each dirty dependency in isolation), and scripted end-to-
  end in [`LIVE_SMOKE.md`](LIVE_SMOKE.md) (`scripts/intent.mjs` drives a charge, `scripts/probe-revert.mjs` checks
  the revert-read shape). **✅ The live run is done** — `just serve` behind a public webhook tunnel drove a real
  Troy sandbox card charge that auto-submitted a real `pay()` (74 USDC settled, tx `cd643d71…`; see
  [`DEPLOYMENTS.md`](DEPLOYMENTS.md)), live-smoking the SDK/network adapters for the first time.
- **4.7 Automatic TRY-driven rebalance loop** — **✅ built**: a background settlement worker (`settleAndRebalance`,
  scheduled as `settleTick` on `SETTLEMENT_TICK_MS`, default 5s) arms every money-good order (`UsdcConfirmed`/
  `Reconciled`), records one pending settlement per order due at `now + demoValorSecs`, and — after the demo valör
  (the real iyzico valör is ~21 days, **compressed to `DEMO_VALOR_SECS`, default 30s**, so the refill is visible in
  the demo) — mints real issuer-signed USDC into the pool at the live oracle rate (`TryDrivenRebalancePolicy`,
  Model-B: converts the whole collected TRY, truncated down), books it in the ledger, and `creditPool`s the
  `/intent` gate. Seamed for a future **agent + on/off-ramp service** (agent = the _decision_, on/off-ramp = the
  real fiat↔USDC _execution_); on mainnet that seam replaces the SAC mint with a real CEX buy, backend unchanged.

- **4.8 Durability + chain-authoritative detection** — **✅ built**: an append-only `FileAppendLog` with a stated
  crash contract (poison-on-first-failure, torn-tail heal-and-report, fatal on a damaged committed record) backs
  seven logs under `TROIA_DATA_DIR/<troyPool-id>/`; every writer appends before it believes, and a
  `DurableLogFailure` exits the process. The ledger books the outflow when a payout is armed, genesis is booked
  once, and `checkDrift` alarms after three consecutive out-of-sync readings (throwing, never silent, on a read
  failure). `tailOutflows` (`OUTFLOW_INTERVAL_MS`, 20s) reads the USDC SAC's `transfer` events and pages
  `ROGUE PAYOUT` for any outflow whose hash never reached the durable write-ahead journal; `reconcileOrders`
  (`RECONCILE_INTERVAL_MS`, 30s) finds each settlement by the contract-indexed `tx_id` and gates `Reconciled` on
  four checks. See ARCHITECTURE §7b + §8a.

**Done when:** a full order runs end-to-end on testnet with real `pay()` + iyzico sandbox; recon report matches. ✅

---

## Phase 5 — Storefront, extension, proof package 🟢

Showcase, not proof — comes last on purpose.

- **5.1 `storefront`** ✅ — a Vite/React demo store (streetwear) that emits a USDC-on-Stellar SEP-7 pay URI at
  checkout, with localStorage auth (sign-in gates checkout), per-user orders, and a settlement-tx proof link on
  the confirmation + order-details views. Drives the real backend on `localhost`.
- **5.2 `extension`** ✅ — the MV3 "Pay with Troy card" bridge. A content script scans the storefront DOM for a
  payable USDC SEP-7 (fail-closed: 7-check confidence, banner only when every required check passes), a background
  worker (the only holder of the backend host permission) posts `/intent` and opens iyzico's hosted card page, then
  polls coarse status and hands the settlement receipt (tx hash + TRY charged) back to the storefront. Holds no
  keys, signs nothing, allowlisted origins only. **Proven live end-to-end** (Troy sandbox card → 74 USDC settled,
  tx `cd643d71…`). 105 extension tests green (10 spec files). Hardened for the live money path: per-request fetch timeouts (intent 15s / polls 8s), a phase-aware poll budget with honest give-up (never falsely claims "not charged"), tab-open-failure handling, a double-submit guard, memo parity pinned to core's golden vectors with malformed-order-id rejection (fail-closed `bad-order-ref`), and an amount gate aligned with `toStroops`.
- **5.3 Proof docs** — `RECONCILIATION.md`, `DEPLOYMENTS.md`, `SCOPE_AND_LIMITATIONS.md`, `DEMO_SCRIPT.md` ✅;
  `just verify` offline proof ✅. Remaining: a public shareable deploy (storefront → Vercel, backend → Render) and
  a 3–5 min proof video.

**Done when:** the storefront + extension settle a real order end-to-end on testnet ✅; docs ✅; shareable deploy +
video remain.

---

## Deferred — Phase-2, boundary only (NOT built now) ⏸

- Real CEX rebalance **inventory buy** — only the real exchange buy+withdraw that _economically acquires_ the USDC is deferred (invariant ③b); the automatic trigger + the testnet SAC-mint top-up are **built** (4.7). The future **agent + on/off-ramp service** plugs into the existing `RebalancePolicy` (decision) + `RebalanceProvider` (execution) seams.
- KYC (interface now, testnet no-op).
- HSM/multisig real thresholds (Signer boundary now, threshold=1 same flow).
- Channel accounts for concurrency (`SequenceProvider` seam now).
- StellarPay/Beans extension adapters (bonus, classic-payment memo rail).
- Mainnet (regulated phase, post-code MASAK).

---

## Working agreement

- **One step at a time.** Each step: write the failing test first, make it pass, refactor, then stop and review together.
- **No pushes** without explicit confirmation. The git history is **real** — commits are made as the work happens,
  never backdated or reconstructed.
- **Commits show only tamerarda**, no co-author attribution.
- We start at **0.1** and do not skip ahead. If a step reveals a design gap, we fix the design (ARCHITECTURE.md
  / troia-olay-orgusu.md) before writing more code.
