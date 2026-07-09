import { describe, expect, it } from 'vitest';
import { parseYahooChartCloses, StaticRateHistory, YahooUsdTryHistory } from '../src/index.js';
import type { FetchLike } from '../src/index.js';
import { commissionBps, computeReturnStats } from '../../pricing/src/index.js';

// The commission model's DATA SOURCE: real USD/TRY daily closes -> computeReturnStats -> μ, σ -> commission.
// The live Yahoo adapter takes an INJECTED fetch, so these tests substitute a controlled fake ("mock") and
// run fully offline/deterministic — the same adapter hits the real endpoint in production.

/** Build a minimal Yahoo v8 `/finance/chart` payload with the given close series (null = a no-trade day). */
function yahooPayload(closes: readonly (number | null)[]): unknown {
  return {
    chart: {
      result: [{ timestamp: closes.map((_, i) => i), indicators: { quote: [{ close: closes }] } }],
      error: null,
    },
  };
}

describe('rate-history — Yahoo USD/TRY daily-close data source', () => {
  it('parseYahooChartCloses extracts the closes and drops null / no-trade days', () => {
    expect(parseYahooChartCloses(yahooPayload([40.0, null, 40.5, 41.0, null, 40.8]))).toEqual([
      40.0, 40.5, 41.0, 40.8,
    ]);
  });

  it('parseYahooChartCloses fails closed on a malformed payload or too few valid closes', () => {
    expect(() => parseYahooChartCloses({})).toThrow(RangeError);
    expect(() => parseYahooChartCloses({ chart: { result: [] } })).toThrow(RangeError);
    expect(() => parseYahooChartCloses(yahooPayload([40.0, null]))).toThrow(RangeError); // < 3 valid
    expect(() => parseYahooChartCloses(yahooPayload([40, -1, 0]))).toThrow(RangeError); // no positive trio
  });

  it('YahooUsdTryHistory calls the right endpoint via an INJECTED (mocked) fetch — no real network hit', async () => {
    let requestedUrl = '';
    const closes = [40.0, 40.5, 40.2, 41.0, 40.8];
    // the MOCK: it stands in for the real network — captures the URL and returns a CONTROLLED response.
    const mockFetch: FetchLike = async (url) => {
      requestedUrl = url;
      return { json: async () => yahooPayload(closes) };
    };

    const got = await new YahooUsdTryHistory({ fetch: mockFetch }).dailyCloses();

    expect(requestedUrl).toContain('/v8/finance/chart/USDTRY=X'); // the real Yahoo chart endpoint + symbol
    expect(requestedUrl).toContain('range=6mo'); // ~126 daily closes (doc §3.1)
    expect(requestedUrl).toContain('interval=1d');
    expect(got).toEqual(closes);
  });

  it('recovers from a transient network failure via retry (net.retries) — the live fetch is bounded + resilient', async () => {
    const closes = [40.0, 40.5, 40.2, 41.0, 40.8];
    let attempts = 0;
    const flaky: FetchLike = async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient reset');
      return { json: async () => yahooPayload(closes) };
    };
    const got = await new YahooUsdTryHistory({
      fetch: flaky,
      net: { timeoutMs: 1000, retries: 1 },
    }).dailyCloses();
    expect(got).toEqual(closes); // second attempt served the data -> a single blip does not fail the quote
    expect(attempts).toBe(2);
  });

  it('StaticRateHistory returns its fixed series (the offline PoC data source)', async () => {
    expect(await new StaticRateHistory([40.0, 40.5, 40.2]).dailyCloses()).toEqual([
      40.0, 40.5, 40.2,
    ]);
    expect(() => new StaticRateHistory([40])).toThrow(RangeError); // needs >= 3
  });

  it('END TO END: real-shaped data -> computeReturnStats -> commission is DATA-DRIVEN (not a constant)', async () => {
    const params = { valorDays: 15, z: 1, marginBps: 30 };
    // a CALM and a TENSE 126-day series (same drift, different volatility) delivered via the mocked provider
    const calm: number[] = [];
    const tense: number[] = [];
    let a = 40;
    let b = 40;
    for (let i = 0; i < 126; i++) {
      a *= 1 + 0.0005 + 0.001 * Math.sin(i);
      calm.push(a);
      b *= 1 + 0.0005 + 0.012 * Math.sin(i);
      tense.push(b);
    }
    const fetchOf =
      (closes: readonly number[]): FetchLike =>
      async () => ({ json: async () => yahooPayload(closes) });

    const calmCloses = await new YahooUsdTryHistory({ fetch: fetchOf(calm) }).dailyCloses();
    const tenseCloses = await new YahooUsdTryHistory({ fetch: fetchOf(tense) }).dailyCloses();
    const calmBps = commissionBps(computeReturnStats(calmCloses), params);
    const tenseBps = commissionBps(computeReturnStats(tenseCloses), params);

    expect(calmBps).toBeGreaterThan(0);
    expect(tenseBps).toBeGreaterThan(calmBps); // a more volatile market prices a HIGHER commission — from the DATA
  });
});
