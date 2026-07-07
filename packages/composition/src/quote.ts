// makeQuoteFn — the composition root's PSP-inclusive server-side pricer. It binds a LIVE spot-mid oracle + a
// daily-close history + a PricingPolicy into the backend's injected QuoteFn seam, so /intent prices every order
// server-side (oracle mid -> FX-risk commission -> margin -> PSP gross-up) and never trusts a client-supplied
// price. This is where @troia/oracle + @troia/pricing meet the backend — kept OUT of @troia/backend on purpose
// (the backend takes no pricing/oracle dependency; the quote stays an injected seam).
//
// FAIL-CLOSED: a spot mid the oracle cannot agree on (under-quorum / over-deviation) throws, which /intent maps
// to 502 PriceUnavailable — a priced order is only ever started when we actually know its price, so a rate-feed
// outage never charges a customer.
//
// CACHING (money-safe): the spot mid is fetched FRESH on every quote (it is the actual rate the user pays). The
// FX-risk stats (mu, sigma from ~6 months of daily closes) move ~once a day, so they are cached with a refresh
// TTL and a BOUNDED last-good fallback: a transient history-feed blip reuses recent stats rather than failing a
// quote, but ONLY up to statsMaxStaleMs. Stale stats are NOT directionally safe — commission = mu*n + z*sigma*
// sqrt(n) + margin has positive coefficients, so stats cached from a VOLATILE window and reused into a CALMED
// market OVERCHARGE the customer (unbounded in both directions with age). So once the cache exceeds the max
// staleness we fail closed exactly like the no-stats-ever path (no stats -> no commission -> no price).

import type { PricingPolicy, Quote, QuoteFn } from '@troia/backend';
import type { OracleProvider, RateHistoryProvider } from '@troia/oracle';
import { computeReturnStats, quoteUsdcWithPsp } from '@troia/pricing';
import type { ReturnStats } from '@troia/pricing';

export interface QuoteSources {
  /** live spot TRY/USDC mid (fail-closed: an under-quorum / over-deviation read returns !ok, which we throw). */
  readonly spotOracle: OracleProvider;
  /** chronological daily USD/TRY closes -> the FX-risk commission stats (mu, sigma). */
  readonly history: RateHistoryProvider;
  /** the FX-risk commission params + the PSP cost pass-through (valör + iyzico-rate knobs). */
  readonly policy: PricingPolicy;
  /** how long a computed (mu, sigma) is reused before refetching the history (default 1h; stats move ~daily). */
  readonly statsTtlMs?: number;
  /** HARD ceiling on cached-stats age: past this, a history-feed outage fails a quote closed rather than reuse
   *  stale (possibly OVER-charging) stats. Default 6h. Must be >= statsTtlMs to be meaningful. */
  readonly statsMaxStaleMs?: number;
  /** injectable clock (ms) for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
}

const DEFAULT_STATS_TTL_MS = 60 * 60 * 1000; // 1 hour — normal refresh cadence
const DEFAULT_STATS_MAX_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours — hard outage ceiling, then fail closed

/** Build the backend's injected QuoteFn from a live oracle + a daily-close history + a PricingPolicy. See the
 *  file header for the fail-closed + bounded-cache contract. */
export function makeQuoteFn(sources: QuoteSources): QuoteFn {
  const maxStaleMs = sources.statsMaxStaleMs ?? DEFAULT_STATS_MAX_STALE_MS;
  // never serve the fast-path cache beyond the hard ceiling, even if misconfigured with ttl > maxStale.
  const freshMs = Math.min(sources.statsTtlMs ?? DEFAULT_STATS_TTL_MS, maxStaleMs);
  const now = sources.now ?? ((): number => Date.now());
  let cached: { readonly stats: ReturnStats; readonly atMs: number } | null = null;

  async function returnStats(): Promise<ReturnStats> {
    const t = now();
    if (cached !== null && t - cached.atMs < freshMs) return cached.stats;
    try {
      const stats = computeReturnStats(await sources.history.dailyCloses());
      cached = { stats, atMs: t };
      return stats;
    } catch (err) {
      // BOUNDED last-good: reuse recent stats through a transient outage, but NEVER indefinitely — stale stats
      // are directionally unbounded (see header), so once the cache exceeds maxStaleMs fail closed.
      if (cached !== null && t - cached.atMs < maxStaleMs) return cached.stats;
      throw err;
    }
  }

  return async (usdcStroops: bigint): Promise<Quote> => {
    const rate = await sources.spotOracle.getRate(); // FRESH per quote — the real rate the user pays
    if (!rate.ok) throw rate.error; // fail-closed: no agreed mid -> no price -> /intent 502
    const stats = await returnStats();
    const sq = quoteUsdcWithPsp(
      usdcStroops,
      rate.quote.midTryPerUsdc,
      stats,
      sources.policy.commission,
      sources.policy.psp,
    );
    // Map the pricing SettlementQuote down to the backend's Quote seam (drop the pricing-internal net/pspCost
    // lines; the on-chain applied_rate stays the FX rate, the PSP cost is already baked into userTryKurus).
    return {
      userTryKurus: sq.userTryKurus,
      paidPriceTry: sq.paidPriceTry,
      appliedRateStroops: sq.appliedRateStroops,
      oracleMidE7: sq.oracleMidE7,
      spreadBps: sq.spreadBps,
    };
  };
}
