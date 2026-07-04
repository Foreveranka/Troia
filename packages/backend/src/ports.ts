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
  PostAuthParams,
  PreAuthParams,
  RawIyzicoResult,
  RefundParams,
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

/** iyzico side: the shipped PaymentProvider verbatim. */
export interface PspPort {
  initializeCheckoutForm(p: InitializeCheckoutFormParams): Promise<RawIyzicoResult>;
  retrieveCheckoutFormResult(p: RetrieveCheckoutFormParams): Promise<RawIyzicoResult>;
  createPreAuth(p: PreAuthParams): Promise<RawIyzicoResult>;
  createPostAuth(p: PostAuthParams): Promise<RawIyzicoResult>;
  cancel(p: CancelParams): Promise<RawIyzicoResult>;
  refund(p: RefundParams): Promise<RawIyzicoResult>;
}

/** Timestamps + backoff ONLY — never consulted for deadness/expiry (that is ledger-close-time sourced). */
export interface Clock {
  nowUnix(): number;
}

export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly reservationId: string }
  | { readonly kind: 'insufficient'; readonly available: bigint; readonly requested: bigint }
  | { readonly kind: 'unknown' };

export type ReleaseReason = 'abandoned' | 'balanceGuardRevert' | 'solvencyReject' | 'expired';
/** captureFailed/holdExpired are core-emitted (USDC sent, TRY not captured); indeterminateLossReview is the
 *  out-of-band escalate marker for a burned-but-unproven sequence (verdictToCore INDETERMINATE_LOSS_REVIEW):
 *  a DURABLE quarantine record the reconciler must resolve, written WITHOUT moving money or touching the seq.
 *  checkoutInitFailed is the (NON-money) durable marker for a failed hosted-form bootstrap in start() — no TRY
 *  hold, no USDC; it makes a bricked pre-money order observable/recoverable rather than silently stuck. */
export type LossBucket = 'captureFailed' | 'holdExpired' | 'indeterminateLossReview' | 'checkoutInitFailed';

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
   *  redelivery — start() fires firePreauth (a MUTATION_EFFECT) ONLY on 'created', so an at-least-once
   *  /intent trigger or a crash-retry can never open a second checkout session / duplicate TRY hold. */
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
  bumpCaptureRetries(orderId: string): Promise<number>;
  bumpVoidRetries(orderId: string): Promise<number>;
  readonly sequences: SequenceProvider;
}
