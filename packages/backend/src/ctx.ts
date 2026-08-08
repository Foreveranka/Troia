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
  /** The accounting split of that charge, in kuruş, FROZEN at quote time exactly like the price itself
   *  (invariant ⑤). `feeKurus` is the PSP cost, expensed; `spreadKurus` is everything the customer paid above
   *  the mid-rate value of the USDC — i.e. the PSP cost plus the FX-risk margin. The settlement worker books
   *  them verbatim, because recomputing a margin from a stored rate rounds differently than the price the
   *  customer was charged, and a ledger that disagrees with the cash by a kuruş is a ledger that lies. */
  readonly spreadKurus: bigint;
  readonly feeKurus: bigint;
  readonly currency: string;
  readonly ip: string;
  /** the order's currently-allocated sequence (decimal string), if any. */
  readonly activeSeq: string | null;
  /** CHANNEL MODE (A-5): the channel account (G-address) whose sequence space `activeSeq` lives in — the
   *  pay() tx SOURCE and the account the deadness read targets. Null on the single-operator deployment AND
   *  before allocation. Sticky per order (the double-pay shield is per account), set at allocateSeq. */
  readonly channelPublic: string | null;
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
