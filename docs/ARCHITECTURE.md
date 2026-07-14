# Troia — Architecture

> Custodial TRY→USDC settlement bridge on Stellar (testnet PoC).
> A Turkish user pays TRY with a Troy card; the operator settles the merchant in USDC from a
> pre-funded Stellar pool. The spread is revenue. Positioning: _"a settlement layer that makes every
> lira accountable hash-by-hash — it never silently loses money; the one irreversible loss bucket
> (`LossReview`) is surfaced, never hidden."_ Honest proof boundary: **`signed ≠ settled`**.

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

**Residual risk is not zero — two windows reach the manual sink**, and both refuse to guess. (1) The USDC leg
failed and the same-day void that would unwind the completed sale itself fails repeatedly (`reversalNotDone`,
budget spent): the charge stands with nothing delivered, so a human must return it. (2) A `pay()` landed and
_reverted_ for a cause the chain will not name — paused, unreadable, unknown — and the bounded fresh-seq
re-drives are spent (`revertIndeterminate`, budget spent): the USDC fate is genuinely unknown, so the order is
parked **without** an automatic refund, because refunding a possibly-settled order is the worse error. Both land
in `LossReview`, and both surface (`GET /status` answers `review`). On testnet no real value is at stake; the
path exists to demonstrate maturity. When a loss occurs it is **ours**, never the customer's. **`LossReview` is not itself durable** — it is
recorded in the in-memory store alongside the `OrderRow`s, so a crash while an order sits in review loses the
record (see KNOWN_ISSUES.md).

---

## 3. Package layout

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
    ├── backend/                # the heart: state machine driver, HTTP, webhook, solvency, poll-worker, TRY-driven rebalance worker (settlement/: settleAndRebalance, pending store, rebalance policy, drift/outflow/reconcile workers; store/: creditPool)
    ├── composition/            # Phase-4.5 root: real adapters + PSP-inclusive quote → ServerDeps; `just serve`
    └── integration/            # cross-package composition smoke tests

