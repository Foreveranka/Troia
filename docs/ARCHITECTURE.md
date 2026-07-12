# Troia — Architecture

> Custodial TRY→USDC settlement bridge on Stellar (testnet PoC).
> A Turkish user pays TRY with a Troy card; the operator settles the merchant in USDC from a
> pre-funded Stellar pool. The spread is revenue. Positioning: _"a settlement layer that makes every
> lira accountable hash-by-hash — it never silently loses money; the one irreversible loss bucket
> (`LOSS_REVIEW`) is surfaced, never hidden."_ Honest proof boundary: **`signed ≠ settled`**.

This is the ADR-backed contract the code must satisfy. Everything network-specific is
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
The user _does_ wait (~10–45s) while the on-chain settlement chain completes — this is the finality wait
(timebounds ~45s), distinct from the compressed rebalance valör (now 30s), which the user never waits for since
the merchant is paid from the pre-funded pool.

---

## 2. The settlement ordering — the heart of money safety

Two legs with opposite reversibility:

- **USDC is irreversible** (once sent, it is gone).
- **A TRY charge is reversible** (a same-day sale can be voided).

Therefore the irreversible leg is executed **last**, only after the reversible charge is secured (money-first,
Phase 4.6):

```
1. Reserve  — reserve the pool's USDC BEFORE the customer can be charged (fail-closed 409 at /intent if it can't)
2. Charge   — iyzico direct-SALE hosted form charges the TRY (no preauth/hold; PAN never touches our servers)
3. USDC pay — ONLY after the charge is confirmed: TroyPool.pay() moves USDC pool→merchant (deterministic tx:
              order-pinned seq + narrow timebounds)
4. Confirm  — on-chain confirmation (settlement_evidence) → hand to the reconciler
```

This places the only irreversible action at the very end. The customer is **never charged unless a USDC
reservation is already held**, and USDC is **never sent on an unknown charge**. On the happy path there is never
a "sent USDC but did not secure TRY" gap.

If the USDC leg fails after the charge, the completed sale is **voided the same day** (`iyzico.cancel`), returning
the customer's TRY — a reversible unwind, not a permanent loss.

