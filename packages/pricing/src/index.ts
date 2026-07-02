// Transparent spread pricing (ADR-4, K5). Stateless and deterministic — fixed-point bigint only.
// appliedRate = mid × (1 + spread_bps/10000); userTRY is rounded DOWN (user-favorable), and the spread
// revenue is a SEPARATE line, never hidden in the FX. The user sees only the TRY total (§7). The value
// this function returns is the amount that PayoutIntent freezes (invariant ⑤ PRICE-LOCK) so capture
// charges exactly it.

export const RATE_SCALE = 10_000_000n; // MUST equal @troia/oracle RATE_SCALE (TRY-per-USDC × 1e7)
export const STROOP = 10_000_000n; // 1 USDC = 1e7 stroops (Stellar 7 decimals)
export const KURUS_PER_TRY = 100n; // TRY has 2 decimals (kuruş)
export const BPS_DENOM = 10_000n;

// userTRY(kuruş) = usdcStroops × rate(×1e7) / (STROOP × RATE_SCALE / KURUS_PER_TRY) = ... / 1e12
const KURUS_DIVISOR = (STROOP * RATE_SCALE) / KURUS_PER_TRY;

export interface PriceBreakdown {
  readonly usdcStroops: bigint;
  readonly oracleMidTryPerUsdc: bigint; // × RATE_SCALE
  readonly appliedRateTryPerUsdc: bigint; // × RATE_SCALE
  readonly spreadBps: number;
  /** What the user pays, in kuruş (frozen by PayoutIntent — invariant ⑤). */
  readonly userTryKurus: bigint;
  /** Transparent margin, in kuruş (separate line, ADR-4). */
  readonly spreadRevenueKurus: bigint;
}

/** appliedRate = mid × (1 + spread_bps/10000). */
export function applySpread(midE7: bigint, spreadBps: number): bigint {
  if (!Number.isInteger(spreadBps) || spreadBps < 0) {
    throw new RangeError('spreadBps must be a non-negative integer');
  }
  return (midE7 * (BPS_DENOM + BigInt(spreadBps))) / BPS_DENOM;
}

export function priceUsdc(usdcStroops: bigint, oracleMidE7: bigint, spreadBps: number): PriceBreakdown {
  if (usdcStroops <= 0n) throw new RangeError('usdcStroops must be > 0');
  if (oracleMidE7 <= 0n) throw new RangeError('oracleMidE7 must be > 0');
  const appliedRateE7 = applySpread(oracleMidE7, spreadBps);
  // Floor division rounds the TRY the user pays DOWN — user-favorable; the remainder comes out of margin.
  const userTryKurus = (usdcStroops * appliedRateE7) / KURUS_DIVISOR;
  const baseTryKurus = (usdcStroops * oracleMidE7) / KURUS_DIVISOR;
  return {
    usdcStroops,
    oracleMidTryPerUsdc: oracleMidE7,
    appliedRateTryPerUsdc: appliedRateE7,
    spreadBps,
    userTryKurus,
    spreadRevenueKurus: userTryKurus - baseTryKurus,
  };
}