Built (Phase 5): app/storefront (5.1, the demo store emitting a USDC SEP-7) and app/extension (5.2, the MV3
"Pay with Troy card" bridge) — both proven live end-to-end (a Troy sandbox card charge auto-drove a real
`pay()`; see DEPLOYMENTS.md). Deferred, not yet built: packages/kyc (Phase-2
boundary). packages/rebalance IS built and now wired to the automatic `settleTick` rebalance loop (§6a); only
the real-CEX economic-solvency impl is Phase-2. The Signer abstraction currently lives in stellar-client (LocalKey → KMS/HSM+multisig is the
Phase-2 path).
```

Stack pins: `soroban-sdk 26.0.0`, stellar CLI 26.0.0, node 22, pnpm, `@stellar/stellar-sdk 15.1.0`. The iyzico
leg uses **no SDK** — a hand-rolled IYZWSv2 signer over `fetch`, so the money-safety failure taxonomy (a non-2xx /
timeout / unparseable body maps to UNKNOWN, never a false success) is fully ours. USDC = **7 decimals** (Stellar protocol).

### 3a. Accounting ledger (`packages/ledger`) — double-entry, distinct from `ledger_evidence`

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

### 3b. Durability — one append-only log, one crash contract

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
| `reconciled.log`         | orders whose five gates passed                                              | tolerant                                                                             |
| `outflow-cursor.log`     | how far the payout tail has read                                            | last-wins                                                                            |
| `outflow-suspects.log`   | unexplained outflows (`seen` / `alarmed` / `cleared`)                       | fold                                                                                 |

The ledger replays fail-closed because a lost posting is a lost fact about money; the evidence log replays
tolerantly because it is written at-least-once by design and dedupes on `(orderId, txHash)`.

**The evidence log is the settlement work-list.** Each row carries the order's frozen facts (destination, amount,
memo, applied rate, price, spread, fee), so a settlement interrupted by a crash is still armed after restart.
Without this the payout stayed unbooked forever and the drift alarm below could never clear. Because a re-armed
order would otherwise mint a second top-up, `ledger.hasRef(ref)` gates the mint — refs derive from the order, not
from a counter, so replaying a **booked** top-up is a no-op. The gate only closes when the booking lands, and the
mint runs first: the window between the two is still open (KNOWN_ISSUES §2).

**Outflow booking + drift.** `recordSettlement` credits `USDC_POOL` when the payout is armed, before it is marked
pending, so the books never trail the chain. The pool's opening balance is booked once as **genesis** (valued at
the live mid, fail-closed on a dead oracle) when the journal is empty. `checkDrift` then compares booked against
observed and alarms only after **three consecutive** out-of-sync readings — booking lags reality, and one reading
proves nothing. A read failure **throws**: an alarm that goes quiet when it cannot see is worse than no alarm.

Not durable, deliberately: the operator sequence snapshot, the reservation ledger, the pending-settlement store,
and the `OrderRow`s themselves. See SCOPE §4 for exactly what a restart therefore loses and why it fails safe.

---

## 4. State machine (single source of truth)

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
event on an absolute terminal / manual sink — or a non-reconciler event on `UsdcConfirmed` — yields `ignored`
(at-least-once redelivery); every other undefined pair yields `rejected`.

Load-bearing rules (each is a test):

- **Reserve-before-charge:** solvency is reserved FIRST; the customer is never charged unless a USDC reservation
  is already held (fail-closed `409` at `/intent`).
- **USDC is last, and never on an unknown charge:** every `submitPay` edge is post-charge (see "Write-ahead"
  below for the two edges); `chargeUnknown` stays and re-polls, never submits.
- **Write-ahead:** the in-flight state (`UsdcSubmitted`) is persisted **before** the side-effecting `submitPay`.
  So a state can mean "the side effect definitely has not started yet" → safe to proceed. `submitPay` fires from
  two edges — the happy path (`SolvencyReserved`+`chargeOk`) and the reallocated-seq retry
  (`UsdcReverted`+`revertIndeterminate`) — both always preceded by `persistInFlight` in the same effect list.
- **Unknown never advances toward an irreversible action:** solvency, charge, and reversal are all 3-valued
  (OK/FAIL/Unknown). An `Unknown` result stays and re-polls (`rePollObserveOnly`, the only effect it may emit);
  it never triggers `pay()`, a charge, or a cancel. A two-valued gate before the irreversible USDC leg is a P0.
- **Deadness is hash-first, not wall-clock:** a tx is dead (safe to reallocate) only if **(1)** the in-flight
  tx's own hash does not look up as SUCCESS, **and (2)** `observed last ledger closeTime > tx.maxTime`, **and**
  `network-read account seq < S` (seq still unburned). `Date.now()` is forbidden. A burned seq means a tx
  landed (CONFIRMED or REVERTED) → not dead, no same-seq replay; that branch is also what fail-closes an
  aged-out success the hash lookup can no longer see.
- **`UsdcDead` vs `UsdcReverted` — inverse seq behaviour:** DEAD = tx never entered, seq free → same-seq
  replacement valid (`submitReplacementSameSeq`). REVERTED = tx entered + reverted, seq burned → same-seq replay
  loops on `txBAD_SEQ` → forbidden; classify the cause (`revertAlreadyProcessed → UsdcConfirmed`;
  `revertBalanceGuard → void the sale`; `revertIndeterminate → reallocate a NEW seq` — the bounded retry counter
  keeps the legacy name `maxRevertOtherRetries`). Reconciled is reachable ONLY via `UsdcConfirmed`.
- **Recovery never blind-resubmits** — the poll worker's restart pass re-reads evidence and observes the chain
  before deciding anything (read-then-decide, never a blind write); only the charge→submit crash seam (charge
  done, `pay()` never sent, seq still active) uses `recoverResubmit` for a money-safe same-seq submission. It
  never re-runs a side-effect that may already have started.
- **USDC failure unwinds reversibly:** when retries are exhausted (`UsdcDead`) or USDC did not move
  (`revertBalanceGuard`), the completed sale is voided (`fireCancel` → `ChargeReversing`). Two edges reach
  `LossReview`: a void that cannot complete (`reversalNotDone`, budget spent), and a landed-and-reverted `pay()`
  whose cause stays indeterminate (`revertIndeterminate`, budget spent) — the latter is parked with **no** refund
  precisely because the USDC fate is unknown. A third quarantine (a burned-but-unproven seq) has no core event to
  transition on, so it records a **loss flag** and keeps its in-flight state instead. That flag is load-bearing: the
  poll worker's work-list skips a flagged order (recovery must never re-drive one), and `/status` and `/receipt`
  read it as an override and answer `review` — so a quarantine that cannot move the state machine still surfaces to
  the customer, and to a human, exactly like one that can. It is one-way by construction: the webhook's guard
  accepts only `SolvencyReserved`, and the live reconciler works from the evidence log, which such an order never
  reached.

---

## 5. Identity lineage — every key derives deterministically from one `order_id`

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

## 6. Two Stellar entities — `TroyPool` (contract) vs `operator` (account)

| Entity     | Type                    | Role                                                               | Sequence?                                |
| ---------- | ----------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `TroyPool` | Soroban contract (`C…`) | Holds USDC custody; `pay()` moves balance inside the contract      | **None** (contracts have no seq)         |
| `operator` | Classic account (`G…`)  | Signs + submits every `pay()` tx; `operator.require_auth` identity | **Yes** (managed by `SequenceAllocator`) |

`getAccount(pool).sequence` is really `getAccount(operator).sequence`. In PoC, `require_auth` identity =
tx source = fee account = a single `operator`. The operator's single sequence space is the serialization
bottleneck → the **head-of-line** rule (one in-flight payout at a time), enforced by Stellar's strict sequence
ordering — not by a lock here (the backend's mutex is per-order). Phase-2 seam: channel accounts
(operator auth stays fixed; source/fee/seq move to a channel pool; `SequenceAllocator` interface unchanged).

**Late allocation, and why its crash window is not a gap.** The sequence is handed out on `chargeOk`, not at
`/intent` — so an abandoned checkout consumes none and the operator account stays gap-free. A crash between the
charge and the submit is **money-safe** (the `Processed(tx_id)` guard and the single-use sequence each cap
delivery at one per order) and **self-heals** for a completed charge: recovery re-retrieves the sale, `chargeOk`
fires again, and the idempotent `allocate()` returns the same sequence. The only residual — a sequence stranded
in `ACTIVE` with no order to claim it — is not reachable here, because the same crash that would strand it also
wipes the in-memory sequence store, and the allocator re-bootstraps from the live on-chain sequence on restart. A
durable sequence store would close it for good, by reconciling from `activeSeqFor(orderId)` during recovery.

**Payment rail is locked:** USDC payment is a `TroyPool.pay()` Soroban invocation, NOT a classic payment.
`memo` is a `pay()` argument (`BytesN<32>`), not a tx memo field.

---

## 6a. Treasury & rebalance cash-flow cycle

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
  `SimulatedRebalance` mints self-issued USDC). Idempotent per `ref`; books an `EXTERNAL_FUNDING` leg (§3a), so
  the double-entry ledger stays in sync with the on-chain balance.
- **The FX-risk buffer already prices this window.** Because we pay out USDC at today's rate and re-buy ~21 days
  later at an unknown one, the commission's `z·σ·√n` term (n = the valör) is sized to that drift (invariant ⑤,
  `packages/pricing`). The "when" (~21 days) is therefore **priced in before the top-up ever runs**.

**Status (PoC).** The automatic TRY-driven rebalance loop is **built and running**. A background settlement
worker (`settleTick`, on its own `SETTLEMENT_TICK_MS` interval, default 5s) runs alongside the poll worker: each
tick **arms** every money-good order that has a durable evidence row (`UsdcConfirmed`/`Reconciled`) — with one
named exception: the `revertAlreadyProcessed → UsdcConfirmed` path deliberately writes no evidence row, because a
reverted transaction's hash must never become a witness (§4), so that order is never armed or refilled by this
loop — and, after the settlement valör, refills the
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

**Still Phase-2:** (a) the real inventory-acquiring CEX buy that _economically_ acquires the USDC (invariant ③b;
testnet mints self-issued USDC without limit), and (b) **cross-restart mint idempotency**. The settlement
work-list is now the durable evidence log rather than an in-memory registry (§3b), and `ledger.hasRef(ref)` — a
durable set rebuilt from the journal at boot — stops a re-armed order from minting twice **once its top-up has
been booked**. The mint runs before that booking, so a crash between the mint landing and `ledger.recordTopUp`
leaves it landed-and-unbooked, and the re-armed order mints again; `SimulatedRebalance`'s dedup cache is
in-memory and does not survive the restart. Money-safe on testnet (self-issued USDC; the drift is positive and
alarms), a mainnet blocker — see KNOWN_ISSUES §2.

---

## 7. Invariants (each owned by exactly one module)

| #   | Invariant                                                                                                                    | Owner                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| ①   | MEMO FAIL-CLOSED — no `PayoutIntent` without valid memo+address+trustline; button cannot be pressed                          | `packages/core` `PayoutIntent.build`                         |
| ②   | DOUBLE-PAY SHIELD (USDC) — order-pinned seq (single-writer, serial) → 2nd tx = `txBAD_SEQ`                                   | `SequenceAllocator` + `TroyPool` guard                       |
| ③a  | SOLVENCY MECHANISM — backend reservation AND contract `balance>=amount` (both "yes")                                         | backend + `TroyPool`                                         |
| ③b  | SOLVENCY (ECONOMIC) — real inventory adequacy = Phase-2 (testnet mints infinitely)                                           | `packages/rebalance`                                         |
| ④   | EVIDENCE — every submit writes hash+XDR+seq to our append-only ledger                                                        | `settlement_evidence`                                        |
| ⑤   | PRICE-LOCK — the ₺ is priced server-side and frozen at `/intent`; the hosted direct-sale form charges exactly that           | `packages/pricing` computes, `core` freezes                  |
| ⑥   | CHARGE IDEMPOTENCY (TRY) — iyzico has no dedup → our DB-guard + backend-issued token + 3-valued retrieve on the webhook      | `packages/psp` + backend                                     |
| ⑦   | SALE VOID (TRY) — a USDC failure after the charge voids the completed sale via `iyzico.cancel` (same-day) → `ChargeReversed` | `packages/psp` + backend                                     |
| ⑧   | DURABLE-FIRST — a fact is appended to disk before it is believed in memory; a log failure exits the process                  | `composition` `FileAppendLog` (§3b)                          |
| ⑨   | AUTHORIZED-BEFORE-SUBMIT — a `pay()` hash reaches `authorized.log` before `send`, so an unlisted outflow is theft            | `composition` `FileWriteAheadJournal` (RECONCILIATION.md §8) |
| ⑩   | BOOKED OUTFLOW — the pool is credited when the payout is armed; booked-vs-chain drift alarms, never absorbs                  | `packages/ledger` + `checkDrift` (§3b)                       |

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

**Webhook authenticity has a stated limit.** `X-IYZ-SIGNATURE-V3` is an HMAC over a **concatenation of parsed
fields** (the account secret key is both the HMAC key and the leading field) — **not** a hash of the raw body. A
valid signature therefore proves that iyzico sent _those fields_; it authenticates nothing else in the payload, and
it never proves the payment outcome. That is why the webhook is only a wake-up: the backend re-retrieves the sale
server-side and classifies **that** result, never the webhook's own `status` field (invariant ⑥).

---

## 8. Reconciliation — the reviewer-verifiable centerpiece

Per order, three independent records prove settlement: **(a) `business_intent`** — the mutable local row, what we
requested; **(b) `ledger_evidence`** — the frozen signed XDR + its real Stellar tx hash, what we signed, never
re-serialized from (a); **(c) `chain_evidence`** — the frozen chain snapshot, what settled. The reconciler
(`packages/reconciler`) is **keyless & buildless by construction** (it imports `@stellar/stellar-base` only to
decode and verify, never to sign), so it recomputes every verdict from the embedded evidence with no network and no
key — pinned to an operator **and** a canonical `TroyPool` supplied from _outside_ the report, so neither a forged
signer nor a look-alike contract can pass.

The running server also reconciles itself against the live chain each tick. The live reconciler finds each
settlement by the contract-indexed `tx_id` (§5, a function of `order_id` alone — never the hash we recorded), then
gates `Reconciled` on four further checks: the pool's code was never replaced; the announced amount equals what the
token contract moved; the tx is still live; and `resolveGroundTruth` returns `MATCHED`. An unreachable chain
**never concludes anything** — it re-polls, never guesses. A payout tail independently flags any pool outflow whose
hash was never write-ahead-journalled as a `ROGUE PAYOUT`.

**The full model — the three-artifact detail, the `resolveGroundTruth` verdict cascade, the offline `just verify`
proof, and the two live loops (payout tail + reconciler, coverage, alarm latching, RPC facts) — is in
[`RECONCILIATION.md`](RECONCILIATION.md).**

---

## 9. Keys & config boundary

Three separate keypairs even on testnet (no collapse): **admin** (`TROIA_ADMIN_SECRET`), **operator**
(`TROIA_OPERATOR_SECRET`), **issuer** (`TROIA_ISSUER_SECRET`, USDC SAC mint). Plus iyzico
(`IYZICO_API_KEY`/`IYZICO_SECRET_KEY`) and webhook (`WEBHOOK_SIGNING_SECRET`). The server itself reads only the
operator and issuer secrets; **no runtime code reads `TROIA_ADMIN_SECRET`** — it exists for `just bootstrap` and
CLI-driven admin ops (pause / upgrade / set-operator) through the `stellar` keystore.

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
   and exercised in the live run (a real charge auto-drove a real `pay()`; see DEPLOYMENTS.md).
5. Solvency = backend AND contract.
6. Memo fail-closed invariant (`PayoutIntent`, flat `BuildError`, deterministic order).
7. USDC = 7 decimals on Stellar.
8. Extension = adapter-per-gateway, fail-closed (shows nothing unless every check passes); holds no keys.
9. Every dependency behind an interface → mainnet = config swap + 3 provider impls + time-budget re-validation +
   closing the `KNOWN_ISSUES.md` `[mainnet-blocker]` gaps (a durable order store, a write-ahead journal on the
   refill mint). Not turnkey.
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
18. Durability = one append-only file log with an explicit crash contract (§3b), not a database. A poisoned log
    confines every partial write to the physical tail; a torn tail heals and reports; a bad record whose frame
    fits is fatal. Durable-first ordering makes "believed" imply "written". `packages/composition` owns the only
    `fs`, so `backend`/`ledger` stay disk-free and unit-testable. A real database is the mainnet swap, behind the
    same `DurableLog` / `Store` interfaces.
19. Detection is **chain-authoritative** (RECONCILIATION.md §8): watch the SAC's `transfer` (an `upgrade()`d pool can skip
    `payment_made`), authorize by the durable write-ahead journal (so an unlisted outflow needs no grace period
    to be called theft), and reconcile an order by the contract-indexed `tx_id` rather than by the hash we
    recorded. Grace is measured in ledger close time; the local clock is never an input.
