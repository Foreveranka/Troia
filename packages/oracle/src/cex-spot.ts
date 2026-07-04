// Live-CEX spot oracle: the SPOT TRY/USDC mid used to price a checkout (what the user pays). Per source
// TRY/USDC = (TRY/USDT) / (USDC/USDT), derived from two CEX ticker pairs, then aggregated across Binance /
// Bybit / OKX by the pure fail-closed `aggregate` (lower-median + deviation guard + quorum). The network is
// behind an INJECTED fetch (mocked in tests, real in production); a source that can't be fetched/parsed is
// dropped fail-SAFE and the quorum still decides. Prices are parsed decimal-string -> scaled bigint so money
// never touches floating point. The offline PoC keeps DeterministicOracle; this is the mainnet-ready spot feed.

import { aggregate, deriveTryPerUsdc, RATE_SCALE } from './index.js';
import type { OraclePolicy, OracleProvider, OracleResult, SourceQuote } from './index.js';
import type { FetchLike } from './rate-history.js';

function prop(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}
function index(a: unknown, i: number): unknown {
  return Array.isArray(a) ? a[i] : undefined;
}
function reqStr(x: unknown): string {
  if (typeof x !== 'string') throw new RangeError('expected a price string in the CEX ticker payload');
  return x;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** Parse a canonical decimal price string (e.g. "40.5000", "0.9998") to an integer scaled by RATE_SCALE (1e7),
 *  truncating beyond 7 dp. Fail-closed on any non-canonical input (no float, no parseFloat salvage). */
export function parseDecimalToE7(s: string): bigint {
  if (typeof s !== 'string' || !DECIMAL.test(s)) throw new RangeError(`invalid price: ${String(s)}`);
  const parts = s.split('.');
  const intPart = parts[0] ?? '0';
  const frac = ((parts[1] ?? '') + '0000000').slice(0, 7); // pad/truncate to 7 dp
  return BigInt(intPart) * RATE_SCALE + BigInt(frac);
}

/** One exchange's ticker endpoints (TRY/USDT and USDC/USDT) + how to pull the price string from its JSON. */
export interface CexSource {
  readonly name: string;
  readonly tryUsdtUrl: string;
  readonly usdcUsdtUrl: string;
  readonly parsePrice: (payload: unknown) => string;
}

export const BINANCE_SOURCE: CexSource = {
  name: 'binance',
  tryUsdtUrl: 'https://api.binance.com/api/v3/ticker/price?symbol=USDTTRY',
  usdcUsdtUrl: 'https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT',
  parsePrice: (p) => reqStr(prop(p, 'price')),
};
export const BYBIT_SOURCE: CexSource = {
  name: 'bybit',
  tryUsdtUrl: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDTTRY',
  usdcUsdtUrl: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDCUSDT',
  parsePrice: (p) => reqStr(prop(index(prop(prop(p, 'result'), 'list'), 0), 'lastPrice')),
};
export const OKX_SOURCE: CexSource = {
  name: 'okx',
  tryUsdtUrl: 'https://www.okx.com/api/v5/market/ticker?instId=USDT-TRY',
  usdcUsdtUrl: 'https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT',
  parsePrice: (p) => reqStr(prop(index(prop(p, 'data'), 0), 'last')),
};

/** Binance + Bybit + OKX — a genuine 3-source majority for the deviation/quorum guards. */
export const DEFAULT_CEX_SOURCES: readonly CexSource[] = [BINANCE_SOURCE, BYBIT_SOURCE, OKX_SOURCE];

async function fetchPriceE7(url: string, parse: (p: unknown) => string, fetch: FetchLike): Promise<bigint> {
  const res = await fetch(url);
  return parseDecimalToE7(parse(await res.json()));
}

/** Fetch + derive one source's TRY/USDC quote. Returns null (dropped, fail-SAFE) if either pair fails. */
export async function fetchCexQuote(
  source: CexSource,
  fetch: FetchLike,
  nowMs: number,
): Promise<SourceQuote | null> {
  try {
    const tryUsdtE7 = await fetchPriceE7(source.tryUsdtUrl, source.parsePrice, fetch);
    const usdcUsdtE7 = await fetchPriceE7(source.usdcUsdtUrl, source.parsePrice, fetch);
    return { source: source.name, tryPerUsdc: deriveTryPerUsdc(tryUsdtE7, usdcUsdtE7), asOfMs: nowMs };
  } catch {
    return null; // a source that can't be fetched/parsed is dropped; `aggregate` enforces the quorum
  }
}

export interface CexOracleOptions {
  readonly policy: OraclePolicy;
  readonly sources?: readonly CexSource[]; // default: Binance + Bybit + OKX
  readonly fetch?: FetchLike; // injected in tests (a mock); defaults to global fetch
  readonly now?: () => number; // injected in tests; defaults to Date.now
}

/** The live spot mid: fetch every source, derive TRY/USDC, and aggregate fail-closed (lower-median + deviation). */
export class LiveCexOracle implements OracleProvider {
  constructor(private readonly opts: CexOracleOptions) {}

  async getRate(): Promise<OracleResult> {
    const sources = this.opts.sources ?? DEFAULT_CEX_SOURCES;
    const fetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (fetch === undefined) throw new Error('no fetch available; inject opts.fetch');
    const nowMs = (this.opts.now ?? (() => Date.now()))();
    const results = await Promise.all(sources.map((s) => fetchCexQuote(s, fetch, nowMs)));
    const quotes = results.filter((q): q is SourceQuote => q !== null);
    return aggregate(quotes, this.opts.policy, nowMs);
  }
}
