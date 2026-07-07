import { describe, expect, it } from 'vitest';
import {
  BINANCE_SOURCE,
  BYBIT_SOURCE,
  LiveCexOracle,
  OKX_SOURCE,
  parseDecimalToE7,
} from '../src/index.js';
import type { FetchLike, OraclePolicy } from '../src/index.js';
import { commissionBps, priceUsdc, STROOP } from '../../pricing/src/index.js';

// The live-CEX SPOT oracle: Binance/Bybit/OKX -> derive TRY/USDC -> aggregate (fail-closed). The network is an
// INJECTED fetch, so these tests substitute a controlled fake ("mock") and run offline/deterministic.

const NOW = 1_700_000_000_000;
const POLICY: OraclePolicy = { maxAgeMs: 5_000, deviationThresholdBps: 100, minQuorum: 2 };

/** Build the per-CEX ticker JSON each source expects (the USDCUSDT price is USDT-per-USDC), with an optional
 *  exchange timestamp (Bybit top-level `time`, OKX per-ticker `ts`; Binance's /ticker/price carries none). */
function tickerFor(url: string, tryUsdt: string, usdcUsdt: string, tsMs?: number): unknown {
  const isTry = url.includes('USDTTRY') || url.includes('USDT-TRY');
  const price = isTry ? tryUsdt : usdcUsdt;
  if (url.includes('binance')) return { symbol: isTry ? 'USDTTRY' : 'USDCUSDT', price };
  if (url.includes('bybit')) return { retCode: 0, ...(tsMs !== undefined ? { time: tsMs } : {}), result: { list: [{ lastPrice: price }] } };
  if (url.includes('okx')) return { code: '0', data: [{ last: price, ...(tsMs !== undefined ? { ts: String(tsMs) } : {}) }] };
  throw new Error(`unexpected url: ${url}`);
}

/** A mock fetch that serves each CEX its ticker; `down` names sources whose fetch throws (a network failure). */
function mockFetch(
  perSource: Record<string, { tryUsdt: string; usdcUsdt: string; tsMs?: number }>,
  down: readonly string[] = [],
): FetchLike {
  return async (url) => {
    const name = url.includes('binance') ? 'binance' : url.includes('bybit') ? 'bybit' : 'okx';
    if (down.includes(name)) throw new Error(`${name} down`);
    const p = perSource[name]!;
    const body = tickerFor(url, p.tryUsdt, p.usdcUsdt, p.tsMs);
    return { json: async () => body };
  };
}

describe('cex-spot — price parsing', () => {
  it('parseDecimalToE7 scales a canonical decimal string to ×1e7, truncating beyond 7 dp', () => {
    expect(parseDecimalToE7('40.5000')).toBe(405_000_000n);
    expect(parseDecimalToE7('0.9998')).toBe(9_998_000n);
    expect(parseDecimalToE7('1')).toBe(10_000_000n);
    expect(parseDecimalToE7('46.7530')).toBe(467_530_000n);
    expect(parseDecimalToE7('1.23456789')).toBe(12_345_678n); // truncated to 7 dp (no rounding, no float)
  });

  it('parseDecimalToE7 fails closed on non-canonical input', () => {
    for (const bad of ['', ' ', '1.2.3', '1,5', 'abc', '1e3', '-1', '.5']) {
      expect(() => parseDecimalToE7(bad)).toThrow(RangeError);
    }
  });

  it('each CEX parser pulls the price string from its own ticker shape', () => {
    expect(BINANCE_SOURCE.parsePrice({ symbol: 'USDTTRY', price: '40.50' })).toBe('40.50');
    expect(BYBIT_SOURCE.parsePrice({ result: { list: [{ lastPrice: '40.51' }] } })).toBe('40.51');
    expect(OKX_SOURCE.parsePrice({ data: [{ last: '40.49' }] })).toBe('40.49');
  });
});

