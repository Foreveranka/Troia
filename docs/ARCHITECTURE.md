# Troia — Architecture

> Custodial TRY→USDC settlement bridge on Stellar (testnet PoC).
> A Turkish user pays TRY with a Troy card; the operator settles the merchant in USDC from a
> pre-funded Stellar pool. The spread is revenue. Positioning: *"a settlement layer that makes every
> lira accountable hash-by-hash — it never silently loses money; the one irreversible loss bucket
> (`LOSS_REVIEW`) is surfaced, never hidden."* Honest proof boundary: **`signed ≠ settled`**.

This document is the formal companion to the working narrative in `troia-olay-orgusu.md`. The narrative
is the reasoning; this is the ADR-backed contract the code must satisfy. Everything network-specific is
injected via `NetworkConfig`; a literal `if (network === 'testnet')` anywhere in business logic is a bug.

All code, comments, commit messages, and log strings are **English only**.

---

## 1. System context

```
   USER (never sees web3)        TROIA (this system)         MERCHANT (never sees TRY)
  ┌───────────────────┐  TRY   ┌──────────────────┐  USDC   ┌───────────────────┐
  │ Troy card, ₺ only │ ──────►│  custodial bridge │ ───────►│ USDC payout only  │
  └───────────────────┘ iyzico └──────────────────┘ Stellar └───────────────────┘
```

- **User** sees a single ₺ total. No "rate / USDC / crypto / spread" wording ever reaches the UI.
- **Merchant** sees an ordinary USDC payment. Unaware TRY sits behind it.
- **Troia** sits in the middle, owns the FX conversion and the settlement risk.

The pool is **pre-funded**, so the merchant is paid instantly and does not wait for TRY→USDC rebalancing.
The user *does* wait (~10–45s) while the settlement chain completes.

---

## 2. The settlement ordering — the heart of money safety

Two legs with opposite reversibility:

- **USDC is irreversible** (once sent, it is gone).
- **TRY hold is reversible** (a preauth can be voided).

Therefore the irreversible leg is executed **before** capturing the reversible leg:

```
1. PreAuth   — iyzico blocks (holds) the TRY on the card; does not charge yet
2. USDC pay  — TroyPool.pay() moves USDC pool→merchant (deterministic tx: order-pinned seq + 45s timebounds)
3. Confirm   — on-chain confirmation (getTransaction / settlement_evidence)
4. PostAuth  — ONLY NOW iyzico captures (charges) the TRY
```

This drives **order-level float to zero**: on the happy path there is never a "sent USDC but did not
capture TRY" (or the reverse) gap. If USDC never lands, PostAuth is never called and the hold is voided.

**Residual risk is not zero — it is confined to one narrow window** (USDC sent → capture rejected →
`LOSS_REVIEW`). Two sub-cases, deliberately separated:

- **Expiry** (hold window elapsed): prevented by the invariant `preauth_validity ≫ worst_case_time_to_capture`
  (worst case measured against RPC observation lag, not the 45s timebounds).
- **Reject** (issuer refuses capture: limit/balance): duration cannot save this → residual risk →
  `LOSS_REVIEW`, accepted honestly. The invariant prevents *expiry*, not *reject*.

When a loss occurs it is **ours**, never the customer's: the card hold is voided (`TryHoldVoided`).

---

## 3. State machine (single source of truth)

15 states; the transition table in `troia-olay-orgusu.md` §4 is authoritative and is mirrored 1:1 in code
(`packages/core`). An independent audit (D1–D8) corrected the original table for money-safety and reducer
totality before implementation. State classes:

- **Absolute terminals** (any event → idempotent no-op): `Reconciled · FailedClean · TryHoldVoided`.
- **Void-pending** (a live TRY hold remains → `iyzico.cancel` is 3-valued; `voidConfirmed → TryHoldVoided`):
  `SolvencyRejected · LossReview · AbandonedSeqReturned`. These are NOT resting terminals — a post-PreAuth path
  must always end captured (`TryCaptured`) or voided (`TryHoldVoided`).
- **Awaiting-reconcile:** `TryCaptured` (→ `Reconciled`).

