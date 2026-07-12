// The engine's shared vocabulary: the injected dependency bundle, the perform() result shape, and the two
// PURE-decision helpers the driver auto-advances on. Split out so perform.ts and driver.ts share one source.
//
// decisionEvent is the ONLY place the engine SYNTHESIZES a core event that no port produced. It fires for the
// single state the core enters with [] effects whose forward step is a budget DECISION rather than a port
// observation (money-first: {UsdcDead} — the same-seq replacement budget). UsdcConfirmed is now a reconciled-
// only durable wait (no capture leg). Every other []-effect target is an absolute terminal / manual sink or a
// rePollObserveOnly durable wait, for which it returns null (the driver quiesces).

import type { Event, State } from '@troia/core';
import type { OrderCtx } from '../ctx.js';
import type { Clock, LossBucket, PspPort, ReleaseReason, StellarPort, Store } from '../ports.js';
import type { EngineConfig } from './config.js';

/** The injected seam — fakes offline, real adapters at the composition root (4.3d). */
export interface EngineDeps {
  readonly stellar: StellarPort;
  readonly psp: PspPort;
  readonly store: Store;
  readonly clock: Clock;
  readonly config: EngineConfig;
}

/** A non-event product of an effect: the hosted-checkout URL/token, surfaced to the /intent response (4.3c). */
export type SideOutput = {
  readonly kind: 'checkoutForm';
  readonly token: string;
  readonly formContent: string;
  readonly paymentPageUrl?: string;
};

export interface PerformResult {
  /** the next core event, or null for observe-only / local / start-and-wait (firePreauth) effects. */
  readonly event: Event | null;
  /** merged into OrderCtx by the driver (e.g. {hashHex,signedXdr} after a pay; {activeSeq} after reallocate). */
  readonly ctxPatch?: Partial<OrderCtx>;
  readonly sideOutput?: SideOutput;
  /** verdictToCore INDETERMINATE_LOSS_REVIEW — a burned-but-unproven seq with NO core event. The driver turns
   *  this into a DURABLE flagLoss('indeterminateLossReview') + quarantine (no seq burn/reuse), quiesces. */
  readonly escalate?: { readonly reason: string };
}

/**
 * PURE-decision auto-advance. UsdcDead: consult the PERSISTED same-seq replacement budget (post-increment
 * counter from 0, `<= max` = exactly `max` replacements). Returns null for every non-decision state (terminals,
 * the manual sink, and durable waits — including UsdcConfirmed, which now waits for the reconciler).
 */
export async function decisionEvent(
  coreState: State,
  ctx: OrderCtx,
  deps: EngineDeps,
): Promise<Event | null> {
  switch (coreState) {
    case 'UsdcDead': {
      const n = await deps.store.bumpDeadRetries(ctx.orderId);
      return { type: 'deadRetry', retriesRemaining: n <= deps.config.policy.maxDeadRetries };
    }
    default:
      return null;
  }
}

/** The loss bucket the flagLoss EFFECT records, by the event that entered LossReview:
 *  - reversalNotDone(false) -> 'reversalExhausted': a completed charge whose same-day void could not complete
 *    within budget (a stuck refund).
 *  - revertIndeterminate(false) -> 'indeterminateLossReview': a landed-and-reverted tx whose contract code was
 *    unreadable, so USDC fate is unknown and the charge is NOT reversed. The same bucket is also written by
 *    driver.applyEscalate for a burned-but-unproven submit; both mean "USDC may have moved — do not auto-refund". */
export function flagLossBucket(enteringEvent: Event): LossBucket {
  return enteringEvent.type === 'revertIndeterminate'
    ? 'indeterminateLossReview'
    : 'reversalExhausted';
}

/** releaseReservation reason, by the state ENTERED. Money-first, releaseReservation is emitted only into
 *  FailedClean (a declined/aborted sale — nothing charged) and ChargeReversing (the USDC attempt is abandoned
 *  and the completed charge is being voided). Both free pool capacity for an order that will NOT send USDC.
 *  'balanceGuardRevert' / 'expired' are reserved for the ledger's own annotations. */
export function releaseReason(coreState: State): ReleaseReason {
  switch (coreState) {
    case 'FailedClean':
    case 'ChargeReversing':
      return 'abandoned';
    default:
      throw new Error(`releaseReservation emitted in unexpected state '${coreState}'`);
  }
}
