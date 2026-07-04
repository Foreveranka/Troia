// Historical USD/TRY daily-close provider — the DATA SOURCE for the FX-risk commission model (μ, σ are
// computed by @troia/pricing computeReturnStats from the series this returns). Kept behind a small port so the
// pure commission math never touches the network: the live Yahoo adapter takes an INJECTED fetch (so tests
// mock the network and stay offline/deterministic), and the offline PoC uses StaticRateHistory. Production can
// swap Yahoo for TCMB behind the same RateHistoryProvider port — the downstream math is identical (doc §3.1).

/** A source of chronological (oldest-first) daily USD/TRY closes. */
export interface RateHistoryProvider {
  dailyCloses(): Promise<readonly number[]>;
}

/** The minimal shape of `fetch` we depend on — injectable so tests substitute a controlled fake (a "mock"). */
export type FetchLike = (url: string) => Promise<{ json(): Promise<unknown> }>;

function prop(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}
function index(a: unknown, i: number): unknown {
  return Array.isArray(a) ? a[i] : undefined;
}

/**
 * Extract the daily close series from a Yahoo Finance chart payload (v8 `/finance/chart`). Fail-closed: throws
 * if the structure is missing, and drops null/non-finite/non-positive closes (Yahoo returns null for no-trade
 * days). Requires at least 3 valid closes so computeReturnStats has a sample variance. Pure and testable — feed
 * it a recorded response, no network.
 */
export function parseYahooChartCloses(payload: unknown): number[] {
  const result = index(prop(prop(payload, 'chart'), 'result'), 0);
  const quote0 = index(prop(prop(result, 'indicators'), 'quote'), 0);
  const close = prop(quote0, 'close');
  if (!Array.isArray(close)) throw new RangeError('Yahoo chart payload: missing indicators.quote[0].close');
  const closes = close.filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (closes.length < 3) throw new RangeError('Yahoo chart payload: fewer than 3 valid closes');
  return closes;
}

export interface YahooOptions {
  readonly symbol?: string; // default 'USDTRY=X'
  readonly range?: string; // default '6mo' (~126 daily closes, doc §3.1)
  readonly interval?: string; // default '1d'
  /** injected in tests (a mock fetch); defaults to the global fetch in production. */
  readonly fetch?: FetchLike;
}

/** Live provider: fetches the USD/TRY daily closes from Yahoo Finance and parses them fail-closed. */
export class YahooUsdTryHistory implements RateHistoryProvider {
  constructor(private readonly opts: YahooOptions = {}) {}

  async dailyCloses(): Promise<readonly number[]> {
    const symbol = this.opts.symbol ?? 'USDTRY=X';
    const range = this.opts.range ?? '6mo';
    const interval = this.opts.interval ?? '1d';
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (doFetch === undefined) throw new Error('no fetch available; inject opts.fetch');
    // Yahoo matches the symbol literally in the path (USDTRY=X); only the query values are appended.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
    const res = await doFetch(url);
    return parseYahooChartCloses(await res.json());
  }
}

/** Offline/PoC provider: returns a fixed, checked-in series (the deterministic stand-in for a live feed). */
export class StaticRateHistory implements RateHistoryProvider {
  constructor(private readonly closes: readonly number[]) {
    if (closes.length < 3) throw new RangeError('StaticRateHistory needs at least 3 closes');
  }
  async dailyCloses(): Promise<readonly number[]> {
    return this.closes;
  }
}