The reducer is pure and total: `transition(state, event) → {status:'transition', next, effects} | {status:'ignored'}
| {status:'rejected', reason}` — it never throws. Only table-listed transitions yield `transition`; a duplicate
event on an absolute terminal yields `ignored` (at-least-once redelivery); an undefined pair yields `rejected`.

Load-bearing rules (each is a test):

- **Write-ahead:** the in-flight state (`UsdcSubmitted` / `CaptureSubmitted`) is persisted **before** the
  side-effecting call. So a state can mean "the side effect definitely has not started yet" → safe to proceed.
- **Unknown never advances toward an irreversible action:** solvency, capture, void, and preauth are all
  3-valued (OK/FAIL/Unknown). An `Unknown` result stays and re-polls; it never triggers `pay()`, a capture, or a
  cancel. A two-valued gate before the irreversible USDC leg is a P0 (same class as the capture double-charge).
- **Deadness is hash-first, not wall-clock:** a tx is dead (safe to release the hold) only if **(1)** none of
  the order's evidence hashes is SUCCESS, **and (2)** `observed last ledger closeTime > tx.maxTime`, **and**
  `network-read account seq < S` (seq still unburned). `Date.now()` is forbidden. A burned seq means a tx
  landed (CONFIRMED or REVERTED) → not dead, no same-seq replay.
- **`UsdcDead` vs `UsdcReverted` — inverse seq behaviour:** DEAD = tx never entered, seq free → same-seq
  replacement valid. REVERTED = tx entered + reverted, seq burned → same-seq replay loops on `txBAD_SEQ` →
  forbidden; classify the cause (`AlreadyProcessed → UsdcConfirmed` and capture; `BalanceGuard → clean void`;
  `Other → reallocate NEW seq`). Reconciled is reachable ONLY via `TryCaptured`.
- **Recovery never blind-resubmits / re-captures** — restart fires an observation-only `recover` event that
  reads evidence / re-polls, then the normal observation rows fire; it never re-runs the entering side-effect.

---

## 4. Identity lineage — every key derives deterministically from one `order_id`

Four guards (memo / seq / contract / capture) must derive from the **same identity** or they disagree
(one says "already done" while another says "new"). One pure function, byte-exact preimage, so two
independent implementers produce byte-identical output:

```
lp(b)       = u32be(len(b)) ‖ b          // variable field: 4-byte big-endian length prefix + bytes
order_id    = NFC-normalized, then UTF-8 bytes   // lone surrogates rejected (not well-formed Unicode)
destination = raw ASCII bytes ("G…"/"C…" StrKey; non-ASCII rejected, no trim/case-fold — NOT raw 32 bytes)
amount_be16 = i128 in [-2^127, 2^127-1] → 16-byte big-endian two's complement (fixed width, no prefix)
memo        = 32 raw bytes (output of the derivation below)
hash        = sha256 (matches env.crypto().sha256)

deriveIds(order_id, destination, amount):
  memo            = sha256( lp("troia.memo.v1") ‖ lp(order_id) )
  tx_id           = sha256( lp("troia.txid.v1") ‖ lp(order_id) )
  idempotency_key = sha256( lp("troia.idem.v1") ‖ lp(order_id) ‖ lp(destination) ‖ amount_be16 ‖ memo )
```

**Canonical input rules (pinned — an independent adversarial pass found these five divergence points):**
1. **order_id** is NFC-normalized before UTF-8, so logically-equal ids never diverge (NFC vs NFD).
   `canonicalizeOrderId` is the single authority; callers that persist/key on order_id store its output.
2. **Lone UTF-16 surrogates** in order_id are rejected (strict well-formed Unicode; no U+FFFD/WTF-8 drift).
3. **destination** is hashed as raw ASCII with no trimming/case-folding; a non-ASCII byte is rejected, never
   silently masked to 7 bits.
4. **amount** is restricted to the i128 range `[-2^127, 2^127-1]`; out-of-range is rejected (no silent wrap).
   This matches Soroban's i128 and removes the top-bit collision at `2^127..2^128-1`.
5. **order_id is a string on the wire** (never a JSON number); the API schema enforces this (§API/Phase 4.3).