**Residual risk is not zero — it is confined to one narrow window**: USDC was sent, and the void that would
unwind the reversible charge itself repeatedly fails (its retry budget is exhausted). That order lands in
`LossReview` — surfaced, never a silent park (`GET /status` answers `review`). A charge whose USDC fate is
genuinely _unknown_ does not land here; it stays and re-polls forever rather than being routed to a manual sink
(§3's "unknown never advances" rule). On testnet no real value is at stake; the path exists to demonstrate
maturity. When a loss occurs it is **ours**, never the customer's. **`LossReview` is not itself durable** — it is
recorded in the in-memory store alongside the `OrderRow`s, so a crash while an order sits in review loses the
record (see KNOWN_ISSUES.md).

---

## 3. State machine (single source of truth)

12 states, mirrored 1:1 in code (`packages/core/src/state-machine.ts`). An independent audit corrected the table
for money-safety and reducer totality before implementation; the money-first reordering (Phase 4.6) then removed
the preauth/capture states and added the charge/reversal ones. State classes:

- **Absolute terminals** (any event → idempotent no-op): `Reconciled · FailedClean · ChargeReversed`.
- **Reversal-pending** (a completed TRY sale is being voided; `iyzico.cancel` is 3-valued —
  `reversalConfirmed → ChargeReversed`, exhausted budget → `LossReview`): `ChargeReversing`.
- **Manual sink** (USDC fate genuinely unknown, or a void that could not complete — surfaced, never silent):
  `LossReview`.
- **Awaiting-reconcile:** `UsdcConfirmed` (→ `Reconciled`; there is no capture leg anymore).

Happy path: `Reserved →(solvencyOk)→ SolvencyReserved →(chargeOk)→ UsdcSubmitted →(evidenceSuccess)→
UsdcConfirmed →(reconciled)→ Reconciled`. The in-flight USDC states (`UsdcSubmitted · UsdcPending · UsdcDead ·
UsdcReverted`) resolve the irreversible leg.

The reducer is pure and total: `transition(state, event) → {status:'transition', next, effects} | {status:'ignored'}
| {status:'rejected', reason}` — it never throws. Only table-listed transitions yield `transition`; a duplicate
event on an absolute terminal / manual sink yields `ignored` (at-least-once redelivery); an undefined pair yields
`rejected`.

Load-bearing rules (each is a test):

- **Reserve-before-charge:** solvency is reserved FIRST; the customer is never charged unless a USDC reservation
  is already held (fail-closed `409` at `/intent`).
- **USDC is last, and never on an unknown charge:** every `submitPay` edge is post-charge (see "Write-ahead"
  below for the two edges); `chargeUnknown` stays and re-polls, never submits.
- **Write-ahead:** the in-flight state (`UsdcSubmitted`) is persisted **before** the side-effecting `submitPay`.
  So a state can mean "the side effect definitely has not started yet" → safe to proceed. `submitPay` fires from
  two edges — the happy path (`SolvencyReserved`+`chargeOk`) and the reallocated-seq retry
  (`UsdcReverted`+`revertOther`) — both always preceded by `persistInFlight` in the same effect list.
- **Unknown never advances toward an irreversible action:** solvency, charge, and reversal are all 3-valued
  (OK/FAIL/Unknown). An `Unknown` result stays and re-polls (`rePollObserveOnly`, the only effect it may emit);
  it never triggers `pay()`, a charge, or a cancel. A two-valued gate before the irreversible USDC leg is a P0.
- **Deadness is hash-first, not wall-clock:** a tx is dead (safe to reallocate) only if **(1)** none of the
  order's evidence hashes is SUCCESS, **and (2)** `observed last ledger closeTime > tx.maxTime`, **and**
  `network-read account seq < S` (seq still unburned). `Date.now()` is forbidden. A burned seq means a tx
  landed (CONFIRMED or REVERTED) → not dead, no same-seq replay.
- **`UsdcDead` vs `UsdcReverted` — inverse seq behaviour:** DEAD = tx never entered, seq free → same-seq
  replacement valid (`submitReplacementSameSeq`). REVERTED = tx entered + reverted, seq burned → same-seq replay
  loops on `txBAD_SEQ` → forbidden; classify the cause (`revertAlreadyProcessed → UsdcConfirmed`;
  `revertBalanceGuard → void the sale`; `revertOther → reallocate a NEW seq`). Reconciled is reachable ONLY via
  `UsdcConfirmed`.
- **Recovery never blind-resubmits** — the poll worker's restart pass re-reads evidence and observes the chain
  before deciding anything (read-then-decide, never a blind write); only the charge→submit crash seam (charge
  done, `pay()` never sent, seq still active) uses `recoverResubmit` for a money-safe same-seq submission. It
  never re-runs a side-effect that may already have started.
- **USDC failure unwinds reversibly:** when retries are exhausted (`UsdcDead`) or USDC did not move
  (`revertBalanceGuard`), the completed sale is voided (`fireCancel` → `ChargeReversing`); only a void that
  cannot complete lands in `LossReview`.

---

## 4. Identity lineage — every key derives deterministically from one `order_id`

Three guards (memo / seq / contract) must derive from the **same identity** or they disagree
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

`seq S` is **not** a pure derivation (allocator-assigned) but is still pinned to `order_id` (`SequenceAllocator`
keys its allocation on the order id). A golden-vector fixture
(`packages/core/test/fixtures/derive-ids.golden.json`) locks the hex.

**Two shields, two DIFFERENT fields:**

- Same-seq domain (PoC): a replacement with seq S is rejected at protocol level (`txBAD_SEQ`) if the first tx
  landed — the shield is the **sequence**, the contract is never consulted.
- Different-seq domain (allocator bug / manual retry / channel accounts = Phase-2): the only shield is the
  contract's `Processed(tx_id)` (second `pay()` reverts). This is why `tx_id` derives from `order_id`, **not**
  from `tx_hash` — a different-hash second tx must collide on the same key.

---

## 5. Two Stellar entities — `TroyPool` (contract) vs `operator` (account)

| Entity     | Type                    | Role                                                               | Sequence?                                |
| ---------- | ----------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `TroyPool` | Soroban contract (`C…`) | Holds USDC custody; `pay()` moves balance inside the contract      | **None** (contracts have no seq)         |
| `operator` | Classic account (`G…`)  | Signs + submits every `pay()` tx; `operator.require_auth` identity | **Yes** (managed by `SequenceAllocator`) |

`getAccount(pool).sequence` is really `getAccount(operator).sequence`. In PoC, `require_auth` identity =
tx source = fee account = a single `operator`. The operator's single sequence space is the serialization
bottleneck → the **head-of-line** rule (one in-flight payout at a time). Phase-2 seam: channel accounts
(operator auth stays fixed; source/fee/seq move to a channel pool; `SequenceAllocator` interface unchanged).

**Payment rail is locked:** USDC payment is a `TroyPool.pay()` Soroban invocation, NOT a classic payment.
`memo` is a `pay()` argument (`BytesN<32>`), not a tx memo field.

---

## 5a. Treasury & rebalance cash-flow cycle

The pool is the **treasury**, and its refill is timed by **iyzico's settlement, not by pool drainage**. The two
legs are **asynchronous**: USDC leaves the pool **instantly** at settlement, but the matching TRY is released by
iyzico only after its **valör (blokaj)** hold — **2–21 days** (worst ~28), volume/contract-tied, _not_ the
marketed T+1. So the treasury spends now and is reimbursed ~21 days later; **rebalance can only run once iyzico
has actually paid us the held TRY** (we have no fiat to buy USDC with until then).

- **The pre-funded pool bridges the gap.** The seed USDC must cover a whole valör window of outflow before the
  first TRY returns — that is _why_ the pool is pre-funded rather than paid-as-you-go (§1), and why the merchant
  never waits for a TRY→USDC conversion.
- **Rebalance = collected-TRY → buy USDC → top up.** Only _after_ iyzico settles the held TRY can we acquire
  replacement USDC (mainnet: a real CEX buy + withdraw on the same venues the oracle reads; testnet:
  `SimulatedRebalance` mints self-issued USDC). Idempotent per `ref`; books an `EXTERNAL_FUNDING` leg (§7a), so
  the double-entry ledger stays in sync with the on-chain balance.
- **The FX-risk buffer already prices this window.** Because we pay out USDC at today's rate and re-buy ~21 days
  later at an unknown one, the commission's `z·σ·√n` term (n = the valör) is sized to that drift (invariant ⑤,
  `packages/pricing`). The "when" (~21 days) is therefore **priced in before the top-up ever runs**.

