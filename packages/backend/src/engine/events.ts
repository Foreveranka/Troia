// The engine's shared vocabulary: the injected dependency bundle, the perform() result shape, and the two
// PURE-decision helpers the driver auto-advances on. Split out so perform.ts and driver.ts share one source.
//
// decisionEvent is the ONLY place the engine SYNTHESIZES a core event that no port produced. It fires for
// exactly the two states the core enters with [] effects whose forward step is a budget/time DECISION rather
// than a port observation (audited complete: {UsdcConfirmed, UsdcDead}). Every other []-effect target is an
// absolute terminal or a rePollObserveOnly durable wait, for which it returns null (the driver quiesces).

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
export type SideOutput = { readonly kind: 'checkoutForm'; readonly token: string; readonly formContent: string };

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
 * PURE-decision auto-advance. UsdcConfirmed: proceed to capture unless the hold has (defensively) expired.
 * UsdcDead: consult the PERSISTED same-seq replacement budget (post-increment counter from 0, `<= max` =
 * exactly `max` replacements). Returns null for every non-decision state (terminals + durable waits).
 */
export async function decisionEvent(coreState: State, ctx: OrderCtx, deps: EngineDeps): Promise<Event | null> {
  switch (coreState) {
    case 'UsdcConfirmed':
      return deps.clock.nowUnix() > deps.config.policy.preauthValidityUnix
        ? { type: 'holdExpired' }
        : { type: 'captureWriteAhead' };
    case 'UsdcDead': {
      const n = await deps.store.bumpDeadRetries(ctx.orderId);
      return { type: 'deadRetry', retriesRemaining: n <= deps.config.policy.maxDeadRetries };
    }
    default:
      return null;
  }
}

/** The one irreversible-loss bucket, keyed off the ENTERING event (flagLoss is emitted only from
 *  holdExpired->LossReview and captureFailed(false)->LossReview). */
export function flagLossBucket(enteringEvent: Event): LossBucket {
  return enteringEvent.type === 'holdExpired' ? 'holdExpired' : 'captureFailed';
}

/** releaseReservation reason, injective by the state ENTERED (audited: FailedClean/AbandonedSeqReturned are
 *  clean abandonments; SolvencyRejected reaches releaseReservation ONLY via revertBalanceGuard). 'solvencyReject'
 *  is never used by this effect (solvencyFail emits fireCancel, no releaseReservation); 'expired' is the TTL
 *  reconciler's. */
export function releaseReason(coreState: State): ReleaseReason {
  switch (coreState) {
    case 'SolvencyRejected':
      return 'balanceGuardRevert';
    case 'FailedClean':
    case 'AbandonedSeqReturned':
      return 'abandoned';
    default:
      throw new Error(`releaseReservation emitted in unexpected state '${coreState}'`);
  }
}