Emptiness of order_id and non-positive amounts are byte-legal here; the "non-empty" / "amount > 0" business
rules live in `PayoutIntent.build` (fail-closed). Violations of rules 1–4 throw `DeriveIdsError`.

`seq S` and `quote_id` are **not** pure derivations (allocator / price-time bound) but are still pinned to
`order_id`. A golden-vector fixture (`packages/core/test/fixtures/derive-ids.golden.json`) locks the hex.

**Two shields, two DIFFERENT fields:**
- Same-seq domain (PoC): a replacement with seq S is rejected at protocol level (`txBAD_SEQ`) if the first tx
  landed — the shield is the **sequence**, the contract is never consulted.
- Different-seq domain (allocator bug / manual retry / channel accounts = Phase-2): the only shield is the
  contract's `Processed(tx_id)` (second `pay()` reverts). This is why `tx_id` derives from `order_id`, **not**
  from `tx_hash` — a different-hash second tx must collide on the same key.

---

## 5. Two Stellar entities — `TroyPool` (contract) vs `operator` (account)

| Entity | Type | Role | Sequence? |
|---|---|---|---|
| `TroyPool` | Soroban contract (`C…`) | Holds USDC custody; `pay()` moves balance inside the contract | **None** (contracts have no seq) |
| `operator` | Classic account (`G…`) | Signs + submits every `pay()` tx; `operator.require_auth` identity | **Yes** (managed by `SequenceAllocator`) |

`getAccount(pool).sequence` is really `getAccount(operator).sequence`. In PoC, `require_auth` identity =
tx source = fee account = a single `operator`. The operator's single sequence space is the serialization
bottleneck → the **head-of-line** rule (one in-flight payout at a time). Phase-2 seam: channel accounts
(operator auth stays fixed; source/fee/seq move to a channel pool; `SequenceAllocator` interface unchanged).

**Payment rail is locked:** USDC payment is a `TroyPool.pay()` Soroban invocation, NOT a classic payment.
`memo` is a `pay()` argument (`BytesN<32>`), not a tx memo field.

---

## 6. Invariants (each owned by exactly one module)

| # | Invariant | Owner |
|---|---|---|
| ① | MEMO FAIL-CLOSED — no `PayoutIntent` without valid memo+address+trustline; button cannot be pressed | `packages/core` `PayoutIntent.build` |
| ② | DOUBLE-PAY SHIELD (USDC) — order-pinned seq (single-writer, serial) → 2nd tx = `txBAD_SEQ` | `SequenceAllocator` + `TroyPool` guard |
| ③a | SOLVENCY MECHANISM — backend reservation AND contract `balance>=amount` (both "yes") | backend + `TroyPool` |
| ③b | SOLVENCY (ECONOMIC) — real inventory adequacy = Phase-2 (testnet mints infinitely) | `packages/rebalance` |
| ④ | EVIDENCE — every submit writes hash+XDR+seq to our append-only ledger | `settlement_evidence` |
| ⑤ | PRICE-LOCK — the ₺ shown is frozen at intent-build; capture charges exactly that | `packages/pricing` computes, `core` freezes |
| ⑥ | CAPTURE IDEMPOTENCY (TRY) — iyzico has no dedup → our DB-guard + `CaptureSubmitted` + 3-valued retrieve | `packages/psp` + backend |
| ⑦ | PREAUTH VOID (TRY) — failure states release the card hold via `iyzico.cancel` → `TryHoldVoided` | `packages/psp` + backend |

**`BuildError` (flat enum, deterministic control order):**
`AddressInvalidChecksum → MemoMissing → MemoWrongLength → MemoZero → MemoMismatch → AmountNonPositive →
IssuerNotAllowlisted → TrustlineMissing`. `build(raw, snapshot)` stays **pure** — trustline is read from an
injected `AccountSnapshot`, not from the network.

`PayoutIntent.build` is **total and defensive at the trust boundary**: `RawPayout` field types are
compile-time only, so build validates runtime types too (a non-`bigint` amount, non-`string` order_id, etc.
fail closed to the matching `BuildError`) and never throws for any `raw` input. (`BuildContext` is a trusted
programmatic dependency, not the untrusted payload.)

