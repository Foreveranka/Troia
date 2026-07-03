// planEffect — the PURE, total mapping from a core Effect to WHICH port call it becomes and HOW its result
// becomes the next core Event. This is the unit-testable heart of the engine: the DECISION ("which call") is
// pure and here; the CALL itself is impure and in perform.ts. `mutates` mirrors core MUTATION_EFFECTS exactly.
//
// Correction to the audit's draft (fix-design-first): firePreauth uses the HOSTED checkout form, which is
// ASYNC — initializeCheckoutForm returns a form URL (a side output for the /api/intent response) and NO
// immediate outcome. The preauth result arrives LATER via the webhook -> retrieveCheckoutFormResult ->
// preauthEvent. So firePreauth feeds NO core event here (feedsEventVia:'none'); it is a start-and-wait.

import type { Effect } from '@troia/core';

export type Port = 'psp' | 'stellar' | 'store' | 'sequences' | 'none';

export type FeedsEventVia =
  | 'none'
  | 'reserveOutcome'
  | 'verdictToCore'
  | 'classifyRevertCause'
  | 'captureEvent'
  | 'voidEvent'
  | 'reconcile';

export interface EffectPlan {
  readonly port: Port;
  readonly call: string;
  /** true iff this effect is a core MUTATION_EFFECT (moves money / places-or-voids an authorization). */
  readonly mutates: boolean;
  readonly feedsEventVia: FeedsEventVia;
}

const TABLE: Readonly<Record<Effect, EffectPlan>> = {
  // firePreauth: hosted form initialize -> URL side-output, NO event (outcome via webhook re-retrieve).
  firePreauth: { port: 'psp', call: 'initializeCheckoutForm', mutates: true, feedsEventVia: 'none' },
  // solvency reservation (SPIKE-3) -> solvencyOk|solvencyFail|solvencyUnknown.
  fireSolvencyCheck: { port: 'store', call: 'reserve', mutates: false, feedsEventVia: 'reserveOutcome' },
  // write-ahead: persist the next state + in-flight artifact BEFORE the entering effect runs.
  persistInFlight: { port: 'store', call: 'persistState', mutates: false, feedsEventVia: 'none' },
  // submit pay() -> observe -> verdictToCore -> evidenceSuccess|evidenceReverted|evidencePending.
  submitPay: { port: 'stellar', call: 'submitPay', mutates: true, feedsEventVia: 'verdictToCore' },
  // UsdcDead retry: the wire call is stellar.submitPay; perform() first does sequences.reuseOnDead(seq) then
  // submitPay with the SAME seq + new timebounds (never a fresh seq) -> observe -> verdictToCore.
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
  releaseReservation: { port: 'store', call: 'releaseReservation', mutates: false, feedsEventVia: 'none' },
  // capture the frozen TRY -> captureSuccess|captureFailed|captureUnknown.
  firePostauth: { port: 'psp', call: 'createPostAuth', mutates: true, feedsEventVia: 'captureEvent' },
  // void the live TRY hold -> voidConfirmed|voidNotVoided|voidUnknown.
  fireCancel: { port: 'psp', call: 'cancel', mutates: true, feedsEventVia: 'voidEvent' },
  flagLoss: { port: 'store', call: 'flagLoss', mutates: false, feedsEventVia: 'none' },
  // record the landed witness + run reconciliation -> reconciled.
  handToReconciler: { port: 'store', call: 'appendEvidence', mutates: false, feedsEventVia: 'reconcile' },
  // observe-only: a durable WAIT. The poll/recovery worker performs the actual re-observation and feeds the
  // next event; the driver never mutates here (this is how "Unknown never advances" is honored).
  rePollObserveOnly: { port: 'none', call: 'none', mutates: false, feedsEventVia: 'none' },
};

export function planEffect(effect: Effect): EffectPlan {
  return TABLE[effect];
}