**Status (PoC).** The automatic TRY-driven rebalance loop is **built and running**. A background settlement
worker (`settleTick`, on its own `SETTLEMENT_TICK_MS` interval, default 5s) runs alongside the poll worker: each
tick **arms** every money-good order that has a durable evidence row (`UsdcConfirmed`/`Reconciled`) — with one
named exception: the `revertAlreadyProcessed → UsdcConfirmed` path deliberately writes no evidence row (§4's
two-shields rationale), so that order is never armed or refilled by this loop (KNOWN_ISSUES §4) — and, after the
settlement valör, refills the
pool from _exactly that order's_ collected TRY — converted to USDC at the live oracle rate — by minting real
issuer-signed USDC into the pool (a `SimulatedRebalance` wrapping `createSacMintClient`, the SAC-admin mint: the
programmatic form of `just bootstrap`'s mint step); `store.creditPool` then lifts the `/intent` solvency gate. The
trigger is **time/valör-driven per order**, _not_ watermark→`topUp`; the `poolLowWatermarkStroops` low-water mark
still only **warns** (`/intent → poolLow:true`). `just bootstrap` seeds the pool once, at deployment — ongoing refill
is automatic, and `just fund` never mints.

**Valör (demo).** The real iyzico settlement valör is **~21 days**; for the demo it is **compressed** to
`DEMO_VALOR_SECS` (default **30s**) so the automatic rebalance is visible within the demo window. This is demo
time-compression of the _settlement clock_ only — separate from the FX-risk pricing knob (`valorDays` = 21) that
sizes the commission, which still uses the real ~21-day figure.

**Designed for what comes next.** The rebalance system is deliberately seamed for a future **agent + on/off-ramp
service**: a policy/agent owns the _decision_ (when and how much to rebalance — the `RebalancePolicy` seam), and
an on/off-ramp provider owns the _execution_ (the real fiat↔USDC conversion — the `RebalanceProvider`/mint-port
seam). On testnet the execution is a self-issued SAC mint; on mainnet the **same seam** becomes a real CEX buy +
withdrawal driven by the agent — the backend and the money-first core do not change.

**Still Phase-2:** only the real inventory-acquiring CEX buy that _economically_ acquires the USDC (invariant ③b;
testnet mints self-issued USDC without limit) remains deferred. The cross-restart durability this paragraph once
deferred is **built** (§7b): the settlement work-list is now the durable evidence log rather than an in-memory
registry, and `ledger.hasRef(ref)` makes the top-up mint idempotent across a restart — a re-armed order cannot
mint twice.

---

## 6. Invariants (each owned by exactly one module)

| #   | Invariant                                                                                                                    | Owner                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| ①   | MEMO FAIL-CLOSED — no `PayoutIntent` without valid memo+address+trustline; button cannot be pressed                          | `packages/core` `PayoutIntent.build`        |
| ②   | DOUBLE-PAY SHIELD (USDC) — order-pinned seq (single-writer, serial) → 2nd tx = `txBAD_SEQ`                                   | `SequenceAllocator` + `TroyPool` guard      |
| ③a  | SOLVENCY MECHANISM — backend reservation AND contract `balance>=amount` (both "yes")                                         | backend + `TroyPool`                        |
| ③b  | SOLVENCY (ECONOMIC) — real inventory adequacy = Phase-2 (testnet mints infinitely)                                           | `packages/rebalance`                        |
| ④   | EVIDENCE — every submit writes hash+XDR+seq to our append-only ledger                                                        | `settlement_evidence`                       |
| ⑤   | PRICE-LOCK — the ₺ is priced server-side and frozen at `/intent`; the hosted direct-sale form charges exactly that           | `packages/pricing` computes, `core` freezes |
| ⑥   | CHARGE IDEMPOTENCY (TRY) — iyzico has no dedup → our DB-guard + backend-issued token + 3-valued retrieve on the webhook      | `packages/psp` + backend                    |
| ⑦   | SALE VOID (TRY) — a USDC failure after the charge voids the completed sale via `iyzico.cancel` (same-day) → `ChargeReversed` | `packages/psp` + backend                    |
| ⑧   | DURABLE-FIRST — a fact is appended to disk before it is believed in memory; a log failure exits the process                  | `composition` `FileAppendLog` (§7b)         |
| ⑨   | AUTHORIZED-BEFORE-SUBMIT — a `pay()` hash reaches `authorized.log` before `send`, so an unlisted outflow is theft            | `composition` `FileWriteAheadJournal` (§8a) |
| ⑩   | BOOKED OUTFLOW — the pool is credited when the payout is armed; booked-vs-chain drift alarms, never absorbs                  | `packages/ledger` + `checkDrift` (§7b)      |

**`BuildError` (flat enum, deterministic control order):**
`OrderIdMalformed → OrderIdEmpty → AddressInvalidChecksum → MemoMissing → MemoWrongLength → MemoZero →
MemoMismatch → AmountNonPositive → IssuerNotAllowlisted → TrustlineMissing`. `build(raw, ctx)` stays **pure** —
trustline is read from an injected `AccountSnapshot` (carried on `ctx`), not from the network.

`PayoutIntent.build` is **total and defensive at the trust boundary**: `RawPayout` field types are
compile-time only, so build validates runtime types too (a non-`bigint` amount, non-`string` order_id, etc.
fail closed to the matching `BuildError`) and never throws for any `raw` input. (`BuildContext` is a trusted
programmatic dependency, not the untrusted payload.)

**Charge 3-valued classifier (`classifyIyzicoResult`):** `Success → chargeOk (then submit USDC, last)` ·
`DefinitivelyNotCharged → chargeRejected (clean fail, nothing taken)` · `Unknown (5xx/timeout/reset) → STAY,
re-poll, never submit USDC`. A two-valued classifier could send the irreversible USDC on an `Unknown` charge (P0).
The success shape and the closed terminal-decline `errorCode` set are calibrated against the live iyzico sandbox
(a real charge + the published taxonomy and declining test cards, Phase 4.5); outcome-uncertain codes — system /
timeout / bank-errored / merchant-config — deliberately stay `Unknown` so a possibly-captured charge is never
wrongly failed-clean.

---

## 7. Package layout

As-built (deferred pieces are marked; the design intent for them is unchanged):

```
troia/
├── Cargo.toml                  # Rust workspace
├── package.json                # pnpm workspace root
├── pnpm-workspace.yaml
├── justfile                    # just build / test / lint / verify  (fund → Phase 4.4, demo → Phase 5.3)
├── .tool-versions
├── contracts/
│   └── troy_pool/              # single Soroban contract: pay + guard + pause + upgrade
└── packages/
    ├── config/                 # NetworkConfig — single authority, no secrets
    ├── core/                   # PayoutIntent, deriveIds, state machine, domain types
    ├── oracle/                 # deterministic median CEX rate + commission inputs (no AI)
    ├── pricing/                # userTRY = mid×(1+FX-risk+margin) grossed up for the PSP fee: (net+fixed)÷(1−rate)
    ├── ledger/                 # double-entry: fiat_in / crypto_out / spread / fee
    ├── rebalance/              # RebalanceProvider — SimulatedRebalance (testnet mint) → real-CEX (Phase-2)
    ├── psp/                    # PaymentProvider (iyzico direct-sale: sandbox → prod)
    ├── stellar-client/         # SDK wrapper: TroyPool.pay() build/submit + poll, SAC mint (rebalance), snapshot loader, Signer boundary
    ├── reconciler/             # keyless three-artifact reconciler + offline `just verify`
    ├── backend/                # the heart: state machine driver, HTTP, webhook, solvency, poll-worker, TRY-driven rebalance worker (settlement/: settleAndRebalance, pending store, policy, creditPool)
    ├── composition/            # Phase-4.5 root: real adapters + PSP-inclusive quote → ServerDeps; `just serve`
    └── integration/            # cross-package composition smoke tests

Built (Phase 5): app/storefront (5.1, the demo store emitting a USDC SEP-7) and app/extension (5.2, the MV3
"Pay with Troy card" bridge) — both proven live end-to-end (a Troy sandbox card charge auto-drove a real
`pay()`, 74 USDC settled, tx `cd643d71…`; see DEPLOYMENTS.md). Deferred, not yet built: packages/kyc (Phase-2
boundary). packages/rebalance IS built and now wired to the automatic `settleTick` rebalance loop (§5a); only
the real-CEX economic-solvency impl is Phase-2. The Signer abstraction currently lives in stellar-client (LocalKey → KMS/HSM+multisig is the
Phase-2 path).
```

Stack pins: `soroban-sdk 26.0.0`, stellar CLI 26.0.0, node 22, pnpm, `@stellar/stellar-sdk 15.1.0`. The iyzico
leg uses **no SDK** — a hand-rolled IYZWSv2 signer over `fetch`, so the money-safety failure taxonomy (a non-2xx /
timeout / unparseable body maps to UNKNOWN, never a false success) is fully ours. USDC = **7 decimals** (Stellar protocol).

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

### 7b. Durability — one append-only log, one crash contract

A fact the system uses to move money must survive the process that learned it. Every such fact is appended to a
crash-safe log **before** it is believed in memory. `packages/composition` owns the only `fs` in the system
(`file-append-log.ts`); `backend` and `ledger` still import no `node:` and no `@stellar/` module, so the money
core stays testable without a disk.

**The frame.** `L<payloadByteLen>,<crc32-8-hex>|<payload>\n`. Append = a write-all loop over `writeSync`
(`writeSync` does **not** loop on its own) followed by `fdatasyncSync`. A payload may not contain a raw newline.

**The crash contract** (three rules that make the tail the only place damage can live):

1. **The first write failure poisons the log forever.** Nothing is appended after a failed append, so a partial
   write can only ever be the _physical last_ bytes of the file. Without this rule, a later successful append
   would bury a torn record in the middle, where it is indistinguishable from corruption.
2. **A torn tail is healed and reported.** A record is a torn tail only if its frame **runs past end-of-file**.
   It is truncated, `fdatasync`ed, and surfaced as `recovered: { droppedBytes, atOffset }`.
3. **Anything else is fatal.** If the frame _fits_ inside the file, the append completed — so a bad CRC there
   means the bytes were damaged **after** they were durable. That is `DurableLogCorruption`, and the process
   refuses to boot rather than silently discard a committed record.

The subtlety worth stating: the discriminator is **not** "is there a newline after this record?" The terminating
newline is the one byte the payload CRC does not cover, so trusting it would let a single flipped byte convince
the reader to truncate a fully-committed record. Only the frame length can be trusted.

**Durable-first ordering (book-or-neither).** Every writer appends to disk before mutating memory. The fs calls
are synchronous, so `Ledger.post()` and `Store.appendEvidence()` are atomic on the event loop — no lock, no
`await` splitting the read-modify-write. A `DurableLogError` carries `code: 'DurableLogFailure'`; every worker
lets it escape and `main.ts` exits the process. (Before this, a poisoned log was swallowed into `markFailed`,
which re-minted USDC on every tick and never credited it.)

**Seven logs, under `TROIA_DATA_DIR/<troyPool-id>/`** (scoped per pool, so two deployments never share state):

| File                     | What survives                                                               | Replay policy                                                                        |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ledger-journal.log`     | every double-entry posting                                                  | torn tail healed + warned; a damaged **committed** record is fatal — refuses to boot |
| `evidence.log`           | `(orderId, txHash, signedXdr, seq, witnessedAt)` + the order's frozen facts | tolerant, deduped                                                                    |
| `authorized.log`         | every tx hash written **before** submit                                     | tolerant                                                                             |
| `chain-observations.log` | pool outflows, settlements, `upgrade()`s seen on chain                      | tolerant                                                                             |
| `reconciled.log`         | orders whose four gates passed                                              | tolerant                                                                             |
| `outflow-cursor.log`     | how far the payout tail has read                                            | last-wins                                                                            |
| `outflow-suspects.log`   | unexplained outflows (`seen` / `alarmed` / `cleared`)                       | fold                                                                                 |

The ledger replays fail-closed because a lost posting is a lost fact about money; the evidence log replays
tolerantly because it is written at-least-once by design and dedupes on `(orderId, txHash)`.

**The evidence log is the settlement work-list.** Each row carries the order's frozen facts (destination, amount,
memo, applied rate, price, spread, fee), so a settlement interrupted by a crash is still armed after restart.
Without this the payout stayed unbooked forever and the drift alarm below could never clear. Because a re-armed
order would otherwise mint a second top-up, `ledger.hasRef(ref)` gates the mint — refs derive from the order, not
from a counter, so replay is a no-op.

**Outflow booking + drift.** `recordSettlement` credits `USDC_POOL` when the payout is armed, before it is marked
pending, so the books never trail the chain. The pool's opening balance is booked once as **genesis** (valued at
the live mid, fail-closed on a dead oracle) when the journal is empty. `checkDrift` then compares booked against
observed and alarms only after **three consecutive** out-of-sync readings — booking lags reality, and one reading
proves nothing. A read failure **throws**: an alarm that goes quiet when it cannot see is worse than no alarm.

Not durable, deliberately: the operator sequence snapshot, the reservation ledger, the pending-settlement store,
and the `OrderRow`s themselves. See SCOPE §4 for exactly what a restart therefore loses and why it fails safe.

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

The report carries two top-level fields: `network.passphrase` (needed to recompute the tx hash) and
`network.operator_public` (the signer key — read as **data**, never from the mutable XDR). The operator is not
self-authenticating: `verifyReport` takes the canonical operator as an argument (`bin/verify.mjs` supplies it from
an explicit `TROIA_OPERATOR_PUBLIC`, else the committed deployment record) and fails any report naming a different
key, so a forged report cannot self-sign with its own key and pass. Field mapping:
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
`WebSocket` to throw and count attempts (darwin-portable; **not** an OS firewall). Exit 0 requires a
**positive** proof, not mere absence: a startup canary must confirm the block is armed (a deliberate
`net.connect` throws), `ordersVerified === N`, `networkAttempts === 0`, and every re-derivation matches.
Honest boundary: **`signed ≠ settled`** — the fixture tx has no Soroban footprint (`tx.ext().switch()===0`),
so it is real/verifiable/decodable but not network-submittable (Phase-4's `stellar-client` produces the
submittable XDR); and a testnet reset erases chain history, surfaced per order as `UNSETTLED`. We never claim
"settlement is provable after reset".

---

### 8a. The chain answers for itself — the payout tail and the live reconciler

§8 is the artifact a reviewer verifies offline. This is the pair of loops the **running server** uses to notice,
by itself, that the chain and the books disagree. Both read the chain; neither trusts what we announced.

**The payout tail (`tailOutflows`, `OUTFLOW_INTERVAL_MS`, default 20s)** — attribution for money leaving the pool.

- It watches the **USDC SAC's `transfer` events with `from == pool`**, not the pool's own `payment_made` event.
  `upgrade()` lets replaced contract code drain the pool without ever emitting `payment_made`; the token contract
  cannot be talked out of emitting `transfer`.
- **Why it may accuse.** The write-ahead journal (`authorized.log`) is durable and is awaited **strictly before**
  `send`. A `pay()` therefore cannot land — and so cannot emit an outflow — unless its hash was already on disk.
  An outflow whose hash is absent was **never authorized**. Not "not yet witnessed", not "still settling". There
  is no timing window to get wrong and no in-memory allowlist for a restart to erase.
- Grace (chain **close time**, never the local clock; `outflowGraceSecs`, default **60s**) is a margin, not the
  correctness mechanism. A suspect is re-judged each tick and pages exactly **once** (`ROGUE PAYOUT`). Do not
  confuse it with the reconciler's `unsettledGraceSecs` (default 600s) below — that one bounds how long an
  announced settlement may stay unobserved before `SETTLEMENT UNOBSERVABLE`.
- **Durable order per tick:** record the observation → mark the suspect → tombstone the cleared → _save the cursor
  last_. A crash mid-tick re-reads a page (harmless); a cursor advanced past an unrecorded suspect would lose a
  theft forever.
- It complements drift rather than replacing it. Drift is windowless and always right about the **total**, but
  cannot name a transaction. The tail names it, and pays for that with a window: Soroban RPC retains events for a
  rolling ~7 days **that moves**, so a tail down longer than the window has a gap. The gap is declared
  (`TAIL BLIND SPOT` / `TAIL STALLED`), never hidden, and drift covers it.

**The live reconciler (`reconcileOrders`, `RECONCILE_INTERVAL_MS`, default 30s)** — did each order's settlement
actually happen, and was it the settlement we announced?

An order finds its settlement through **`tx_id`** — the identifier the _contract_ indexes, a function of
`order_id` **alone** (§4: `sha256(lp("troia.txid.v1") ‖ lp(order_id))`) — **not** through the transaction hash we
recorded. Looking up by our own hash would only check our record against itself, which is what made
`CHAIN_DIVERGENCE` unreachable in practice.

Four gates, all of which must pass before an order is marked `Reconciled`:

1. The pool's code was **never replaced** (`upgrade()` seen ⇒ `POOL CODE REPLACED`, latched: past announcements
   stop being proofs).
2. The **announced amount equals what the token contract actually moved** (`payment_made.amount` ⇄ Σ `transfer`).
3. The transaction is **still live on chain** (`checkTxLiveness`; `ABSENT` ⇒ `UNSETTLED`).
4. `resolveGroundTruth` (§8, the same cascade) returns `MATCHED`.

An unreachable chain (`UNKNOWN`) **never concludes anything** — it re-polls. `reconciled.mark()` is written
durably **before** the order advances, so a crash between the two re-marks rather than double-advances.

**"We cannot see" is not "it is not there."** The tail durably records a **coverage floor**: the instant it began
(or, after a retention re-anchor, resumed) watching. An order witnessed before that floor settled in ledgers
nobody read, so its missing announcement is a fact about us. It is reported as `blind / never-watched`, never as
`SETTLEMENT UNOBSERVABLE`. Likewise, when we hold the pool's announcement but the RPC will no longer return the
transaction — retention, a reset, or it never landed; `NOT_FOUND` cannot tell them apart — that is
`blind / aged-out`, not an accusation. Only silence **inside** the watched window, past the grace, is an alarm.
Drift (§7b) remains the cover for value that actually went missing.

**Alarms latch.** The audit re-derives every verdict each tick, so a stuck order would otherwise restate its
problem forever, and a page repeated forever is a page nobody reads. `observeReconcile` (pure, mirroring
`observeDrift` / `observeTailHealth`) pages each order **once per problem**, keyed on _what_ is wrong — so silence
that becomes a divergence pages again — and logs one line when the problem clears. `unreachable` is deliberately
neither: it cannot raise a page, and it cannot forge an all-clear for an alarm it was unable to re-check.

RPC facts these loops are built on, measured against live testnet (protocol 27), not read from a doc: a topic
filter with the wrong arity returns an **empty page with no error** (a silent all-clear — hence contract-id-only
filters); `-32600` means **both** "below retention" and "ahead of head", so the range is probed **structurally**
rather than matched against the message text; a cursor resumes **strictly after** its ledger.

---

## 9. Keys & config boundary

Three separate keypairs even on testnet (no collapse): **admin** (`TROIA_ADMIN_SECRET`), **operator**
(`TROIA_OPERATOR_SECRET`), **issuer** (`TROIA_ISSUER_SECRET`, USDC SAC mint). Plus iyzico
(`IYZICO_API_KEY`/`IYZICO_SECRET_KEY`) and webhook (`WEBHOOK_SIGNING_SECRET`).

- `NetworkConfig` = non-secret, injected: RPC url, passphrase, `TroyPool` C-address, USDC SAC id, public
  G-addresses. Secrets = env only, git-ignored, `.env.example` placeholders in repo.
- One-time deployment (`just bootstrap`): friendbot funds XLM only; `stellar contract asset deploy` for USDC SAC;
  `mint(TroyPool_C, POOL_SEED)` directly to the contract C-address (no transfer/deposit step, no trustline).

---

## 10. Architecture Decision Records

The ADRs are summarized inline below (they are not split into separate `docs/adr/` files):

1. Stellar-only (no multi-chain).
2. Oracle deterministic, no AI — median + quorum + circuit breaker.
3. Custodial model + money-first settlement (Phase 4.6): reversible TRY charge first, irreversible USDC last; a
   post-charge USDC failure voids the same-day sale.
4. Transparent, legible pricing — four separate lines (the user only ever sees one ₺ total): oracle **mid** +
   **FX-risk commission** (μ·n + z·σ·√n, where n = the real iyzico settlement valör, ~21 days, not T+1) + fixed
   **margin**, then a **PSP cost pass-through** grossed up `(net+fixed)÷(1−rate)` so the net still covers mid+FX+margin
   after the provider's cut — gross-up, NOT addition (addition under-recovers by `rate × our-markup`). The iyzico
   rate (4.29%+0.25₺) and the valör are config knobs, swappable per ADR-9. Pricing primitive + policy are built
   and tested, and bound into the composition root (`makeQuoteFn` feeds the backend's injected `/intent` quote),
   and exercised in the live run (a real charge auto-drove a real `pay()`, 74 USDC settled).
5. Solvency = backend AND contract.
6. Memo fail-closed invariant (`PayoutIntent`, flat `BuildError`, deterministic order).
7. USDC = 7 decimals on Stellar.
8. Extension = adapter-per-gateway + manual fallback; holds no keys.
9. Every dependency behind an interface → mainnet = config swap + 3 provider impls + time-budget re-validation +
   closing the `KNOWN_ISSUES.md` `[mainnet-blocker]` gaps (chiefly a durable order store). Not turnkey.
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
17. Reconciler crypto model (empirically locked): `hash := Transaction.hash()` (real Stellar tx hash, not
    `sha256(envelope)`); pinned-operator Ed25519 over `tx.hash()` by hint; role-split verdict cascade with
    `UNSETTLED`; keyless-&-buildless `packages/reconciler` (grep-provenance guard); offline `just verify` with
    a positive-armed network block; semantic amount compare guarded by a canonical-decimal regex so `''`/`0`
    are never conflated (adversarial fix). Fixture = real Soroban `pay()` (no footprint → not submittable).
18. Durability = one append-only file log with an explicit crash contract (§7b), not a database. A poisoned log
    confines every partial write to the physical tail; a torn tail heals and reports; a bad record whose frame
    fits is fatal. Durable-first ordering makes "believed" imply "written". `packages/composition` owns the only
    `fs`, so `backend`/`ledger` stay disk-free and unit-testable. A real database is the mainnet swap, behind the
    same `DurableLog` / `Store` interfaces.
19. Detection is **chain-authoritative** (§8a): watch the SAC's `transfer` (an `upgrade()`d pool can skip
    `payment_made`), authorize by the durable write-ahead journal (so an unlisted outflow needs no grace period
    to be called theft), and reconcile an order by the contract-indexed `tx_id` rather than by the hash we
    recorded. Grace is measured in ledger close time; the local clock is never an input.
