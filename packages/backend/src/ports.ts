// The injected seam: fakes drive it offline; the real adapters (createStellarClient / createPaymentProvider /
// durable Store / real Clock) are wired ONLY at the composition root (4.3d), never in the offline suite.

import type { State, SequenceProvider } from '@troia/core';
import type {
  CoreAccountSnapshot,
  ObserveResult,
  PayRequest,
  ReducerState,
  SendOutcome,
  SubmitResult,
} from '@troia/stellar-client';
import type {
  CancelParams,
  InitializeCheckoutFormParams,
  RawIyzicoResult,
  RetrieveCheckoutFormParams,
} from '@troia/psp';

/** Stellar side: the shipped StellarClient + one read for SPIKE-3 solvency (real impl deferred to 4.4). */
export interface StellarPort {
  submitPay(req: PayRequest): Promise<SubmitResult>;
  resendPersisted(orderId: string): Promise<SendOutcome>;
  observe(state: ReducerState): Promise<ObserveResult>;
  loadDestinationSnapshot(destination: string): Promise<CoreAccountSnapshot>;
  readPoolBalanceStroops(): Promise<bigint>;
  /** The contract Error code of a LANDED-and-REVERTED pay() (confirmBurnedSeq -> classifyRevertCause).
   *  1=AlreadyProcessed, 2=InsufficientBalance, ...; null when the code cannot be read (classifies Other). */
  readRevertErrorCode(orderId: string): Promise<number | null>;
}

/** iyzico side (money-first): the hosted DIRECT-SALE form + its retrieve, and cancel (same-day sale void).
 *  No preauth/postauth — the customer is charged directly; a failed USDC send is unwound by voiding the sale. */
export interface PspPort {
  initializeCheckoutForm(p: InitializeCheckoutFormParams): Promise<RawIyzicoResult>;
  retrieveCheckoutFormResult(p: RetrieveCheckoutFormParams): Promise<RawIyzicoResult>;
  cancel(p: CancelParams): Promise<RawIyzicoResult>;
}

/** Timestamps + backoff ONLY — never consulted for deadness/expiry (that is ledger-close-time sourced). */
export interface Clock {
  nowUnix(): number;
}

export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly reservationId: string }
  | { readonly kind: 'insufficient'; readonly available: bigint; readonly requested: bigint }
  | { readonly kind: 'unknown' };

export type ReleaseReason = 'abandoned' | 'balanceGuardRevert' | 'expired';
/** The two money-first loss buckets. indeterminateLossReview: a burned-but-unproven sequence (verdictToCore
 *  INDETERMINATE_LOSS_REVIEW) whose USDC fate is genuinely unknown — a DURABLE quarantine written WITHOUT
 *  moving money or touching the seq; the charge is NOT reversed (USDC may have landed). reversalExhausted: a
 *  completed charge whose USDC failed AND whose same-day void could not be completed within budget — a real
 *  stuck refund that must be surfaced for manual action (a failed refund does NOT self-heal). */
export type LossBucket = 'indeterminateLossReview' | 'reversalExhausted';

export interface InFlightPatch {
  readonly seq?: string;
  readonly paymentId?: string;
  readonly hashHex?: string;
  readonly signedXdr?: string;
}

export interface EvidenceRecord {
  readonly txHash: string;
  readonly signedXdr: string;
  readonly seq: string;
  /** When we witnessed the pay() land. Wall clock — used ONLY to age an unobservable settlement into an alarm,
   *  never to decide whether a transaction is live (that is ledger-close time, always). */
  readonly witnessedAtUnix: number;
}

/**
 * The order's own frozen facts, carried into the durable evidence row so that a restarted process can finish the
 * order's accounting without the in-memory registry that died with it.
 *
 * Without this, a crash between "the payout confirmed" and "the settlement worker's next tick" left the outflow
 * unbooked FOREVER: the worker's work-list came from memory, so nothing rediscovered the order. The double-entry
 * ledger then permanently disagreed with the chain, and the solvency alarm — correctly, and uselessly — rang for
 * a discrepancy nobody could ever close. The pool's refill was lost the same way, silently.
 */
export interface OrderFacts {
  readonly destination: string;
  readonly amountStroops: bigint;
  readonly memoHex: string;
  readonly appliedRateStroops: bigint;
  /** The TRY actually charged, as the canonical "N.MM" string the customer saw. */
  readonly paidPriceTry: string;
  /** The accounting split of that charge, frozen at quote time (invariant ⑤). */
  readonly spreadKurus: bigint;
  readonly feeKurus: bigint;
}

