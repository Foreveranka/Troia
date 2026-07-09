// planEffect — the PURE, total mapping from a core Effect to WHICH port call it becomes and HOW its result
// becomes the next core Event. This is the unit-testable heart of the engine: the DECISION ("which call") is
// pure and here; the CALL itself is impure and in perform.ts. `mutates` mirrors core MUTATION_EFFECTS exactly.
//
// Money-first (Phase 4.6): the FIRST effect is fireSolvencyCheck (reserve the pool BEFORE any charge). The
// hosted form (fireCheckoutForm) is the DIRECT-SALE variant and is ASYNC — initializeCheckoutForm returns a
// form URL (a side output for the /intent response) and NO immediate outcome; the charge result arrives LATER
// via the webhook -> retrieveCheckoutFormResult -> chargeEvent. So fireCheckoutForm feeds NO core event on the
// happy path (feedsEventVia:'none'); it only emits checkoutInitFailed inline if the form init itself malforms.

import type { Effect } from '@troia/core';

export type Port = 'psp' | 'stellar' | 'store' | 'sequences' | 'none';

export type FeedsEventVia =
  | 'none'
  | 'reserveOutcome'
  | 'verdictToCore'
  | 'classifyRevertCause'
  | 'reversalEvent'
  | 'reconcile';

export interface EffectPlan {
  readonly port: Port;
  readonly call: string;
  /** true iff this effect is a core MUTATION_EFFECT (moves money / places-or-voids a charge). */
  readonly mutates: boolean;
  readonly feedsEventVia: FeedsEventVia;
}

const TABLE: Readonly<Record<Effect, EffectPlan>> = {
  // solvency reservation (SPIKE-3), FIRST — the pool must hold USDC before the customer can be charged.
  fireSolvencyCheck: {
    port: 'store',
    call: 'reserve',
    mutates: false,
    feedsEventVia: 'reserveOutcome',
  },
  // hosted DIRECT-SALE form initialize -> URL side-output, no happy-path event (outcome via webhook). Inline
  // checkoutInitFailed only if the init itself malforms. mutates:true so it can never fire on an Unknown/stay.
  fireCheckoutForm: {
    port: 'psp',
    call: 'initializeCheckoutForm',
    mutates: true,
    feedsEventVia: 'none',
  },
  // LATE allocation (Approach B): hand out the operator seq at chargeOk, then the trailing persist/submit read
  // it. mutates:true (mirrors reallocateSeq) so it can never sit on an observe-only edge. Patches ctx, no event.
  allocateSeq: { port: 'sequences', call: 'allocate', mutates: true, feedsEventVia: 'none' },
  // write-ahead: persist the next state + in-flight artifact BEFORE the entering effect runs.
  persistInFlight: { port: 'store', call: 'persistState', mutates: false, feedsEventVia: 'none' },
  // submit pay() -> observe -> verdictToCore -> evidenceSuccess|evidenceReverted|evidencePending.
  submitPay: { port: 'stellar', call: 'submitPay', mutates: true, feedsEventVia: 'verdictToCore' },
  // UsdcDead retry / never-sent recovery: the wire call is stellar.submitPay; perform() first does
  // sequences.reuseOnDead(seq) then submitPay with the SAME seq + new timebounds -> observe -> verdictToCore.
  submitReplacementSameSeq: {
    port: 'stellar',
    call: 'submitPay',
    mutates: true,
    feedsEventVia: 'verdictToCore',
  },
  // NEW seq for a reverted-other order; trailing submitPay feeds the event.
  reallocateSeq: { port: 'sequences', call: 'reallocate', mutates: true, feedsEventVia: 'none' },
  // burn the seq of a landed-and-reverted tx, then classify the on-chain revert cause.
  confirmBurnedSeq: {
    port: 'sequences',
    call: 'confirmBurned',
    mutates: false,
    feedsEventVia: 'classifyRevertCause',
  },
  releaseSeq: { port: 'sequences', call: 'release', mutates: false, feedsEventVia: 'none' },
  releaseReservation: {
    port: 'store',
    call: 'releaseReservation',
    mutates: false,
    feedsEventVia: 'none',
  },
  // void the completed TRY sale (same-day /payment/cancel) -> reversalConfirmed|reversalNotDone|reversalUnknown.
  fireCancel: { port: 'psp', call: 'cancel', mutates: true, feedsEventVia: 'reversalEvent' },
  flagLoss: { port: 'store', call: 'flagLoss', mutates: false, feedsEventVia: 'none' },
  // record the landed witness + run reconciliation -> reconciled.
  handToReconciler: {
    port: 'store',
    call: 'appendEvidence',
    mutates: false,
    feedsEventVia: 'reconcile',
  },
  // observe-only: a durable WAIT. The poll/recovery worker performs the actual re-observation and feeds the
  // next event; the driver never mutates here (this is how "Unknown never advances" is honored).
  rePollObserveOnly: { port: 'none', call: 'none', mutates: false, feedsEventVia: 'none' },
};

export function planEffect(effect: Effect): EffectPlan {
  return TABLE[effect];
}
