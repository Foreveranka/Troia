import { describe, expect, it } from 'vitest';
import { applyPspPassthrough, quoteUsdcWithPsp, quoteUsdc, STROOP } from '../src/index.js';
import type { PspCost, ReturnStats } from '../src/index.js';

// iyzico's researched single-payment production cost: 4.29% + 0.25 TRY (25 kuruş). Provider-agnostic knobs.
const IYZICO: PspCost = { rateBps: 429, fixedKurus: 25n };

describe('psp-cost — applyPspPassthrough (gross-up)', () => {
  it('textbook: to net 90.00 TRY after a 10% cut, the customer pays 100.00 (not 99)', () => {
    // The whole point of gross-up: 90 / (1 − 0.10) = 100, and 10% of 100 = 10, leaving exactly 90.
    const { grossKurus, pspCostKurus } = applyPspPassthrough(9000n, {
      rateBps: 1000,
      fixedKurus: 0n,
    });
    expect(grossKurus).toBe(10_000n); // 100.00 TRY
    expect(pspCostKurus).toBe(1000n); // 10.00 TRY cut
  });

  it('golden: net 47.97 TRY through iyzico (4.29% + 0.25) → 50.39 TRY, cost 2.42', () => {
    const { grossKurus, pspCostKurus } = applyPspPassthrough(4797n, IYZICO);
    expect(grossKurus).toBe(5039n); // ceil((4797 + 25) × 10000 / 9571)
    expect(pspCostKurus).toBe(242n);
  });

  it('golden: net 41.42 TRY through iyzico → 43.54 TRY, cost 2.12', () => {
    const { grossKurus, pspCostKurus } = applyPspPassthrough(4142n, IYZICO);
    expect(grossKurus).toBe(4354n);
    expect(pspCostKurus).toBe(212n);
  });

  it('MONEY-SAFETY invariant: we recover >= net even when the provider rounds ITS OWN fee UP (ceil)', () => {
    const vectors: Array<[bigint, PspCost]> = [
      [4797n, IYZICO],
      [4142n, IYZICO],
      [1n, IYZICO],
      [0n, IYZICO],
      [100_000n, { rateBps: 356, fixedKurus: 0n }], // bank virtual POS credit (TCMB cap)
      [4797n, { rateBps: 104, fixedKurus: 0n }], // bank virtual POS debit
      [9000n, { rateBps: 1000, fixedKurus: 0n }],
      [33n, { rateBps: 1, fixedKurus: 0n }],
      [7n, { rateBps: 9999, fixedKurus: 0n }], // pathological near-100% fee
    ];
    for (const [net, psp] of vectors) {
      const { grossKurus } = applyPspPassthrough(net, psp);
      const r = BigInt(psp.rateBps);
      // The provider deducts (rateBps% of the gross) + fixed. The adversarial WORST case for us is the provider
      // rounding its OWN percentage cut UP (ceil) — it then keeps more, leaving us less; flooring is the easy
      // case. The ceil in our gross-up supplies exactly the slack to absorb a ceil cut, so we still recover net.
      const cutFloor = (grossKurus * r) / 10_000n; // provider keeps less (easy case)
      const cutCeil = (grossKurus * r + 9_999n) / 10_000n; // provider keeps more (the real downside)
      expect(grossKurus - cutFloor - psp.fixedKurus).toBeGreaterThanOrEqual(net);
      expect(grossKurus - cutCeil - psp.fixedKurus).toBeGreaterThanOrEqual(net);
    }
  });

  it('exact-arithmetic invariant: gross × (10000 − rateBps) >= (net + fixed) × 10000 (never under-recover)', () => {
    const vectors: Array<[bigint, PspCost]> = [
      [4797n, IYZICO],
      [1n, IYZICO],
      [123_456n, { rateBps: 449, fixedKurus: 25n }],
    ];
    for (const [net, psp] of vectors) {
      const { grossKurus } = applyPspPassthrough(net, psp);
      expect(grossKurus * (10_000n - BigInt(psp.rateBps))).toBeGreaterThanOrEqual(
        (net + psp.fixedKurus) * 10_000n,
      );
    }
  });

  it('identity: a zero-cost provider (0 bps, 0 fixed) leaves the price unchanged', () => {
    for (const net of [0n, 1n, 4142n, 100_000n]) {
      const { grossKurus, pspCostKurus } = applyPspPassthrough(net, { rateBps: 0, fixedKurus: 0n });
      expect(grossKurus).toBe(net);
      expect(pspCostKurus).toBe(0n);
    }
  });

  it('fixed-only fee is added straight through', () => {
    const { grossKurus, pspCostKurus } = applyPspPassthrough(1000n, {
      rateBps: 0,
      fixedKurus: 50n,
    });
    expect(grossKurus).toBe(1050n);
    expect(pspCostKurus).toBe(50n);
  });

  it('rounds the customer price UP (ceil) so the cut is always fully covered', () => {
    // net 100, 3% → 100/0.97 = 103.09… → customer pays 104 kuruş (ceil), never 103 (which would under-recover).
    const { grossKurus } = applyPspPassthrough(100n, { rateBps: 300, fixedKurus: 0n });
    expect(grossKurus).toBe(104n);
  });

  it('grows monotonically with the rate and with the fixed fee', () => {
    const base = applyPspPassthrough(10_000n, { rateBps: 200, fixedKurus: 0n }).grossKurus;
    const pricier = applyPspPassthrough(10_000n, { rateBps: 400, fixedKurus: 0n }).grossKurus;
    const withFixed = applyPspPassthrough(10_000n, { rateBps: 200, fixedKurus: 25n }).grossKurus;
    expect(pricier).toBeGreaterThan(base);
    expect(withFixed).toBeGreaterThan(base);
  });

  it('rejects an out-of-range rate, a negative fixed fee, or a negative net', () => {
    expect(() => applyPspPassthrough(1000n, { rateBps: 10_000, fixedKurus: 0n })).toThrow(
      RangeError,
    ); // 100% unrecoverable
    expect(() => applyPspPassthrough(1000n, { rateBps: -1, fixedKurus: 0n })).toThrow(RangeError);
    expect(() => applyPspPassthrough(1000n, { rateBps: 1.5, fixedKurus: 0n })).toThrow(RangeError);
    expect(() => applyPspPassthrough(1000n, { rateBps: 200, fixedKurus: -1n })).toThrow(RangeError);
    expect(() => applyPspPassthrough(-1n, { rateBps: 200, fixedKurus: 0n })).toThrow(RangeError);
  });
});

