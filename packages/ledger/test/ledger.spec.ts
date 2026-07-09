import { describe, expect, it } from 'vitest';
import {
  Ledger,
  LedgerError,
  STROOP,
  KURUS_PER_TRY,
  type Leg,
  type LedgerErrorCode,
  type JournalEntry,
} from '../src/index.js';

/** Assert `fn` throws a LedgerError with the given code (stronger than a message regex). */
function expectCode(fn: () => unknown, code: LedgerErrorCode): void {
  expect(fn).toThrowError(LedgerError);
  try {
    fn();
  } catch (err) {
    expect((err as LedgerError).code).toBe(code);
  }
}

// Golden order (matches @troia/pricing): 1 USDC @ 40.50 TRY mid, 150 bps spread.
// user pays 4110 kuruş, spread revenue 60 kuruş, so the USDC leg is valued at 4050 kuruş (the mid).
const ONE_USDC = STROOP; // 10_000_000n stroops
const USER = 4110n;
const SPREAD = 60n;
const BASE = 4050n; // USER - SPREAD

function sumKurus(legs: readonly Leg[]): bigint {
  return legs.reduce((s, l) => s + l.kurus, 0n);
}

describe('ledger — constants', () => {
  it('STROOP is 1e7 (Stellar 7 decimals) and KURUS_PER_TRY is 100', () => {
    expect(STROOP).toBe(10_000_000n);
    expect(KURUS_PER_TRY).toBe(100n);
  });
});

