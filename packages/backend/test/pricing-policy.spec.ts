import { describe, expect, it } from 'vitest';
import { commissionBps, quoteUsdc, quoteUsdcWithPsp, applyPspPassthrough, STROOP } from '../../pricing/src/index.js';
import type { ReturnStats } from '../../pricing/src/index.js';
import { OFFLINE_DEFAULT_PRICING_POLICY } from '../src/pricing-policy.js';

// A fixed representative daily USD/TRY stat (doc-scale) so the golden bps below is deterministic.
const STATS: ReturnStats = { muDaily: 0.00055, sigmaDaily: 0.003 };

describe('pricing-policy — OFFLINE_DEFAULT_PRICING_POLICY', () => {
  it('sizes the FX-risk window against the REAL iyzico valör (~21 days), not an ad-hoc short T+n', () => {
    // iyzico single-payment settlement (blokaj/valör) is 2–21 days (worst ~28), NOT T+1 — its help center ties it
    // to volume/contract. We hold the collected TRY that whole window before we can rebalance the pool, so the
    // buffer must price 21 days of drift+shock, not 2.
    expect(OFFLINE_DEFAULT_PRICING_POLICY.commission.valorDays).toBe(21);
    expect(OFFLINE_DEFAULT_PRICING_POLICY.commission.z).toBe(1.65); // ~95% one-sided confidence
    expect(OFFLINE_DEFAULT_PRICING_POLICY.commission.marginBps).toBe(50); // 0.50% risk-independent profit
  });

  it('carries the researched iyzico single-payment PSP cost (4.29% + 0.25 TRY)', () => {
    expect(OFFLINE_DEFAULT_PRICING_POLICY.psp.rateBps).toBe(429);
    expect(OFFLINE_DEFAULT_PRICING_POLICY.psp.fixedKurus).toBe(25n);
  });

  it('golden: the policy prices a 392 bps commission for the reference stats', () => {
    // drift μ·21 = 1.155% + vol z·σ·√21 = 2.268% + margin 0.50% = 3.923% → 392 bps.
    expect(commissionBps(STATS, OFFLINE_DEFAULT_PRICING_POLICY.commission)).toBe(392);
  });

  it('REGRESSION: the 21-day buffer is materially larger than a 2-day one (guards a silent valör shortening)', () => {
    const real = commissionBps(STATS, OFFLINE_DEFAULT_PRICING_POLICY.commission);
    const short = commissionBps(STATS, { valorDays: 2, z: 1.65, marginBps: 50 });
    expect(real).toBeGreaterThan(short); // 392 vs 131 — the honest hold-window costs ~3× the buffer
  });

  it('end-to-end: quoteUsdcWithPsp under the policy nets the FX price and stays money-safe', () => {
    const mid = 467_374_000n; // 46.7374 TRY/USDC × 1e7
    const { commission, psp } = OFFLINE_DEFAULT_PRICING_POLICY;
    const q = quoteUsdcWithPsp(STROOP, mid, STATS, commission, psp);

    expect(q.spreadBps).toBe(392);
    // net is exactly the plain FX price; gross adds the PSP pass-through as a separate line.
    expect(q.netTryKurus).toBe(quoteUsdc(STROOP, mid, STATS, commission).userTryKurus);
    expect(q.userTryKurus).toBe(applyPspPassthrough(q.netTryKurus, psp).grossKurus);
    expect(q.pspCostKurus).toBeGreaterThan(0n);
    expect(q.userTryKurus).toBeGreaterThan(q.netTryKurus);

    // money-safety: after iyzico takes its cut from the gross, we still recover >= net.
    const providerCut = (q.userTryKurus * BigInt(psp.rateBps)) / 10_000n;
    expect(q.userTryKurus - providerCut - psp.fixedKurus).toBeGreaterThanOrEqual(q.netTryKurus);
  });
});
