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
  /** the hosted DIRECT-SALE form token issued when fireCheckoutForm runs (after solvency is reserved). The
   *  webhook re-retrieves the form result by THIS backend-issued token (never the webhook-echoed one) — the V3
   *  preimage concatenates fields with no separator, so a webhook token is not uniquely bound. */
  readonly token: string | null;
  /** iyzico's hosted card page URL for this order, set alongside token when the form is issued. Persisted so a
   *  duplicate/retried /intent (alreadyStarted) can re-present the SAME hosted form instead of dead-ending. */
  readonly paymentPageUrl: string | null;
  readonly paidPriceTry: string; // TRY amount charged at the direct sale (money-first: taken up front)
  readonly currency: string;
  readonly ip: string;
  /** the order's currently-allocated sequence (decimal string), if any. */
  readonly activeSeq: string | null;
  /** the landed USDC pay() witness — set by submitPay/submitReplacementSameSeq perform (from SubmitResult)
   *  and consumed by handToReconciler (settlement_evidence) and flagLoss (loss bucket usdcTxHash). Null until
   *  a pay() has been submitted. Threaded through ctx because Store is write-only (no evidence read-back). */
  readonly hashHex: string | null;
  readonly signedXdr: string | null;
  /** the submitted pay() tx's timebounds maxTime (unix seconds) — set alongside the witness so the poll/
   *  recovery worker can rebuild the observe ReducerState after a crash without re-deriving from the XDR. */
  readonly payMaxTimeUnix: number | null;
  /** persisted deterministic retry counters. */
  readonly deadRetries: number;
  readonly reversalRetries: number;
}
