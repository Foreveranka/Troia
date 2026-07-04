import { describe, expect, it } from 'vitest';
import {
  aggregate,
  deriveTryPerUsdc,
  DeterministicOracle,
  RATE_SCALE,
  type OraclePolicy,
  type SourceQuote,
} from '../src/index.js';

const NOW = 1_000_000;
// The tight threshold is the safety lever; production policy also requires a real 3-source majority.
const P: OraclePolicy = { maxAgeMs: 5_000, deviationThresholdBps: 100, minQuorum: 2 };
const MAJORITY: OraclePolicy = { ...P, minQuorum: 3 };

function q(source: string, tryPerUsdc: bigint, ageMs = 0): SourceQuote {
  return { source, tryPerUsdc, asOfMs: NOW - ageMs };
}

describe('oracle — RATE_SCALE & deriveTryPerUsdc', () => {
  it('RATE_SCALE is 1e7 (must match pricing)', () => expect(RATE_SCALE).toBe(10_000_000n));
  it('TRY/USDC == TRY/USDT when USDC == USDT', () =>
    expect(deriveTryPerUsdc(400_000_000n, RATE_SCALE)).toBe(400_000_000n));
  it('a stronger USDC yields fewer TRY per USDC', () =>
    expect(deriveTryPerUsdc(405_000_000n, 10_002_000n)).toBeLessThan(405_000_000n));
  it('rejects non-positive USDC/USDT', () => expect(() => deriveTryPerUsdc(1n, 0n)).toThrow(RangeError));
});

describe('oracle — settles only on tight agreement', () => {
  it('accepts a tightly-agreeing trio at the lower-median order statistic', () => {
    const r = aggregate([q('a', 404_800_000n), q('b', 405_000_000n), q('c', 405_200_000n)], P, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quote.midTryPerUsdc).toBe(405_000_000n);
      expect(r.quote.sources).toHaveLength(3);
    }
  });

  it('the accepted mid is always a real quote within [min, max] of the healthy sources', () => {
    const r = aggregate([q('a', 399_000_000n), q('b', 400_000_000n), q('c', 401_000_000n)], P, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quote.midTryPerUsdc).toBeGreaterThanOrEqual(399_000_000n);
      expect(r.quote.midTryPerUsdc).toBeLessThanOrEqual(401_000_000n);
    }
  });

  it('a band-edge trio that all agree within the threshold settles at the median', () => {
    const wide: OraclePolicy = { ...P, deviationThresholdBps: 300 };
    const r = aggregate([q('a', 388_000_000n), q('b', 400_000_000n), q('c', 412_000_000n)], wide, NOW);
    expect(r.ok && r.quote.midTryPerUsdc).toBe(400_000_000n);
  });
});

describe('oracle — fail-closed on ANY disagreement (no manipulable subset settlement)', () => {
  it('a single out-of-band source fails closed instead of dropping it and settling on the rest', () => {
    const r = aggregate([q('a', 405_000_000n), q('b', 405_200_000n), q('c', 450_000_000n)], P, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DeviationExceeded');
  });

  it('one source beyond the threshold of the band-edge trio fails closed', () => {
    const wide: OraclePolicy = { ...P, deviationThresholdBps: 300 };
    const edge = [q('a', 388_000_000n), q('b', 400_000_000n), q('c', 412_000_000n)];
    const r = aggregate([...edge, q('x', 420_000_000n)], wide, NOW); // 420 is 5% > 3% from the median
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DeviationExceeded');
  });
});

describe('oracle — no single source manipulates settlement (3-source majority)', () => {
  // Honest trio agreeing within 100bps of 400. This is an ODD majority, the oracle's intended mode.
  const HONEST = [q('a', 399_000_000n), q('b', 400_000_000n), q('c', 401_000_000n)];

  it('an out-of-band injected source can never produce a settlement (fail-closed)', () => {
    for (const x of [450_000_000n, 350_000_000n, 405_000_000n, 395_000_000n]) {
      expect(aggregate([...HONEST, q('x', x)], P, NOW).ok).toBe(false);
    }
  });

  it('no in-band injected source can push the settlement above the honest median (never overcharge)', () => {
    for (const x of [399_500_000n, 400_500_000n, 401_000_000n, 403_000_000n, 400_000_000n]) {
      const r = aggregate([...HONEST, q('x', x)], P, NOW);
      if (r.ok) expect(r.quote.midTryPerUsdc).toBeLessThanOrEqual(400_000_000n);
    }
  });
});

describe('oracle — fail-closed guards', () => {
  it('below minQuorum → InsufficientSources', () => {
    const r = aggregate([q('a', 405_000_000n)], P, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });

  it('minQuorum=3 requires a real 3-source majority (2 healthy is not enough)', () => {
    const r = aggregate([q('a', 400_000_000n), q('b', 400_100_000n)], MAJORITY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });

  it('a stale source is dropped; the remaining healthy majority still settles', () => {
    const r = aggregate(
      [q('a', 400_000_000n), q('b', 400_100_000n), q('c', 399_900_000n, 9_999)],
      P,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote.sources).not.toContain('c');
  });

  it('too many stale sources → InsufficientSources', () => {
    const r = aggregate(
      [q('a', 400_000_000n, 9_999), q('b', 400_100_000n, 9_999), q('c', 399_900_000n)],
      MAJORITY,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });

  it('non-positive prices are unhealthy', () => {
    const r = aggregate([q('a', 400_000_000n), q('b', 0n), q('c', -1n)], P, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });
});

describe('oracle — staleness rejects a FUTURE / forward-skewed timestamp (round-2 hardening)', () => {
  // q(src, price, -ageMs) stamps asOfMs = NOW + ageMs — a future observation. Staleness must gate a source that
  // lies about its own freshness, not accept it as "fresh" just because now - asOf is negative (<= maxAgeMs).
  it('a future-dated source is dropped as unhealthy (below quorum → InsufficientSources)', () => {
    const r = aggregate([q('a', 400_000_000n), q('b', 400_000_000n, -10_000)], P, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });

  it('a future-dated source is excluded while the fresh majority still settles', () => {
    const r = aggregate(
      [q('a', 400_000_000n), q('b', 400_100_000n), q('c', 399_900_000n, -3_600_000)],
      P,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote.sources).not.toContain('c'); // future 'c' dropped; a+b meet the quorum
  });
});

describe('oracle — quorum counts DISTINCT sources, not entries (round-2 hardening)', () => {
  it('duplicate same-source quotes do NOT satisfy minQuorum with a single real feed', () => {
    const r = aggregate([q('binance', 400_000_000n), q('binance', 400_000_000n)], P, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources'); // 2 entries but 1 distinct source < minQuorum(2)
  });

  it('a duplicated source is collapsed to one — it neither pads the quorum nor double-weights the median', () => {
    // {binance:402, binance:402, okx:400} → distinct {binance:402, okx:400}; lower-median of [400,402] = 400.
    const r = aggregate(
      [q('binance', 402_000_000n), q('binance', 402_000_000n), q('okx', 400_000_000n)],
      P,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quote.sources).toHaveLength(2); // deduped, not 3
      expect(r.quote.midTryPerUsdc).toBe(400_000_000n); // lower-median of the DISTINCT pair, not 402 (double-weighted)
    }
  });
});

describe('oracle — DeterministicOracle provider', () => {
  it('resolves to the aggregate result', async () => {
    const oracle = new DeterministicOracle(
      [q('a', 399_000_000n), q('b', 400_000_000n), q('c', 401_000_000n)],
      P,
      NOW,
    );
    const r = await oracle.getRate();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote.midTryPerUsdc).toBe(400_000_000n);
  });
});
