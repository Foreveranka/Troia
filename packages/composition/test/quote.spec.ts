// makeQuoteFn: binds a live spot oracle + a daily-close history + a PricingPolicy into the backend's QuoteFn.
// Fakes let us assert the MAPPING (SettlementQuote -> backend Quote), the fresh-mid-per-quote + stats-caching
// behaviour, and both fail-closed paths — WITHOUT any network. The pricing/oracle math itself is owned by those
// packages' own tests; here we cross-check the mapping against quoteUsdcWithPsp directly.

import { describe, expect, it } from 'vitest';
import { computeReturnStats, kurusToTryString, quoteUsdcWithPsp } from '@troia/pricing';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import { OFFLINE_DEFAULT_PRICING_POLICY } from '../../backend/src/pricing-policy.js';
import { makeQuoteFn } from '../src/quote.js';

const UNIT = 10_000_000n; // 1 USDC @ 7 decimals
const MID_E7 = 405_000_000n; // 40.50 TRY/USDC (× 1e7)
const CLOSES: readonly number[] = [40.0, 40.1, 40.2, 40.15, 40.3, 40.42, 40.5]; // a gently depreciating TRY
const POLICY = OFFLINE_DEFAULT_PRICING_POLICY;

class FakeOracle implements OracleProvider {
  calls = 0;
  result: OracleResult;
  constructor(midE7: bigint) {
    this.result = { ok: true, quote: { midTryPerUsdc: midE7, sources: ['fake'], asOfMs: 0 } };
  }
  getRate(): Promise<OracleResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class FakeHistory implements RateHistoryProvider {
  calls = 0;
  constructor(
    public closes: readonly number[],
    public fail = false,
  ) {}
  dailyCloses(): Promise<readonly number[]> {
    this.calls += 1;
    return this.fail
      ? Promise.reject(new Error('history feed down'))
      : Promise.resolve(this.closes);
  }
}

function fixedClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

describe('makeQuoteFn — maps a SettlementQuote onto the backend Quote seam', () => {
  it('produces exactly quoteUsdcWithPsp(mid, computed-stats, policy) mapped to the 5 Quote fields', async () => {
    const oracle = new FakeOracle(MID_E7);
    const history = new FakeHistory(CLOSES);
    const quote = makeQuoteFn({ spotOracle: oracle, history, policy: POLICY });

    const got = await quote(UNIT);

    const stats = computeReturnStats(CLOSES);
    const sq = quoteUsdcWithPsp(UNIT, MID_E7, stats, POLICY.commission, POLICY.psp);
    expect(got).toEqual({
      userTryKurus: sq.userTryKurus,
      paidPriceTry: sq.paidPriceTry,
      appliedRateStroops: sq.appliedRateStroops,
      oracleMidE7: sq.oracleMidE7,
      spreadBps: sq.spreadBps,
    });
    // sanity: canonical "N.MM" TRY string, mid passed through verbatim, and the PSP gross-up strictly raised the
    // charged amount above the pre-PSP net (429 bps + 25 kr recovered on top of the FX-risk price).
    expect(got.paidPriceTry).toBe(kurusToTryString(sq.userTryKurus));
    expect(got.oracleMidE7).toBe(MID_E7);
    expect(got.userTryKurus).toBeGreaterThan(sq.netTryKurus);
  });

  it('scales to a multi-USDC order', async () => {
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history: new FakeHistory(CLOSES),
      policy: POLICY,
    });
    const got = await quote(25n * UNIT);
    const sq = quoteUsdcWithPsp(
      25n * UNIT,
      MID_E7,
      computeReturnStats(CLOSES),
      POLICY.commission,
      POLICY.psp,
    );
    expect(got.userTryKurus).toBe(sq.userTryKurus);
    expect(got.paidPriceTry).toBe(sq.paidPriceTry);
  });
});

describe('makeQuoteFn — freshness + caching', () => {
  it('fetches the spot mid FRESH on every quote', async () => {
    const oracle = new FakeOracle(MID_E7);
    const quote = makeQuoteFn({
      spotOracle: oracle,
      history: new FakeHistory(CLOSES),
      policy: POLICY,
    });
    await quote(UNIT);
    await quote(UNIT);
    await quote(UNIT);
    expect(oracle.calls).toBe(3);
  });

  it('caches the return stats within the TTL (history fetched once across quotes)', async () => {
    const clock = fixedClock();
    const history = new FakeHistory(CLOSES);
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history,
      policy: POLICY,
      statsTtlMs: 1000,
      now: clock.now,
    });
    await quote(UNIT);
    clock.set(999); // still inside the TTL
    await quote(UNIT);
    expect(history.calls).toBe(1);
  });

  it('refetches the return stats after the TTL expires', async () => {
    const clock = fixedClock();
    const history = new FakeHistory(CLOSES);
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history,
      policy: POLICY,
      statsTtlMs: 1000,
      now: clock.now,
    });
    await quote(UNIT);
    clock.set(1001); // past the TTL
    await quote(UNIT);
    expect(history.calls).toBe(2);
  });

  it('BOUNDED last-good: a transient failure WITHIN maxStale reuses the cached stats (quote still succeeds)', async () => {
    const clock = fixedClock();
    const history = new FakeHistory(CLOSES);
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history,
      policy: POLICY,
      statsTtlMs: 1000,
      statsMaxStaleMs: 5000,
      now: clock.now,
    });
    const first = await quote(UNIT); // computes + caches stats at t=0
    clock.set(3000); // past the TTL (refetch attempted) but within maxStale
    history.fail = true; // feed down
    const second = await quote(UNIT); // must NOT throw — reuse the last-good stats
    expect(history.calls).toBe(2); // the refetch WAS attempted
    expect(second).toEqual(first); // same mid + same (cached) stats -> identical quote
  });

  it('MONEY-SAFETY: past maxStale, a continued outage FAILS CLOSED rather than reuse stale (possibly over-charging) stats', async () => {
    const clock = fixedClock();
    const history = new FakeHistory(CLOSES);
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history,
      policy: POLICY,
      statsTtlMs: 1000,
      statsMaxStaleMs: 5000,
      now: clock.now,
    });
    await quote(UNIT); // caches stats at t=0
    clock.set(6000); // BEYOND maxStale (5000)
    history.fail = true; // feed still down
    await expect(quote(UNIT)).rejects.toThrow('history feed down'); // no wrong price on stale stats
  });
});

describe('makeQuoteFn — fail-closed', () => {
  it('rejects when the oracle cannot agree on a mid (no price -> no charge)', async () => {
    const oracle = new FakeOracle(MID_E7);
    oracle.result = { ok: false, error: new Error('DeviationExceeded') } as OracleResult;
    const quote = makeQuoteFn({
      spotOracle: oracle,
      history: new FakeHistory(CLOSES),
      policy: POLICY,
    });
    await expect(quote(UNIT)).rejects.toThrow('DeviationExceeded');
  });

  it('rejects when NO stats can ever be computed (history down from the start)', async () => {
    const quote = makeQuoteFn({
      spotOracle: new FakeOracle(MID_E7),
      history: new FakeHistory(CLOSES, true),
      policy: POLICY,
    });
    await expect(quote(UNIT)).rejects.toThrow('history feed down');
  });
});
