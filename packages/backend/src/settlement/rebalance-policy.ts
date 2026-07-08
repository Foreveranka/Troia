// The DECISION seam of the TRY-driven rebalance (the future "agent" hook). Given a settled order and the
// LIVE rate read at settle time, it decides how much USDC to add to the pool. The default is Model-B: convert
// the ENTIRE collected TRY to USDC at the live rate — so the pool refills what drained PLUS the commission
// (realized as surplus USDC), and an adverse rate move in the valör window is absorbed by that commission
// cushion (the FX-risk the commission was priced for). Pure + deterministic (no I/O, no clock, no random ref);
// a future treasury/valör-aware or LLM policy implements the SAME RebalancePolicy interface without touching
// the worker or the execution provider. On testnet the resulting mint is issuer-signed USDC; on mainnet the
// SAME request drives a real CEX buy behind the unchanged RebalanceProvider seam.

import type { PendingSettlement } from './pending-settlement-store.js';

/** Structurally compatible with @troia/rebalance's TopUpRequest (kept local so the backend does not depend on
 *  the rebalance package; they meet by structural typing at the composition root). */
export interface TopUpRequest {
  /** deterministic per-order dedup key, `topup:<canonicalOrderId>` — NEVER random/timestamped. */
  readonly ref: string;
  /** the USDC to mint/buy into the pool, in stroops (7 decimals). */
  readonly usdcStroops: bigint;
  /** the TRY value (kuruş) that funds this top-up — booked as the EXTERNAL_FUNDING counter-leg. */
  readonly valueKurus: bigint;
}

export interface RebalancePolicy {
  /** Plan the top-up for a settled order at the given live rate (TRY per USDC, 7-decimal stroops). */
  plan(rec: PendingSettlement, liveRateStroops: bigint): TopUpRequest;
}

// USDC stroops (7dp) = TRY(kuruş) × 1e12 / rate(stroops). Derivation: USDC = (kuruş/100) ÷ (rate/1e7).
const KURUS_TO_STROOP_NUMERATOR = 1_000_000_000_000n; // 1e12

export class TryDrivenRebalancePolicy implements RebalancePolicy {
  plan(rec: PendingSettlement, liveRateStroops: bigint): TopUpRequest {
    if (liveRateStroops <= 0n) throw new RangeError('liveRateStroops must be > 0 (fail-closed: no mint on a bogus rate)');
    if (rec.tryKurus <= 0n) throw new RangeError('tryKurus must be > 0 (fail-closed: no mint without collected TRY)');
    // Integer division truncates DOWN — the mint is never rounded up, so a rounding error can only UNDER-fund
    // the pool (money-safe), never over-mint.
    const usdcStroops = (rec.tryKurus * KURUS_TO_STROOP_NUMERATOR) / liveRateStroops;
    return { ref: `topup:${rec.orderId}`, usdcStroops, valueKurus: rec.tryKurus };
  }
}
