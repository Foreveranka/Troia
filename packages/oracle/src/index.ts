// Deterministic FX oracle (ADR-2: no AI). The network is NOT here — quotes are injected and a live-CEX
// OracleProvider impl arrives in Phase 4. Per source TRY/USDC = (TRY/USDT) × (USDT/USDC). All prices are
// bigint scaled by RATE_SCALE (fixed-point; money never touches floating point). Fail-closed: an
// under-quorum or over-deviation read returns an error, never a guessed price. See troia-olay-orgusu.md §7.

export const RATE_SCALE = 10_000_000n; // a rate of X TRY-per-USDC is stored as X * 1e7

// Historical USD/TRY daily closes — the DATA SOURCE for the commission model (pricing.computeReturnStats).
// The live Yahoo adapter takes an injected fetch (mocked in tests); the offline PoC uses StaticRateHistory.
export { parseYahooChartCloses, YahooUsdTryHistory, StaticRateHistory } from './rate-history.js';
export type { RateHistoryProvider, FetchLike, YahooOptions } from './rate-history.js';

// Network-robustness for the live reads (per-attempt timeout + bounded retry on the /intent hot path).
export { DEFAULT_NET_POLICY, fetchJsonWithRetry } from './net.js';
export type { NetPolicy } from './net.js';

// Live-CEX SPOT oracle — the mainnet-ready TRY/USDC mid (Binance + Bybit + OKX, injected fetch, fail-closed).
export {
  parseDecimalToE7,
  fetchCexQuote,
  LiveCexOracle,
  DEFAULT_CEX_SOURCES,
  BINANCE_SOURCE,
  BYBIT_SOURCE,
  OKX_SOURCE,
} from './cex-spot.js';
export type { CexSource, CexOracleOptions } from './cex-spot.js';

export interface SourceQuote {
  readonly source: string;
  /** TRY per 1 USDC, scaled by RATE_SCALE. */
  readonly tryPerUsdc: bigint;
  /** When this quote was observed (injected epoch ms; NOT read from a clock here). */
  readonly asOfMs: number;
}

export interface OraclePolicy {
  readonly maxAgeMs: number; // staleness: quotes older than this are dropped
  readonly deviationThresholdBps: number; // max allowed deviation from median / between the pair
  readonly minQuorum: number; // minimum healthy sources (typically 2 of 3)
}

export interface RateQuote {
  readonly midTryPerUsdc: bigint; // scaled by RATE_SCALE
  readonly sources: readonly string[];
  readonly asOfMs: number; // oldest asOf among the sources used
}

export type OracleErrorCode = 'InsufficientSources' | 'DeviationExceeded';

export class OracleError extends Error {
  readonly code: OracleErrorCode;
  constructor(code: OracleErrorCode, message: string) {
    super(message);
    this.name = 'OracleError';
    this.code = code;
  }
}

export type OracleResult =
  | { readonly ok: true; readonly quote: RateQuote }
  | { readonly ok: false; readonly error: OracleError };

/** The seam a live-CEX aggregator implements in Phase 4. */
export interface OracleProvider {
  getRate(): Promise<OracleResult>;
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}
/**
 * Lower-median ORDER STATISTIC (an actual quoted price) — the accepted mid AND the robust center for
 * outlier detection. Unlike the mean-of-middles, a single HIGH one-sided extreme cannot shift it (the
 * lower-median resists high-side manipulation) and cannot make an honest opposite source look like the
 * outlier. It does NOT make manipulation impossible: a COMPROMISED source replacing an honest value at or
 * below the median can move the accepted mid up to the next quoted price — but that residual influence is
 * BOUNDED by the deviation threshold (any source beyond it fails the round closed), and adding a data point
 * necessarily shifts the median ("zero influence" is impossible). So keep the deviation threshold TIGHT and
 * require a genuine >= 3-source majority; the accepted mid is always a real quoted price within [min, max].
 */
function medianElement(sortedAsc: readonly bigint[]): bigint {
  return sortedAsc[Math.floor((sortedAsc.length - 1) / 2)] as bigint;
}
function allWithin(pricesAsc: readonly bigint[], center: bigint, thresholdBps: number): boolean {
  return pricesAsc.every((p) => absBig(p - center) * 10_000n <= BigInt(thresholdBps) * center);
}
function ok(mid: bigint, used: readonly SourceQuote[]): OracleResult {
  const asOf = used.reduce((min, q) => (q.asOfMs < min ? q.asOfMs : min), (used[0] as SourceQuote).asOfMs);
  return { ok: true, quote: { midTryPerUsdc: mid, sources: used.map((q) => q.source), asOfMs: asOf } };
}
function fail(code: OracleErrorCode, message: string): OracleResult {
  return { ok: false, error: new OracleError(code, message) };
}