**Capture 3-valued classifier (`classifyIyzicoResult`):** `Success → TryCaptured` · `DefinitivelyNotCaptured
→ bounded retry` · `Unknown (5xx/timeout/reset) → STAY, re-poll, never a new capture`. A two-valued classifier
double-charges on `Unknown` (P0).

---

## 7. Package layout

```
troia/
├── Cargo.toml                  # Rust workspace
├── package.json                # pnpm workspace root
├── pnpm-workspace.yaml
├── justfile                    # just fund / demo / verify
├── .tool-versions
├── contracts/
│   └── troy_pool/              # single Soroban contract: pay + guard + pause + upgrade
├── packages/
│   ├── config/                 # NetworkConfig — single authority, no secrets
│   ├── core/                   # PayoutIntent, deriveIds, state machine, domain types
│   ├── oracle/                 # deterministic median CEX rate (no AI)
│   ├── pricing/                # userTRY = usdc × rate × (1 + spread_bps)
│   ├── ledger/                 # double-entry: fiat_in / crypto_out / spread / fee
│   ├── psp/                    # PaymentProvider (IyzicoSandbox → IyzicoProd)
│   ├── rebalance/              # RebalanceProvider (SimulatedRebalance → Binance)
│   ├── kyc/                    # KycProvider (testnet no-op) — boundary now
│   ├── signer/                 # Signer abstraction (LocalKey → KMS/HSM+multisig)
│   └── stellar-client/         # SDK wrapper: SAC transfer, submit + poll, snapshot loader
├── app/
│   ├── backend/                # Fastify — the heart: state machine, webhook, solvency, reconciler
│   └── merchant-frontend/      # Next.js demo store, emits SEP-7 pay URI
└── extension/                  # MV3 — thin: adapters + content/background, holds no keys
```

Stack pins: `soroban-sdk 26.0.0`, stellar CLI 26.0.0, node 22, pnpm, `iyzipay 2.0.69` (+ `@types/iyzipay`),
USDC = **7 decimals** (Stellar protocol).

### 7a. Accounting ledger (`packages/ledger`) — double-entry, distinct from `ledger_evidence`

