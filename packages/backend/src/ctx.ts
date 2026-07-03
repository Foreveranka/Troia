// OrderCtx — the frozen per-order facts the engine threads through planEffect/perform. Deterministic:
// conversationId = deriveIds(orderId, destination, amount).idempotencyKeyHex is the SAME on every psp call
// so iyzico dedupes server-side; the retry counters are PERSISTED (not timers) so recovery replays the same
// branch. Built once at intent time (or rebuilt from the persisted OrderRow on recovery).

export interface OrderCtx {
  readonly orderId: string;
  /** deriveIds(...).idempotencyKeyHex — the psp correlation/dedupe key on every call. */
  readonly conversationId: string;
  readonly destination: string;
  readonly amountStroops: bigint;
  readonly appliedRateStroops: bigint;
  readonly memoHex: string;
  /** iyzico-side facts (present after the hosted form completes). */
  readonly paymentId: string | null;
  readonly paidPriceTry: string; // TRY amount to capture at PostAuth
  readonly currency: string;
  readonly ip: string;
  /** the order's currently-allocated sequence (decimal string), if any. */
  readonly activeSeq: string | null;
  /** persisted deterministic retry counters. */
  readonly deadRetries: number;
  readonly captureRetries: number;
}