describe('LiveCexOracle — aggregate a spot mid across CEXes (mocked fetch, no real network)', () => {
  const sources = [BINANCE_SOURCE, BYBIT_SOURCE, OKX_SOURCE];

  it('derives TRY/USDC = (TRY/USDT)/(USDC/USDT) per source and returns the lower-median mid', async () => {
    // all three agree: TRY/USDT=40.50, USDC/USDT=1.0000 -> TRY/USDC = 40.50 -> mid 405000000
    const fetch = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.51', usdcUsdt: '1.0000' },
      okx: { tryUsdt: '40.49', usdcUsdt: '1.0000' },
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.midTryPerUsdc).toBe(405_000_000n); // lower-median of {404.9, 405.0, 405.1}
    expect(r.quote.sources).toHaveLength(3);
  });

  it('derives TRY/USDC by MULTIPLYING the tickers (TRY/USDT × USDT/USDC), not dividing', async () => {
    // 1 USDC = 1.05 USDT (USDC above USDT), 1 USDT = 40.00 TRY -> 1 USDC = 42.00 TRY. (A divide would give 38.10.)
    const fetch = mockFetch({
      binance: { tryUsdt: '40.00', usdcUsdt: '1.05' },
      bybit: { tryUsdt: '40.00', usdcUsdt: '1.05' },
      okx: { tryUsdt: '40.00', usdcUsdt: '1.05' },
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.midTryPerUsdc).toBe(420_000_000n); // 40.00 × 1.05 = 42.00
  });

  it('reflects a de-pegged USDC in the RIGHT direction (USDC below peg -> FEWER TRY per USDC)', async () => {
    // USDCUSDT ticker = USDT-per-USDC = 0.9950 (1 USDC < 1 USDT) -> TRY/USDC = 40.50 × 0.9950 < 40.50.
    // The exact reason CEX beats "assume USDC=1": the peg gap is priced in, and in the correct direction.
    const fetch = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '0.9950' },
      bybit: { tryUsdt: '40.50', usdcUsdt: '0.9950' },
      okx: { tryUsdt: '40.50', usdcUsdt: '0.9950' },
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.midTryPerUsdc).toBe(402_975_000n); // 40.50 × 0.9950 (exact) — cheaper, correctly
  });

  it('drops a source whose EXCHANGE timestamp is stale (maxAgeMs actually fires on the live path)', async () => {
    // bybit's ticker `time` is 1 hour old -> beyond maxAgeMs (5s) -> dropped; binance (no ts -> fetch time) and
    // okx (fresh ts) still meet the quorum. Before the fix, asOfMs was always the fetch time -> never stale.
    const fetch = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.50', usdcUsdt: '1.0000', tsMs: NOW - 3_600_000 },
      okx: { tryUsdt: '40.50', usdcUsdt: '1.0000', tsMs: NOW - 1_000 },
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.sources).toEqual(['binance', 'okx']); // bybit dropped as stale; quorum still met
  });

  it('survives a single source outage on the quorum (2 of 3), dropping it fail-SAFE', async () => {
    const fetch = mockFetch(
      { binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' }, bybit: { tryUsdt: '40.51', usdcUsdt: '1.0000' }, okx: { tryUsdt: '0', usdcUsdt: '0' } },
      ['okx'], // okx network failure
    );
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.sources).toEqual(['binance', 'bybit']); // okx dropped; quorum still met
  });

  it('FAILS CLOSED (InsufficientSources) when too few sources respond', async () => {
    const fetch = mockFetch({ binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' }, bybit: { tryUsdt: '0', usdcUsdt: '0' }, okx: { tryUsdt: '0', usdcUsdt: '0' } }, ['bybit', 'okx']);
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('InsufficientSources');
  });

  it('FAILS CLOSED (DeviationExceeded) when a source disagrees beyond the threshold', async () => {
    const fetch = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.51', usdcUsdt: '1.0000' },
      okx: { tryUsdt: '50.00', usdcUsdt: '1.0000' }, // way off — must not settle
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DeviationExceeded');
  });

  it('drops a source that HANGS (per-attempt timeout) instead of hanging the whole quote — quorum still decides', async () => {
    // okx hangs forever but HONORS the abort signal (as the real fetch does); binance+bybit are healthy. With a
    // short per-attempt timeout, okx is aborted -> dropped -> the 2 healthy sources still meet the quorum. Before
    // the timeout, one hung source made getRate() (and /intent) hang forever.
    const healthy = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.51', usdcUsdt: '1.0000' },
      okx: { tryUsdt: '40.49', usdcUsdt: '1.0000' },
    });
    const fetch: FetchLike = (url, init) => {
      if (url.includes('okx')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('okx hung')));
        });
      }
      return healthy(url, init);
    };
    const r = await new LiveCexOracle({
      policy: POLICY,
      sources,
      fetch,
      now: () => NOW,
      net: { timeoutMs: 25, retries: 0 },
    }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.sources).toEqual(['binance', 'bybit']); // okx aborted+dropped; quorum still met
  });

  it('recovers a source from a single transient failure via retry (net.retries) — a blip does not drop it', async () => {
    const healthy = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      okx: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
    });
    // okx's FIRST fetch (its TRY leg) throws once, then succeeds — with retries:1 the source survives the blip.
    const seen = new Map<string, number>();
    const fetch: FetchLike = async (url, init) => {
      if (url.includes('okx')) {
        const n = (seen.get(url) ?? 0) + 1;
        seen.set(url, n);
        if (n === 1) throw new Error('okx transient');
      }
      return healthy(url, init);
    };
    const r = await new LiveCexOracle({
      policy: POLICY,
      sources,
      fetch,
      now: () => NOW,
      net: { timeoutMs: 1000, retries: 1 },
    }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.quote.sources).toEqual(['binance', 'bybit', 'okx']); // okx recovered on retry -> all 3 present
  });

  it('END TO END: CEX spot mid -> commission spread -> priced order (the production wiring)', async () => {
    const fetch = mockFetch({
      binance: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      bybit: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
      okx: { tryUsdt: '40.50', usdcUsdt: '1.0000' },
    });
    const r = await new LiveCexOracle({ policy: POLICY, sources, fetch, now: () => NOW }).getRate();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.code);
    // wire the CEX mid into the same pricing path /intent uses: commission (T+15 -> 229 bps) + spread.
    const bps = commissionBps({ muDaily: 0.00055, sigmaDaily: 0.003 }, { valorDays: 15, z: 1, marginBps: 30 });
    const price = priceUsdc(STROOP, r.quote.midTryPerUsdc, bps);
    expect(bps).toBe(229);
    expect(price.userTryKurus).toBe(4142n); // 41.42 TRY for 1 USDC, priced off the live CEX mid
  });
});
