import { describe, expect, it } from 'vitest';
import {
  deriveIds,
  deriveMemo,
  PayoutIntent,
  SequenceAllocator,
  InMemorySequenceStore,
  transition,
  initialState,
  isAbsoluteTerminal,
  type State,
  type Event,
  type BuildContext,
} from '../../core/src/index.js';
import { aggregate, type OraclePolicy, type SourceQuote } from '../../oracle/src/index.js';
import { priceUsdc, STROOP } from '../../pricing/src/index.js';
import { Ledger } from '../../ledger/src/index.js';

// Faz 1.7 — COMPOSITION smoke test. One happy-path order is threaded through the whole money core,
// module to module: deriveIds → PayoutIntent.build → SequenceAllocator → state machine → oracle →
// pricing → ledger → drift. This proves the SEAMS (one module's output is the next's valid input,
// and they agree on identity and units) — NOT that each module is individually correct (each package
// owns that). It reads roughly like the settlement orchestration the Phase-4 backend will perform.

const ORDER_ID = 'troia-smoke-0001';
// Reused valid StrKeys (checksum-valid; the same vectors the core suites use). The build() call is
// self-validating: an invalid address would fail closed as AddressInvalidChecksum and fail this test.
const DESTINATION = 'GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN';
const ISSUER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const USDC_OUT = STROOP; // 1 USDC owed to the merchant

const NOW = 1_000_000;
const POLICY: OraclePolicy = { maxAgeMs: 5_000, deviationThresholdBps: 100, minQuorum: 3 };
const q = (source: string, tryPerUsdc: bigint): SourceQuote => ({ source, tryPerUsdc, asOfMs: NOW });

// The happy path through the reducer: PreAuth → solvency → USDC confirmed → capture → reconciled.
const HAPPY_PATH: readonly Event[] = [
  { type: 'preauthOk' },
  { type: 'solvencyOk' },
  { type: 'evidenceSuccess' },
  { type: 'captureWriteAhead' },
  { type: 'captureSuccess' },
  { type: 'reconciled' },
];

/** Fold events through the pure reducer, asserting every step is a real (table-listed) transition. */
function drive(events: readonly Event[]): { state: State; effects: readonly string[] } {
  let { state } = initialState(); // Reserved (+ firePreauth)
  const effects: string[] = [];
  for (const e of events) {
    const r = transition(state, e);
    expect(r.status, `event ${e.type} in ${state}`).toBe('transition');
    if (r.status !== 'transition') throw new Error('unreachable');
    effects.push(...r.effects);
    state = r.next;
  }
  return { state, effects };
}