/** One durable settlement witness: which order authorized which landed pay(), and what that order was. */
export interface EvidenceRow {
  readonly orderId: string;
  readonly record: EvidenceRecord;
  readonly order: OrderFacts;
}

/**
 * A synchronous append-only durable sink. The backend never learns where the bytes go — the composition root
 * injects the file-backed implementation, so this package keeps its no-`node:fs` property. Synchronous on
 * purpose: an await here would split the store's read-modify-write and force a lock it must not take.
 * Throws on I/O failure, and a throw must leave nothing recorded in memory.
 */
export interface DurableLog {
  append(payload: string): void;
}

/**
 * Recognise a durable-log write failure structurally, without importing the composition root's fs module.
 *
 * A log that refuses a write is poisoned for the life of the process — that is deliberate, because it confines a
 * partially-written record to the physical tail where replay can safely drop it. The consequence for callers is
 * that NOTHING can be booked any more. A worker that swallows this into "retry next tick" would spin forever,
 * re-running the effects that precede the write (in the settlement worker, that means minting) while never
 * recording their result. So every caller must let it escape and fail fast; a restart re-runs the boot-time write
 * probe, which either finds a healed disk or refuses to start.
 */
export function isDurableLogFailure(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'DurableLogFailure'
  );
}

/** Persistence + SPIKE-3 solvency. Every mutating method runs under the caller's withOrderLock (4.3b). */
export interface Store {
  /** Idempotent write-ahead order creation. 'created' on the FIRST call for an orderId, 'exists' on any
   *  redelivery — start() runs the reserve→checkout-form bootstrap ONLY on 'created', so an at-least-once
   *  /intent trigger or a crash-retry can never double-reserve the pool or open a second checkout session. */
  createIfAbsent(orderId: string): Promise<'created' | 'exists'>;
  persistState(orderId: string, next: State, patch: InFlightPatch): Promise<void>;
  reserve(
    orderId: string,
    amountStroops: bigint,
    ttlMs: number,
    nowMs: number,
  ): Promise<ReserveOutcome>;
  releaseReservation(orderId: string, reason: ReleaseReason): Promise<void>;
  flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void>;
  markWebhookSeen(eventId: string, orderId: string, nowMs: number): Promise<'first' | 'duplicate'>;
  appendEvidence(orderId: string, record: EvidenceRecord, order: OrderFacts): Promise<void>;
  /**
   * The durable evidence row for an order, or undefined.
   *
   * Its EXISTENCE is a statement about the order's state, and a precise one. `handToReconciler` is the only
   * effect that writes a row, and it fires on exactly the two transitions into `UsdcConfirmed` — from which the
   * only exit is `Reconciled`. Both map to the public status `completed`. So a caller that has lost its in-memory
   * order rows (a restart does) may still answer for a settled order from here, and cannot thereby claim more
   * than it knows.
   */
  settledEvidence(orderId: string): EvidenceRow | undefined;
  /** Persisted deterministic retry counters; return the NEW (post-increment) value from 0. retriesRemaining
   *  is `newCount <= policy.max*Retries`, so recovery/replay re-reads the same counter and picks the same
   *  branch (never a timer). Atomic under withOrderLock. */
  bumpDeadRetries(orderId: string): Promise<number>;
  bumpReversalRetries(orderId: string): Promise<number>;
  /** Best-effort read of `balance − Σ held reservations` (stroops) for the money-first circuit-breaker: the
   *  /intent hard gate (available < amount → 409, no charge) and the low-watermark warning. This is NOT the
   *  authoritative solvency gate — reserve() is (atomic, under the pool mutex); a dirty read here only fast-
   *  fails the obvious empty-pool case and surfaces the warning. */
  availableStroops(): bigint;
  /** Raise the in-memory pool base by a landed rebalance top-up (mint), so the /intent hard gate and the
   *  low-watermark warning reflect the new liquidity (the base is otherwise seeded once at bootstrap and only
   *  ever decreases via held reservations). Runs under the pool mutex — serialized with reserve()'s
   *  check→commit. Exactly-once is the CALLER's (the settlement worker's per-order claim); this is a raw
   *  additive credit. */
  creditPool(stroops: bigint): Promise<void>;
  readonly sequences: SequenceProvider;
}
