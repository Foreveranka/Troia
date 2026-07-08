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
}

/** Persistence + SPIKE-3 solvency. Every mutating method runs under the caller's withOrderLock (4.3b). */
export interface Store {
  /** Idempotent write-ahead order creation. 'created' on the FIRST call for an orderId, 'exists' on any
   *  redelivery — start() runs the reserve→checkout-form bootstrap ONLY on 'created', so an at-least-once
   *  /intent trigger or a crash-retry can never double-reserve the pool or open a second checkout session. */
  createIfAbsent(orderId: string): Promise<'created' | 'exists'>;
  persistState(orderId: string, next: State, patch: InFlightPatch): Promise<void>;
  reserve(orderId: string, amountStroops: bigint, ttlMs: number, nowMs: number): Promise<ReserveOutcome>;
  releaseReservation(orderId: string, reason: ReleaseReason): Promise<void>;
  flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void>;
  markWebhookSeen(eventId: string, orderId: string, nowMs: number): Promise<'first' | 'duplicate'>;
  appendEvidence(orderId: string, record: EvidenceRecord): Promise<void>;
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