describe('psp-cost — quoteUsdcWithPsp (full server-side settlement quote)', () => {
  const STATS: ReturnStats = { muDaily: 0.00055, sigmaDaily: 0.003 };
  const PARAMS = { valorDays: 15, z: 1, marginBps: 30 };

  it('golden: prices 1 USDC (T+15 commission) then grosses up for iyzico', () => {
    const q = quoteUsdcWithPsp(STROOP, 405_000_000n, STATS, PARAMS, IYZICO);
    // FX leg is unchanged from quoteUsdc: 229 bps, applied rate, net 41.42 TRY.
    expect(q.spreadBps).toBe(229);
    expect(q.oracleMidE7).toBe(405_000_000n);
    expect(q.appliedRateStroops).toBe(414_274_500n); // PSP is a fee, NOT a worse exchange rate
    expect(q.netTryKurus).toBe(4142n); // pre-PSP amount we must net
    expect(q.pspCostKurus).toBe(212n); // the transparent PSP line
    expect(q.userTryKurus).toBe(4354n); // what the customer actually pays (grossed)
    expect(q.paidPriceTry).toBe('43.54');
  });

  it('a zero-cost provider reduces to the plain FX quote (backward compatible)', () => {
    const plain = quoteUsdc(STROOP, 405_000_000n, STATS, PARAMS);
    const q = quoteUsdcWithPsp(STROOP, 405_000_000n, STATS, PARAMS, { rateBps: 0, fixedKurus: 0n });
    expect(q.userTryKurus).toBe(plain.userTryKurus);
    expect(q.paidPriceTry).toBe(plain.paidPriceTry);
    expect(q.pspCostKurus).toBe(0n);
    expect(q.netTryKurus).toBe(plain.userTryKurus);
  });

  it('the customer price with PSP is always >= the plain FX price', () => {
    const plain = quoteUsdc(STROOP, 405_000_000n, STATS, PARAMS);
    const q = quoteUsdcWithPsp(STROOP, 405_000_000n, STATS, PARAMS, IYZICO);
    expect(q.userTryKurus).toBeGreaterThan(plain.userTryKurus);
    expect(q.netTryKurus + q.pspCostKurus).toBe(q.userTryKurus);
  });

  it('composes correctly for a multi-USDC amount (net = plain FX price, gross = its pass-through)', () => {
    const usdc = STROOP * 5n;
    const plain5 = quoteUsdc(usdc, 405_000_000n, STATS, PARAMS);
    const q = quoteUsdcWithPsp(usdc, 405_000_000n, STATS, PARAMS, IYZICO);
    expect(q.netTryKurus).toBe(plain5.userTryKurus); // net is exactly the plain 5-USDC FX price
    const { grossKurus } = applyPspPassthrough(plain5.userTryKurus, IYZICO);
    expect(q.userTryKurus).toBe(grossKurus); // gross is that net passed through the PSP
    expect(q.appliedRateStroops).toBe(plain5.appliedRateStroops); // FX rate unchanged by the PSP fee
  });
});