Where the money went, not what we signed (that is §8's `ledger_evidence`). Pure/deterministic, append-only,
fixed-point bigint — no clock, no network.

- **Functional (reporting) currency = kuruş.** Every leg carries a `native` amount (kuruş for TRY accounts,
  **stroops** for USDC) **and** its `kurus` value; a valid entry's kuruş legs balance on both sides
  (`Σ debits.kurus == Σ credits.kurus`). This is the standard multi-currency ledger shape: the USDC leg's
  native is stroops, its functional value is the TRY-at-mid.
- **Accounts (fixed currency each):** `FIAT_CASH`, `USDC_POOL` (assets), `SPREAD_REVENUE` (income),
  `PSP_FEE` (expense), `EXTERNAL_FUNDING` (pool-top-up counter). Chart is closed; a leg can't be mis-tagged.
- **Balanced by construction:** `recordSettlement` derives `baseKurus = userTryKurus − spreadKurus`, so
  `fiat_in == crypto_out(at mid) + spread (+ fee split out of cash as an expense)` holds by algebra — feeds
  straight from `pricing`'s `PriceBreakdown`. Zero-valued legs are omitted (every leg strictly positive).
- **On-chain = source of truth:** `detectDrift(observedPoolStroops)` compares the ledger's `USDC_POOL`
  native total to the chain balance; nonzero drift is an alarm, never silently absorbed. The ledger holds no
  rate, so USDC↔TRY valuation correctness is `pricing`'s invariant + the reconciler's job, not the ledger's.
- **Fail-closed & immutable:** `post()` rejects empty/non-positive/valuation-mismatch/unbalanced/duplicate-ref
  entries; stored entries + legs are `Object.freeze`d and `all()` returns a snapshot, so the append-only
  journal can't be mutated even from plain JS (`readonly` alone is erased at runtime).

---

## 8. Reconciliation — the reviewer-verifiable centerpiece (three-artifact model)

Per order, three independent records (`packages/reconciler`, keyless & buildless by construction — imports
`@stellar/stellar-base` only to **decode/verify**, never to sign):

- **(a) `business_intent`** (local DB row: `destination`/`amount_stroops`/`memo_hex`) — "this was requested".
  **Mutable.** `local_value` in a diff always comes from HERE, never decoded from the XDR.
- **(b) `ledger_evidence`** (`signed_xdr` + `hash`) — "this is what we signed and submitted". A frozen opaque
  witness — **never re-serialized** from (a) at recon-time (else corrupting the local row also corrupts the
  signature and the whole model collapses; enforced structurally by a grep-provenance test). `hash` is the
  **Stellar transaction hash** = `hex(Transaction(signed_xdr, passphrase).hash())` =
  `sha256(networkId ‖ ENVELOPE_TYPE_TX(0x00000002) ‖ xdr(innerTx))`. It is **NOT** `sha256(envelope)` nor
  `sha256(decoded tx)` (empirically distinct). An optional `blob_sha256` is a pure integrity tripwire, never
  equated to the tx hash (identity ≠ integrity).
- **(c) `chain_evidence`** (`tx_hash` + `fetched_at_ledger` + frozen `horizon_snapshot` projection) — "the
  chain looked like this when we observed it". The snapshot is a **normalized projection** of the `pay()`
  invocation (`tx_id`/`amount`/`applied_rate`/`merchant`/`memo`), produced by the SAME normalizer that
  decodes (b), so the two sides can never disagree by format.

The report pins the trust anchors at top level: `network.passphrase` (needed to recompute the tx hash) and
`network.operator_public` (the signer key — read as **data**, never from the mutable XDR). Field mapping:
`business_intent.destination ⇄ pay() merchant (arg3)`, `amount_stroops ⇄ i128 arg1`, `memo_hex ⇄ BytesN<32>
arg4`. `applied_rate` is carried but **excluded** from the diff (the ledger is its audit source).

**`resolveGroundTruth` — total, ordered, role-split** (the earlier single AND-fold made `CHAIN_DIVERGENCE`
unreachable). Let `S`=pinned-operator signature verifies over `tx.hash()` (by hint, any match — multisig
seam); `HB`=`recomputed_hash === ledger_evidence.hash`; `BC`=`hash === chain.tx_hash` (bitwise); `DC`=decode
== snapshot (semantic); `IC`=business_intent == snapshot (semantic: amount→stroops bigint, address→canonical
StrKey, memo→hex):

```
1. decode fails / not a Transaction / func ≠ invokeContract('pay')  ⇒ EVIDENCE_TAMPERED
2. !S                                                               ⇒ EVIDENCE_TAMPERED  (bad/absent operator sig)
3. !HB   (recomputed hash ≠ recorded hash)                          ⇒ EVIDENCE_TAMPERED  (blob ↮ hash)
   ── after 1–3, (b) is an authentic, self-consistent operator witness ──
4. chain_evidence == null                                          ⇒ UNSETTLED          (signed proven; settlement NOT)
5. !BC || !DC  (a DIFFERENT tx settled)                            ⇒ CHAIN_DIVERGENCE   (signed ≠ settled)
6. IC                                                              ⇒ MATCHED
7. else                                                            ⇒ CORRUPT_LOCAL      (authority = chain; ONLY reachable with S∧HB∧BC∧DC)
```

Verdict enum: `MATCHED | CORRUPT_LOCAL | EVIDENCE_TAMPERED | CHAIN_DIVERGENCE | UNSETTLED`. `verdict→status`:
`MATCHED→matched`; `CORRUPT_LOCAL|EVIDENCE_TAMPERED|CHAIN_DIVERGENCE→mismatch`; `UNSETTLED→unsettled`.
`CORRUPT_LOCAL` is reachable ONLY after `S∧HB∧BC∧DC`, so it always carries `signature_valid==true` — exactly
the ord-003 acceptance guarantee.

**`just verify` — offline-armed assertion** (`node --import bin/block-net.mjs bin/verify.mjs report.json`):
input is ONLY the report file (no network, no DB). It **recomputes** each order's `hash`/signature/decode and
re-derives verdict/status/summary from the embedded evidence, asserting each equals the stored value.
Network is blocked in-process by a preload that patches `net`/`tls`/`dns`/`http(s)`/`http2`/`dgram`/`fetch`/
`WebSocket`/`undici` to throw and count attempts (darwin-portable; **not** an OS firewall). Exit 0 requires a
**positive** proof, not mere absence: a startup canary must confirm the block is armed (a deliberate
`net.connect` throws), `ordersVerified === N`, `networkAttempts === 0`, and every re-derivation matches.
Honest boundary: **`signed ≠ settled`** — the fixture tx has no Soroban footprint (`tx.ext().switch()===0`),
so it is real/verifiable/decodable but not network-submittable (Phase-4's `stellar-client` produces the
submittable XDR); and a testnet reset erases chain history, surfaced per order as `UNSETTLED`. We never claim
"settlement is provable after reset".

---

## 9. Keys & config boundary

Three separate keypairs even on testnet (no collapse): **admin** (`TROIA_ADMIN_SECRET`), **operator**
(`TROIA_OPERATOR_SECRET`), **issuer** (`TROIA_ISSUER_SECRET`, USDC SAC mint). Plus iyzico
(`IYZICO_API_KEY`/`IYZICO_SECRET_KEY`) and webhook (`WEBHOOK_SIGNING_SECRET`).

- `NetworkConfig` = non-secret, injected: RPC url, passphrase, `TroyPool` C-address, USDC SAC id, public
  G-addresses. Secrets = env only, git-ignored, `.env.example` placeholders in repo.
- Phase-0 funding (`just fund`): friendbot funds XLM only; `stellar contract asset deploy` for USDC SAC;
  `mint(TroyPool_C, POOL_SEED)` directly to the contract C-address (no transfer/deposit step, no trustline).

---

## 10. Architecture Decision Records

Each ADR lives in `docs/adr/NNNN-*.md`. Index:

1. Stellar-only (no multi-chain).
2. Oracle deterministic, no AI — median + quorum + circuit breaker.
3. Custodial model + PreAuth/PostAuth settlement (K1, float=0), capture last.
4. Transparent spread revenue, not fixed fee / hidden FX.
5. Solvency = backend AND contract.
6. Memo fail-closed invariant (`PayoutIntent`, flat `BuildError`, deterministic order).
7. USDC = 7 decimals on Stellar.
8. Extension = adapter-per-gateway + manual fallback; holds no keys.
9. Every dependency behind an interface → mainnet = config swap + 3 provider impls + time-budget re-validation.
10. Testnet positioning; mainnet = separate regulated phase (MASAK, post-code).
11. Payment rail = `TroyPool.pay()` Soroban invocation; `memo` is an argument, not a tx memo.
12. Identity from one `order_id` via `deriveIds` (byte-exact, domain-separated); `tx_id` from order, not tx_hash.
13. Reconciler three-artifact model; `signed ≠ settled` honest boundary; `just verify` offline.
14. Three separate keypairs (admin/operator/issuer); testnet threshold=1, same multisig flow shape.
15. Accounting ledger = double-entry, functional currency kuruş, native amounts per currency; balanced by
    construction; on-chain drift detection; append-only + runtime-frozen. Distinct from §8 `ledger_evidence`.
16. `TroyPool.pay()` money-safety: atomic check-and-transfer (no TOCTOU); checks-effects-interactions (mark
    `Processed` before transfer, relying on Soroban's all-or-nothing revert); `Processed(tx_id)` in
    **Persistent** storage — durability rests on archival-not-deletion (an aged-out guard must be restored
    with value intact before `pay()` can read it), so the replay path deliberately does NOT re-bump TTL (an
    `Err` return would roll the bump back). Deploy-time `__constructor` binds roles once (no re-init surface).
    Admin path (`set_operator`/`set_admin`/`upgrade`) is `admin.require_auth`-gated with audit events;
    `set_admin` is single-step by design (bricking on a bad address is an accepted footgun mitigated by
    mainnet multisig+timelock per ADR-14, not in-contract two-step), and arbitrary-wasm `upgrade` is the
    intended admin power of an upgradeable custody contract — both are unreachable by any non-admin.
