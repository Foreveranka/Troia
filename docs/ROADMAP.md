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
- **1.4 State machine** — the 15-state, 18-row transition table as a pure reducer. Tests: property test that
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
- **2.2 Admin path** (remaining) — `upgrade`/`set_operator`/`set_admin` under `admin.require_auth`.
- **2.3 Contract tests** — `AlreadyProcessed` reverts (not silent no-op), `InsufficientBalance`, `InvalidAmount`,
  `Paused`, `NotAuthorized`. Integration test against a real SAC. Fuzz: `pool_in == pool_out + reserved + fees`.

**Done when:** contract test suite green (unit + integration + fuzz); `stellar contract build` clean.

---

## Phase 3 — The reconciler + evidence (reviewer centerpiece) 🔴

Built on **fixture XDR/tx_hash** so it stands before real `pay()` exists (ADR-13, J1: reconciler is the
first shippable output).

- **3.1 `settlement_evidence`** — append-only store `(order_id, tx_hash, signed_xdr, seq, ledger_hint, ts)`.
- **3.2 Three-artifact reconciler** — field-diff (a)↔(c); `resolveGroundTruth` tiebreaker on (b). Verdict enum
  `MATCHED | CORRUPT_LOCAL | EVIDENCE_TAMPERED | CHAIN_DIVERGENCE`; verdict→summary buckets.
- **3.3 `recon-report.json`** — embeds all three artifacts (self-verifying, reset-proof for the signed parts).
- **3.4 `just verify`** — offline assertion; in-process socket abort guard (monkeypatch net/dns/tls). Acceptance:
  N=3 seed `troia-demo-0001` → `{total:3, matched:2, mismatch:1}`, `ord-003.verdict==CORRUPT_LOCAL`,
  `signature_valid==true`, exit 0 with network blocked.

**Done when:** `just verify` exits 0 offline on the seeded fixture set; the corrupt-local case is caught.

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
- **4.4 `rebalance` (SimulatedRebalance)** + `just fund` (friendbot XLM + SAC deploy + mint to C-address + verify).
- **4.5 Measure & lock `PolicyConfig`** in iyzico sandbox: `timebounds`, `preauth_validity`, `max_retry`,
  `reservation_ttl`, `worst_case_time_to_capture`; calibrate the `classifyIyzicoResult` input→class table.

**Done when:** a full order runs end-to-end on testnet with real `pay()` + iyzico sandbox; recon report matches.

---

## Phase 5 — Storefront, extension, proof package 🟢

Showcase, not proof — comes last on purpose.

- **5.1 `merchant-frontend`** — Next.js demo store emitting a SEP-7 pay URI; 3-screen mapping + phase flag.
- **5.2 `extension`** (MV3, thin) — own-store origin only, holds no keys, fail-closed to a manual button.
- **5.3 Proof docs** — `RECONCILIATION.md`, `DEPLOYMENTS.md`, `SCOPE_AND_LIMITATIONS.md`, `DEMO_SCRIPT.md`;
  `just demo` (deterministic N-order run) + 3–5 min proof video.

**Done when:** `just demo` reproduces the seeded run; docs + video complete.

---

## Deferred — Phase-2, boundary only (NOT built now) ⏸

- Real Binance rebalance (interface + async signature designed; impl later).
- KYC (interface now, testnet no-op).
- HSM/multisig real thresholds (Signer boundary now, threshold=1 same flow).
- Channel accounts for concurrency (`SequenceProvider` seam now).
- StellarPay/Beans extension adapters (bonus, classic-payment memo rail).
- Mainnet (regulated phase, post-code MASAK).

---

## Working agreement

- **One step at a time.** Each step: write the failing test first, make it pass, refactor, then stop and review together.
- **No pushes** without explicit confirmation. Final push = 20+ backdated commits, when everything is ready.
- **Commits show only tamerarda**, no co-author attribution.
- We start at **0.1** and do not skip ahead. If a step reveals a design gap, we fix the design (ARCHITECTURE.md
  / troia-olay-orgusu.md) before writing more code.