describe('integration — one order through the whole money core', () => {
  it('threads deriveIds→build→allocate→FSM→oracle→pricing→ledger to a coherent settlement', () => {
    // (1) IDENTITY — one order_id yields the canonical memo/tx_id/idempotency_key.
    const ids = deriveIds(ORDER_ID, DESTINATION, USDC_OUT);

    // (2) INTENT — fail-closed build; the memo is threaded FROM the derived identity.
    const ctx: BuildContext = {
      snapshot: { exists: true, trustlines: [{ assetCode: 'USDC', assetIssuer: ISSUER }] },
      allowedIssuers: [ISSUER],
    };
    const built = PayoutIntent.build(
      { orderId: ORDER_ID, destination: DESTINATION, amount: USDC_OUT, assetIssuer: ISSUER, memo: ids.memoHex },
      ctx,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(`build failed: ${built.error}`);
    const intent = built.value.fields;
    // Seam (determinism side): build re-derived the SAME identity and froze the amount we pay on-chain.
    // NOTE: these are consistency checks — that build ACTUALLY validates the memo against the order is
    // proven by the second `it` below (a wrong memo → MemoMismatch), which is the real fail-closed seam.
    expect(intent.ids).toEqual(ids);
    expect(Buffer.from(intent.memo).toString('hex')).toBe(ids.memoHex);
    expect(intent.amount).toBe(USDC_OUT);

    // (3) SEQUENCE — DB-authoritative, idempotent per CANONICAL order id.
    const alloc = new SequenceAllocator(new InMemorySequenceStore(), 1000n);
    const seq = alloc.allocate(intent.orderId);
    expect(seq).toBe(1001n);
    expect(alloc.allocate(ORDER_ID)).toBe(seq); // same order → same seq (no second burn)

    // (4) STATE MACHINE — the pure reducer is EVENT-driven, so this section is control-flow-threaded,
    // not data-coupled to the order (data-coupling arrives with the Phase-4 orchestrator that produces
    // these events from real calls). What it does prove: the happy path reaches the absolute terminal,
    // and the K1 ordering invariant holds — the USDC-moving effect (submitPay) STRICTLY precedes the
    // capture effect (firePostauth), i.e. capture is last so float is zero.
    const run = drive(HAPPY_PATH);
    expect(run.state).toBe('Reconciled');
    expect(isAbsoluteTerminal(run.state)).toBe(true);
    expect(run.effects).toContain('submitPay');
    expect(run.effects.indexOf('firePostauth')).toBeGreaterThan(run.effects.indexOf('submitPay'));

    // (5) ORACLE — deterministic mid from an agreeing trio (fail-closed otherwise). The trio is
    // ASYMMETRIC on purpose: median(403,405,408)=405.00 but mean=405.33, so pinning mid to 405.00
    // discriminates the actual (lower-median order statistic) contract from a mean — a symmetric trio
    // would let a mean-based oracle pass silently. All three are within 100 bps of the median.
    const rate = aggregate([q('a', 403_000_000n), q('b', 405_000_000n), q('c', 408_000_000n)], POLICY, NOW);
    expect(rate.ok).toBe(true);
    if (!rate.ok) throw new Error(`oracle failed: ${rate.error.code}`);
    const mid = rate.quote.midTryPerUsdc;
    expect(mid).toBe(405_000_000n); // 40.50 TRY/USDC — the median element, NOT the 405.33 mean

    // (6) PRICING — the oracle mid feeds transparent spread pricing.
    const price = priceUsdc(USDC_OUT, mid, 150);
    expect(price.userTryKurus).toBe(4110n); // 41.10 TRY
    expect(price.spreadRevenueKurus).toBe(60n); // 0.60 TRY margin

    // (7) LEDGER — book the settlement straight from the pricing outputs; double-entry balances.
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'pool-seed', usdcStroops: STROOP * 100n, valueKurus: 405_000n }); // fund 100 USDC
    const entry = ledger.recordSettlement({
      orderId: intent.orderId,
      usdcStroops: intent.amount,
      userTryKurus: price.userTryKurus,
      spreadKurus: price.spreadRevenueKurus,
    });
    expect(entry.ref).toBe(intent.orderId); // ledger keyed by the SAME identity used everywhere
    expect(ledger.totalSpreadRevenueKurus()).toBe(60n);
    expect(ledger.trialBalanceKurus()).toBe(0n);

    // (8) DRIFT — on-chain truth (100 funded − 1 paid = 99 USDC) matches the ledger.
    const expectedPool = STROOP * 99n;
    const drift = ledger.detectDrift(expectedPool);
    expect(drift.expectedPoolStroops).toBe(expectedPool);
    expect(drift.inSync).toBe(true);
  });

  it('fails closed across the seam: a tampered memo stops the order at build, before any money machinery', () => {
    const ctx: BuildContext = {
      snapshot: { exists: true, trustlines: [{ assetCode: 'USDC', assetIssuer: ISSUER }] },
      allowedIssuers: [ISSUER],
    };
    const wrongMemo = deriveMemo('a-different-order'); // valid shape (32 non-zero bytes), wrong value
    const built = PayoutIntent.build(
      { orderId: ORDER_ID, destination: DESTINATION, amount: USDC_OUT, assetIssuer: ISSUER, memo: wrongMemo },
      ctx,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toBe('MemoMismatch');
    // Composition guarantee: no PayoutIntent → nothing to allocate a seq for, nothing to settle. The
    // fail-closed gate protects everything downstream of it.
  });
});