/** Derive per-source TRY/USDC from raw pairs: (TRY/USDT) / (USDC/USDT). Inputs & output scaled by RATE_SCALE. */
export function deriveTryPerUsdc(tryPerUsdt: bigint, usdcPerUsdt: bigint): bigint {
  if (usdcPerUsdt <= 0n) throw new RangeError('usdcPerUsdt must be > 0');
  return (tryPerUsdt * RATE_SCALE) / usdcPerUsdt;
}

/**
 * Aggregate source quotes into a single mid rate, fail-closed. `nowMs` is injected (deterministic).
 * Drop non-positive quotes and quotes whose timestamp is outside a symmetric ±maxAgeMs band (too stale OR too far
 * in the future) and collapse duplicate same-source entries; require
 * >= minQuorum DISTINCT healthy sources (else InsufficientSources); then either
 * ALL healthy quotes agree within the deviation threshold of the median (accept mid = lower-median order
 * statistic, a real quoted price in [min,max]) or we FAIL CLOSED (DeviationExceeded) and the caller
 * retries. There is deliberately NO outlier-drop-and-settle: that is manipulable. Achievable guarantee:
 * an out-of-band or disagreeing source never produces a settlement (0 manipulated price), and an accepted
 * in-band source's residual influence is bounded by the deviation threshold — so set the threshold TIGHT
 * and require a genuine >=3-source majority. ("Zero influence from any added source" is impossible: adding
 * a data point necessarily shifts the median.)
 */
export function aggregate(
  quotes: readonly SourceQuote[],
  policy: OraclePolicy,
  nowMs: number,
): OracleResult {
  // Healthy = positive price AND a timestamp within a SYMMETRIC ±maxAgeMs band of nowMs (|age| <= maxAgeMs). The
  // band is two-sided on purpose: nowMs is snapshotted BEFORE the fetch, so an honest exchange serve-time is
  // naturally a little AHEAD of it — a hard age >= 0 would over-reject legit-fresh sources on the live path. Yet a
  // source lying about its freshness by dating itself FAR into the future is still rejected: beyond +maxAgeMs fails
  // exactly as beyond -maxAgeMs (stale) does. The magnitude of the bound is identical on both sides, so no source
  // can look "fresh" by claiming a far-future timestamp.
  const healthy = quotes.filter((q) => {
    const age = nowMs - q.asOfMs;
    return q.tryPerUsdc > 0n && Math.abs(age) <= policy.maxAgeMs;
  });
  // Collapse to ONE quote per DISTINCT source name (defense-in-depth): the live path fetches each source exactly
  // once, so a duplicate only arises from a misconfigured `sources` list — and it must not let a single real feed
  // satisfy the quorum nor double-weight the median. First occurrence wins.
  const bySource = new Map<string, SourceQuote>();
  for (const q of healthy) if (!bySource.has(q.source)) bySource.set(q.source, q);
  const distinct = [...bySource.values()];
  if (distinct.length < policy.minQuorum) {
    return fail('InsufficientSources', `only ${distinct.length} distinct healthy source(s), need ${policy.minQuorum}`);
  }
  const sorted = [...distinct].sort((a, b) => cmp(a.tryPerUsdc, b.tryPerUsdc));

  const prices = sorted.map((q) => q.tryPerUsdc);
  const mid = medianElement(prices);

  // Fail-closed on ANY disagreement — NO subset settlement. Dropping "outliers" and settling on the
  // remainder is manipulable: a single injected source can tip which source looks like the outlier and
  // shift the accepted mid (verified by adversarial review). So if even one healthy source is beyond
  // the deviation threshold of the median, we do NOT settle this round — the caller retries. This trades
  // availability for safety, which is correct for a settlement rate. The residual influence of an
  // ACCEPTED in-band source is bounded by the deviation threshold (adding a data point necessarily
  // shifts the median — "zero influence" is mathematically impossible), so keep the threshold TIGHT and
  // require a genuine >=3-source majority (policy.minQuorum). The accepted mid is always a real quoted
  // price within [min, max] of the healthy sources.
  if (!allWithin(prices, mid, policy.deviationThresholdBps)) {
    return fail('DeviationExceeded', `sources disagree beyond ${policy.deviationThresholdBps}bps`);
  }
  return ok(mid, sorted);
}

/** Testnet/offline provider: aggregates injected quotes deterministically. */
export class DeterministicOracle implements OracleProvider {
  constructor(
    private readonly quotes: readonly SourceQuote[],
    private readonly policy: OraclePolicy,
    private readonly nowMs: number,
  ) {}
  getRate(): Promise<OracleResult> {
    return Promise.resolve(aggregate(this.quotes, this.policy, this.nowMs));
  }
}
