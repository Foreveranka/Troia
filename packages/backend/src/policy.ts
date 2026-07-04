// PolicyConfig is INJECTED, never hardcoded — the real numbers are measured/locked in the iyzico sandbox in
// Phase 4.5. The offline suite uses OFFLINE_DEFAULT_POLICY placeholders. retriesRemaining is derived from a
// PERSISTED deterministic counter (never a timer), so recovery/replay picks the same branch.

export interface PolicyConfig {
  /** max same-seq replacements of a dead USDC tx before abandoning the order (then reversing the charge). */
  readonly maxDeadRetries: number;
  /** max sale-reversal (iyzico.cancel / same-day void) retries before escalating the reversal to LossReview. */
  readonly maxReversalRetries: number;
  /** how long a solvency reservation stays active (ms). */
  readonly reservationTtlMs: number;
  /** money-first circuit-breaker: if pool `available()` is at/below this (stroops), the storefront is warned
   *  the pool is low. The hard gate is separate — a per-order reserve failure fail-closes /intent regardless. */
  readonly poolLowWatermarkStroops: bigint;
}

export const OFFLINE_DEFAULT_POLICY: PolicyConfig = {
  maxDeadRetries: 3,
  maxReversalRetries: 3,
  reservationTtlMs: 10 * 60 * 1000,
  poolLowWatermarkStroops: 0n, // offline placeholder; 4.5 sets a real low-water mark from the funded pool size
};
