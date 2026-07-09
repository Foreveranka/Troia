import { describe, expect, it } from 'vitest';
import {
  commission,
  commissionBps,
  computeReturnStats,
  kurusToTryString,
  quoteUsdc,
  STROOP,
} from '../src/index.js';
import type { ReturnStats } from '../src/index.js';

// Golden inputs from komisyon-modeli.docx §4: μ=0.055%/day, σ=0.30%/day, z=1, margin=0.30% (30 bps).
const DOC_STATS: ReturnStats = { muDaily: 0.00055, sigmaDaily: 0.003 };
const P = (valorDays: number) => ({ valorDays, z: 1, marginBps: 30 });

describe('commission — the FX-risk model (komisyon-modeli.docx §4)', () => {
  it('reproduces the published table exactly at T+1, T+15, T+30', () => {
    const t1 = commission(DOC_STATS, P(1));
    expect(t1.driftPct).toBeCloseTo(0.055, 3);
    expect(t1.volPct).toBeCloseTo(0.3, 3);
    expect(t1.marginPct).toBeCloseTo(0.3, 3);
    expect(t1.totalPct).toBeCloseTo(0.655, 3); // doc: %0.66
    expect(t1.bps).toBe(66);

    const t15 = commission(DOC_STATS, P(15));
    expect(t15.driftPct).toBeCloseTo(0.825, 3);
    expect(t15.volPct).toBeCloseTo(1.162, 3);
    expect(t15.totalPct).toBeCloseTo(2.28689, 4); // doc: %2.29
    expect(t15.bps).toBe(229);

    const t30 = commission(DOC_STATS, P(30));
    expect(t30.driftPct).toBeCloseTo(1.65, 3);
    expect(t30.volPct).toBeCloseTo(1.643, 3);
    expect(t30.totalPct).toBeCloseTo(3.59317, 4); // doc: %3.59 — round-to-nearest reproduces it exactly
    expect(t30.bps).toBe(359);
  });

  it('commissionBps returns the breakdown bps (the only value that leaves the model)', () => {
    for (const n of [1, 15, 30]) {
      expect(commissionBps(DOC_STATS, P(n))).toBe(commission(DOC_STATS, P(n)).bps);
    }
  });

  it('short valör is volatility-dominated; by T+30 drift overtakes the buffer (the crossover, doc §4)', () => {
    const t1 = commission(DOC_STATS, P(1));
    expect(t1.volPct).toBeGreaterThan(t1.driftPct); // T+1: the shock buffer dwarfs the drift
    const t30 = commission(DOC_STATS, P(30));
    expect(t30.driftPct).toBeGreaterThan(t30.volPct); // T+30: linear drift has overtaken the √n buffer
  });

  it('grows monotonically with the valör (longer wait = more risk = more commission)', () => {
    let prev = -1;
    for (const n of [1, 5, 15, 30, 60]) {
      const bps = commissionBps(DOC_STATS, P(n));
      expect(bps).toBeGreaterThan(prev);
      prev = bps;
    }
  });

  it('rises with volatility (σ) and with the confidence z; margin is a hard floor', () => {
    const calm = commissionBps({ muDaily: 0.00055, sigmaDaily: 0.0015 }, P(15));
    const tense = commissionBps({ muDaily: 0.00055, sigmaDaily: 0.008 }, P(15));
    expect(tense).toBeGreaterThan(calm); // "market tenses -> commission rises on its own" (doc §2)

    const z1 = commissionBps(DOC_STATS, { valorDays: 15, z: 1, marginBps: 30 });
    const z165 = commissionBps(DOC_STATS, { valorDays: 15, z: 1.65, marginBps: 30 });
    expect(z165).toBeGreaterThan(z1); // more protection appetite -> a bigger buffer

    // zero risk (σ=0, μ=0) -> the commission is exactly the margin (the fee floor)
    expect(
      commissionBps({ muDaily: 0, sigmaDaily: 0 }, { valorDays: 10, z: 1, marginBps: 30 }),
    ).toBe(30);
  });

  it('clamps a degenerate negative total to 0 bps (never a negative spread)', () => {
    // TRY strongly APPRECIATING (μ<0) with no buffer/margin -> the raw model is negative -> clamp to 0
    expect(
      commissionBps({ muDaily: -0.01, sigmaDaily: 0 }, { valorDays: 10, z: 0, marginBps: 0 }),
    ).toBe(0);
  });

  it('rejects a non-integer / < 1 valör, a negative z, or a negative / non-integer margin', () => {
    expect(() => commissionBps(DOC_STATS, { valorDays: 0, z: 1, marginBps: 30 })).toThrow(
      RangeError,
    );
    expect(() => commissionBps(DOC_STATS, { valorDays: 1.5, z: 1, marginBps: 30 })).toThrow(
      RangeError,
    );
    expect(() => commissionBps(DOC_STATS, { valorDays: 10, z: -1, marginBps: 30 })).toThrow(
      RangeError,
    );
    expect(() => commissionBps(DOC_STATS, { valorDays: 10, z: 1, marginBps: -5 })).toThrow(
      RangeError,
    );
    expect(() => commissionBps(DOC_STATS, { valorDays: 10, z: 1, marginBps: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('computeReturnStats — μ, σ from a daily USD/TRY close series (doc §3.2–3.4)', () => {
  it('computes the sample mean and sample std-dev of the log-returns', () => {
    // independently computed (node) from the log-returns of the series:
    const s = computeReturnStats([40.0, 40.5, 40.2, 41.0, 40.8]);
    expect(s.muDaily).toBeCloseTo(0.004950656824, 9);
    expect(s.sigmaDaily).toBeCloseTo(0.01321317119, 9);
  });

  it('a symmetric up-down series has ~zero drift and positive volatility', () => {
    const s = computeReturnStats([100, 101, 100]);
    expect(s.muDaily).toBeCloseTo(0, 12);
    expect(s.sigmaDaily).toBeCloseTo(0.014071892843, 9);
  });

  it('feeds the model end to end on a ~6-month-sized series -> monotonic, positive commission', () => {
    // deterministic synthetic USD/TRY closes (~126 daily): a mild depreciation drift + a bounded oscillation.
    // Production swaps this for a real feed (Yahoo USDTRY=X / TCMB); the math is unchanged (doc §3.1).
    const closes: number[] = [];
    for (let i = 0; i < 126; i++) closes.push(40 * Math.exp(0.0006 * i + 0.004 * Math.sin(i)));
    const s = computeReturnStats(closes);
    expect(Number.isFinite(s.muDaily)).toBe(true);
    expect(s.sigmaDaily).toBeGreaterThan(0);
    expect(commissionBps(s, P(1))).toBeGreaterThan(0);
    expect(commissionBps(s, P(30))).toBeGreaterThan(commissionBps(s, P(1)));
  });

  it('rejects a too-short or non-positive series (log-return undefined / no sample variance)', () => {
    expect(() => computeReturnStats([40, 41])).toThrow(RangeError); // < 3 closes
    expect(() => computeReturnStats([40, 0, 41])).toThrow(RangeError); // non-positive close
    expect(() => computeReturnStats([40, -1, 41])).toThrow(RangeError);
  });
});

describe('quoteUsdc / kurusToTryString — server-side price (commission + spread)', () => {
  it('kurusToTryString formats kuruş as a canonical 2-dp TRY string', () => {
    expect(kurusToTryString(4142n)).toBe('41.42');
    expect(kurusToTryString(4050n)).toBe('40.50');
    expect(kurusToTryString(5n)).toBe('0.05');
    expect(kurusToTryString(100n)).toBe('1.00');
    expect(kurusToTryString(0n)).toBe('0.00');
    expect(() => kurusToTryString(-1n)).toThrow(RangeError);
  });

  it('quoteUsdc prices 1 USDC at the spot mid with the T+15 commission (229 bps)', () => {
    const stats: ReturnStats = { muDaily: 0.00055, sigmaDaily: 0.003 };
    const q = quoteUsdc(STROOP, 405_000_000n, stats, { valorDays: 15, z: 1, marginBps: 30 });
    expect(q.spreadBps).toBe(229);
    expect(q.oracleMidE7).toBe(405_000_000n);
    expect(q.appliedRateStroops).toBe(414_274_500n); // 40.50 × 1.0229
    expect(q.userTryKurus).toBe(4142n);
    expect(q.paidPriceTry).toBe('41.42');
  });

  it('quoteUsdc is data-driven: a more volatile market prices a higher paidPrice for the same USDC', () => {
    const calm = quoteUsdc(
      STROOP,
      405_000_000n,
      { muDaily: 0.00055, sigmaDaily: 0.0015 },
      { valorDays: 15, z: 1, marginBps: 30 },
    );
    const tense = quoteUsdc(
      STROOP,
      405_000_000n,
      { muDaily: 0.00055, sigmaDaily: 0.008 },
      { valorDays: 15, z: 1, marginBps: 30 },
    );
    expect(tense.spreadBps).toBeGreaterThan(calm.spreadBps);
    expect(tense.userTryKurus).toBeGreaterThan(calm.userTryKurus);
  });
});
