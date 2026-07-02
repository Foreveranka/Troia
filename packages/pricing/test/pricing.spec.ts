import { describe, expect, it } from 'vitest';
import { applySpread, priceUsdc, BPS_DENOM, RATE_SCALE, STROOP } from '../src/index.js';

describe('pricing — constants', () => {
  it('RATE_SCALE matches the oracle (1e7) and STROOP is 1e7', () => {
    expect(RATE_SCALE).toBe(10_000_000n);
    expect(STROOP).toBe(10_000_000n);
    expect(BPS_DENOM).toBe(10_000n);
  });
});

describe('pricing — applySpread', () => {
  it('adds the spread in basis points', () => {
    expect(applySpread(405_000_000n, 150)).toBe(411_075_000n); // 40.50 × 1.015
  });
  it('spread 0 is a no-op', () => {
    expect(applySpread(405_000_000n, 0)).toBe(405_000_000n);
  });
  it('rejects a negative or non-integer spread', () => {
    expect(() => applySpread(1n, -1)).toThrow(RangeError);
    expect(() => applySpread(1n, 1.5)).toThrow(RangeError);
  });
});

describe('pricing — priceUsdc', () => {
  it('golden: 1 USDC at 40.50 TRY with 150 bps spread', () => {
    const p = priceUsdc(STROOP, 405_000_000n, 150); // 1 USDC
    expect(p.appliedRateTryPerUsdc).toBe(411_075_000n);
    expect(p.userTryKurus).toBe(4110n); // 41.10 TRY (rounded DOWN from 41.1075)
    expect(p.spreadRevenueKurus).toBe(60n); // 0.60 TRY margin, ~1.5% of 40.50
  });

  it('spread 0 → user pays the base and revenue is zero', () => {
    const p = priceUsdc(STROOP, 405_000_000n, 0);
    expect(p.userTryKurus).toBe(4050n);
    expect(p.spreadRevenueKurus).toBe(0n);
  });

  it('userTRY is rounded DOWN (user-favorable) and revenue is never negative', () => {
    const p = priceUsdc(STROOP, 405_000_000n, 150);
    // exact would be 4110.75 kuruş; user pays 4110 (floor)
    expect(p.userTryKurus).toBe(4110n);
    expect(p.spreadRevenueKurus).toBeGreaterThanOrEqual(0n);
  });

  it('scales linearly with amount', () => {
    const one = priceUsdc(STROOP, 405_000_000n, 0);
    const ten = priceUsdc(STROOP * 10n, 405_000_000n, 0);
    expect(ten.userTryKurus).toBe(one.userTryKurus * 10n);
  });

  it('rejects non-positive amount or rate', () => {
    expect(() => priceUsdc(0n, 405_000_000n, 150)).toThrow(RangeError);
    expect(() => priceUsdc(-1n, 405_000_000n, 150)).toThrow(RangeError);
    expect(() => priceUsdc(STROOP, 0n, 150)).toThrow(RangeError);
  });
});
