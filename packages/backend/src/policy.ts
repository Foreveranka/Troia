// PolicyConfig is INJECTED, never hardcoded — the real numbers are measured/locked in the iyzico sandbox in
// Phase 4.5. The offline suite uses OFFLINE_DEFAULT_POLICY placeholders. retriesRemaining is derived from a
// PERSISTED deterministic counter (never a timer), so recovery/replay picks the same branch.

export interface PolicyConfig {
  /** max same-seq replacements of a dead USDC tx before abandoning the order. */
  readonly maxDeadRetries: number;
  /** max PostAuth (capture) retries before declaring LOSS_REVIEW. */
  readonly maxCaptureRetries: number;
  /** how long a solvency reservation stays active (ms). */
  readonly reservationTtlMs: number;
  /** conservative upper bound (unix seconds) after which a confirmed hold is treated as expired. */
  readonly preauthValidityUnix: number;
}

export const OFFLINE_DEFAULT_POLICY: PolicyConfig = {
  maxDeadRetries: 3,
  maxCaptureRetries: 3,
  reservationTtlMs: 10 * 60 * 1000,
  preauthValidityUnix: 4_102_444_800, // 2100-01-01 — offline placeholder; 4.5 measures the real window
};