describe('ledger — recordSettlement (double-entry balances)', () => {
  it('golden order: fiat_in == crypto_out(at mid) + spread, entry balances', () => {
    const l = new Ledger();
    const e = l.recordSettlement({
      orderId: 'ord-1',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    expect(e.seq).toBe(0);
    expect(e.kind).toBe('SETTLEMENT');
    expect(sumKurus(e.debits)).toBe(sumKurus(e.credits)); // balanced
    expect(sumKurus(e.debits)).toBe(USER);

    expect(l.balanceKurus('FIAT_CASH')).toBe(USER); // asset up (debit)
    expect(l.balanceKurus('USDC_POOL')).toBe(-BASE); // asset out (credit)
    expect(l.totalSpreadRevenueKurus()).toBe(SPREAD);
    // native USDC actually left the pool
    expect(l.nativeBalance('USDC_POOL')).toBe(-ONE_USDC);
  });

  it('the USDC leg carries native stroops but is valued in kuruş (multi-currency)', () => {
    const l = new Ledger();
    const e = l.recordSettlement({
      orderId: 'o',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    const usdcLeg = e.credits.find((c) => c.account === 'USDC_POOL');
    expect(usdcLeg?.native).toBe(ONE_USDC); // stroops
    expect(usdcLeg?.kurus).toBe(BASE); // TRY value at mid
  });

  it('spread 0 → no spread leg, still balances (fiat_in == crypto_out)', () => {
    const l = new Ledger();
    const e = l.recordSettlement({
      orderId: 'o',
      usdcStroops: ONE_USDC,
      userTryKurus: BASE,
      spreadKurus: 0n,
    });
    expect(e.credits.some((c) => c.account === 'SPREAD_REVENUE')).toBe(false);
    expect(sumKurus(e.debits)).toBe(sumKurus(e.credits));
    expect(l.totalSpreadRevenueKurus()).toBe(0n);
  });

  it('a PSP fee is booked as an expense; FIAT_CASH nets the fee out and the entry still balances', () => {
    const l = new Ledger();
    const FEE = 40n;
    const e = l.recordSettlement({
      orderId: 'o',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
      feeKurus: FEE,
    });
    expect(l.balanceKurus('FIAT_CASH')).toBe(USER - FEE); // net cash received
    expect(l.balanceKurus('PSP_FEE')).toBe(FEE); // expense (debit)
    expect(sumKurus(e.debits)).toBe(sumKurus(e.credits));
    expect(sumKurus(e.debits)).toBe(USER);
  });
});

describe('ledger — recordTopUp (pool funding)', () => {
  it('a top-up debits the pool (native USDC up) against EXTERNAL_FUNDING and balances', () => {
    const l = new Ledger();
    const HUNDRED = STROOP * 100n;
    const e = l.recordTopUp({ ref: 'topup-1', usdcStroops: HUNDRED, valueKurus: 405_000n });
    expect(e.kind).toBe('TOPUP');
    expect(l.nativeBalance('USDC_POOL')).toBe(HUNDRED);
    expect(l.balanceKurus('EXTERNAL_FUNDING')).toBe(-405_000n); // credit
    expect(sumKurus(e.debits)).toBe(sumKurus(e.credits));
  });
});

describe('ledger — drift detection (on-chain is source of truth)', () => {
  const build = () => {
    const l = new Ledger();
    l.recordTopUp({ ref: 'topup-1', usdcStroops: STROOP * 100n, valueKurus: 405_000n });
    l.recordSettlement({
      orderId: 'ord-1',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    return l; // expected pool = 100 - 1 = 99 USDC
  };
  const EXPECTED = STROOP * 99n;

  it('matching on-chain balance → inSync, zero drift', () => {
    const r = build().detectDrift(EXPECTED);
    expect(r.expectedPoolStroops).toBe(EXPECTED);
    expect(r.observedPoolStroops).toBe(EXPECTED);
    expect(r.driftStroops).toBe(0n);
    expect(r.inSync).toBe(true);
  });

  it('a positive drift (chain has more than the ledger recorded) is flagged', () => {
    const r = build().detectDrift(EXPECTED + 1n);
    expect(r.driftStroops).toBe(1n);
    expect(r.inSync).toBe(false);
  });

  it('a negative drift (chain has less — possible loss) is flagged', () => {
    const r = build().detectDrift(EXPECTED - 1n);
    expect(r.driftStroops).toBe(-1n);
    expect(r.inSync).toBe(false);
  });
});

describe('ledger — append-only & global trial balance', () => {
  it('assigns monotonic seq and preserves order', () => {
    const l = new Ledger();
    l.recordTopUp({ ref: 't1', usdcStroops: STROOP * 10n, valueKurus: 40_500n });
    l.recordSettlement({
      orderId: 'a',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    l.recordSettlement({
      orderId: 'b',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    expect(l.all().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(l.all().map((e) => e.ref)).toEqual(['t1', 'a', 'b']);
  });

  it('the returned journal is a snapshot — pushing to it does not grow the ledger', () => {
    const l = new Ledger();
    l.recordSettlement({
      orderId: 'a',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    const snapshot = l.all() as JournalEntry[];
    snapshot.push({ seq: 99, ref: 'evil', kind: 'SETTLEMENT', debits: [], credits: [] });
    expect(l.all()).toHaveLength(1); // internal journal untouched
  });

  it('stored entries are frozen at runtime — a retained leg reference cannot unbalance them', () => {
    const l = new Ledger();
    l.recordTopUp({ ref: 't', usdcStroops: STROOP * 10n, valueKurus: 40_500n });
    const before = l.nativeBalance('USDC_POOL');
    const leg = l.all()[0]!.credits[0]! as { native: bigint };
    expect(() => {
      leg.native = 999n; // frozen → throws in strict mode (ESM is strict)
    }).toThrow();
    expect(l.nativeBalance('USDC_POOL')).toBe(before); // balances unchanged regardless
  });

  it('the global trial balance is always exactly zero (every entry balances)', () => {
    const l = new Ledger();
    l.recordTopUp({ ref: 't', usdcStroops: STROOP * 50n, valueKurus: 202_500n });
    for (let i = 0; i < 25; i++) {
      l.recordSettlement({
        orderId: `ord-${i}`,
        usdcStroops: ONE_USDC * BigInt(i + 1),
        userTryKurus: USER * BigInt(i + 1),
        spreadKurus: SPREAD * BigInt(i + 1),
        feeKurus: BigInt(i % 3), // some with fees, some without
      });
    }
    expect(l.trialBalanceKurus()).toBe(0n);
    // and every individual entry balances
    for (const e of l.all()) {
      expect(sumKurus(e.debits)).toBe(sumKurus(e.credits));
    }
  });
});

describe('ledger — fail-closed guards', () => {
  it('post rejects an unbalanced entry', () => {
    const l = new Ledger();
    expectCode(
      () =>
        l.post({
          ref: 'x',
          kind: 'SETTLEMENT',
          debits: [{ account: 'FIAT_CASH', native: 100n, kurus: 100n }],
          credits: [{ account: 'SPREAD_REVENUE', native: 99n, kurus: 99n }],
        }),
      'Unbalanced',
    );
  });

  it('post rejects a non-positive leg amount', () => {
    const l = new Ledger();
    expectCode(
      () =>
        l.post({
          ref: 'x',
          kind: 'TOPUP',
          debits: [{ account: 'USDC_POOL', native: 0n, kurus: 100n }],
          credits: [{ account: 'EXTERNAL_FUNDING', native: 100n, kurus: 100n }],
        }),
      'NonPositiveAmount',
    );
  });

  it('post rejects a TRY-native leg whose functional value != native (valuation mismatch)', () => {
    const l = new Ledger();
    expectCode(
      () =>
        l.post({
          ref: 'x',
          kind: 'SETTLEMENT',
          // FIAT_CASH is a TRY account: native kuruş must equal functional kuruş.
          debits: [{ account: 'FIAT_CASH', native: 100n, kurus: 101n }],
          credits: [{ account: 'SPREAD_REVENUE', native: 101n, kurus: 101n }],
        }),
      'ValuationMismatch',
    );
  });

  it('post rejects an empty debit or credit side', () => {
    const l = new Ledger();
    expectCode(
      () => l.post({ ref: 'x', kind: 'SETTLEMENT', debits: [], credits: [] }),
      'EmptyEntry',
    );
  });

  it('a duplicate ref is rejected (append-only, no double-recording)', () => {
    const l = new Ledger();
    l.recordSettlement({
      orderId: 'dup',
      usdcStroops: ONE_USDC,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    expectCode(
      () =>
        l.recordSettlement({
          orderId: 'dup',
          usdcStroops: ONE_USDC,
          userTryKurus: USER,
          spreadKurus: SPREAD,
        }),
      'DuplicateRef',
    );
  });

  it('recordSettlement rejects economically invalid input', () => {
    const l = new Ledger();
    // spread cannot exceed what the user paid (base would be <= 0)
    expect(() =>
      l.recordSettlement({
        orderId: 'a',
        usdcStroops: ONE_USDC,
        userTryKurus: 100n,
        spreadKurus: 100n,
      }),
    ).toThrowError(LedgerError);
    // non-positive USDC out
    expect(() =>
      l.recordSettlement({
        orderId: 'b',
        usdcStroops: 0n,
        userTryKurus: USER,
        spreadKurus: SPREAD,
      }),
    ).toThrowError(LedgerError);
    // negative fee
    expect(() =>
      l.recordSettlement({
        orderId: 'c',
        usdcStroops: ONE_USDC,
        userTryKurus: USER,
        spreadKurus: SPREAD,
        feeKurus: -1n,
      }),
    ).toThrowError(LedgerError);
  });
});
