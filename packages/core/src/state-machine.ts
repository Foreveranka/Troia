// Settlement state machine — the single source of truth (docs/ARCHITECTURE.md §3, troia-olay-orgusu.md §4).
// A PURE, TOTAL reducer: transition(state, event) returns a result and NEVER throws. Side effects are
// returned as descriptors (data), not executed here — the backend (Phase 4) performs them and feeds the
// results back as the next event. The table was corrected by an independent audit (D1–D8) for money-safety
// and reducer totality before implementation.

export type State =
  | 'Reserved'
  | 'TryPreauthed'
  | 'UsdcSubmitted'
  | 'UsdcConfirmed'
  | 'UsdcPending'
  | 'UsdcDead'
  | 'UsdcReverted'
  | 'CaptureSubmitted'
  | 'TryCaptured'
  | 'Reconciled'
  | 'SolvencyRejected'
  | 'AbandonedSeqReturned'
  | 'TryHoldVoided'
  | 'LossReview'
  | 'FailedClean';

export const ALL_STATES: readonly State[] = [
  'Reserved',
  'TryPreauthed',
  'UsdcSubmitted',
  'UsdcConfirmed',
  'UsdcPending',
  'UsdcDead',
  'UsdcReverted',
  'CaptureSubmitted',
  'TryCaptured',
  'Reconciled',
  'SolvencyRejected',
  'AbandonedSeqReturned',
  'TryHoldVoided',
  'LossReview',
  'FailedClean',
];

/** Absolute terminals: any event is an idempotent no-op (at-least-once redelivery, D7). */
export const ABSOLUTE_TERMINAL_STATES = ['Reconciled', 'FailedClean', 'TryHoldVoided'] as const;
/** Void-pending: a live TRY hold remains; iyzico.cancel is 3-valued; voidConfirmed → TryHoldVoided (D1). */
export const VOID_PENDING_STATES = ['SolvencyRejected', 'LossReview', 'AbandonedSeqReturned'] as const;

const ABSOLUTE_TERMINALS: ReadonlySet<State> = new Set(ABSOLUTE_TERMINAL_STATES);
const VOID_PENDING: ReadonlySet<State> = new Set(VOID_PENDING_STATES);

export function isAbsoluteTerminal(state: State): boolean {
  return ABSOLUTE_TERMINALS.has(state);
}
export function isVoidPending(state: State): boolean {
  return VOID_PENDING.has(state);
}

// Side-effect descriptors. `rePollObserveOnly` is load-bearing: it is the ONLY effect emitted on
// Unknown / recover / stay transitions, and it must never carry an external mutation — this is how the
// "Unknown never advances toward an irreversible action" rule is encoded.
export type Effect =
  | 'firePreauth'
  | 'fireSolvencyCheck'
  | 'persistInFlight' // write-ahead: persist the in-flight state BEFORE the side-effecting call
  | 'submitPay' // submit pay() with the order's current (fresh) seq
  | 'submitReplacementSameSeq' // UsdcDead retry: SAME seq S, new timebounds
  | 'reallocateSeq' // UsdcReverted 'other': NEW seq, then submit (never same-seq)
  | 'confirmBurnedSeq' // tx landed + reverted → burn the seq
  | 'releaseSeq' // true-abandonment: return the unburned seq to the pool
  | 'releaseReservation'
  | 'firePostauth' // capture the frozen TRY
  | 'fireCancel' // iyzico.cancel — void the live TRY hold
  | 'flagLoss' // LossReview: record the one irreversible-loss bucket
  | 'handToReconciler'
  | 'rePollObserveOnly'; // recover / stay / Unknown: observe again, NEVER a new external mutation

/** Effects that move money or place/void an authorization — forbidden on Unknown/stay/recover transitions. */
export const MUTATION_EFFECTS: readonly Effect[] = [
  'firePreauth',
  'submitPay',
  'submitReplacementSameSeq',
  'reallocateSeq',
  'firePostauth',
  'fireCancel',
];

export type Event =
  // Reserved (preauth is 3-valued — D8)
  | { readonly type: 'preauthOk' }
  | { readonly type: 'preauthRejected' }
  | { readonly type: 'preauthUnknown' }
  // TryPreauthed (solvency is 3-valued — D4)
  | { readonly type: 'solvencyOk' }
  | { readonly type: 'solvencyFail' }
  | { readonly type: 'solvencyUnknown' }
  // crash/restart recovery (observation-only — D5)
  | { readonly type: 'recover' }
  // evidence observation (UsdcSubmitted rows + shared with UsdcPending)
  | { readonly type: 'evidenceSuccess' }
  | { readonly type: 'evidenceReverted' }
  | { readonly type: 'evidencePending' }
  // UsdcPending poll (D3)
  | { readonly type: 'pollDead' }
  | { readonly type: 'pollStillPending' }
  // UsdcDead retry budget
  | { readonly type: 'deadRetry'; readonly retriesRemaining: boolean }
  // UsdcReverted classification (D2)
  | { readonly type: 'revertAlreadyProcessed' }
  | { readonly type: 'revertBalanceGuard' }
  | { readonly type: 'revertOther' }
  // UsdcConfirmed
  | { readonly type: 'captureWriteAhead' }
  | { readonly type: 'holdExpired' }
  // CaptureSubmitted (capture is 3-valued — ⑥)
  | { readonly type: 'captureSuccess' }
  | { readonly type: 'captureUnknown' }
  | { readonly type: 'captureFailed'; readonly retriesRemaining: boolean }
  // TryCaptured
  | { readonly type: 'reconciled' }
  // void-pending (void is 3-valued — D1)
  | { readonly type: 'voidConfirmed' }
  | { readonly type: 'voidUnknown' }
  | { readonly type: 'voidNotVoided' };

export type EventType = Event['type'];

export type TransitionResult =
  | { readonly status: 'transition'; readonly next: State; readonly effects: readonly Effect[] }
  | { readonly status: 'ignored' }
  | { readonly status: 'rejected'; readonly reason: string };

function t(next: State, effects: readonly Effect[]): TransitionResult {
  return { status: 'transition', next, effects };
}
function rejected(state: State, event: Event): TransitionResult {
  return { status: 'rejected', reason: `no transition for event '${event.type}' in state '${state}'` };
}

/** The entry point: a freshly reserved order (seq allocated + reservation held) fires the PreAuth. */
export function initialState(): { state: State; effects: readonly Effect[] } {
  return { state: 'Reserved', effects: ['firePreauth'] };
}

/**
 * Pure, total transition function. Returns 'transition' for a table-listed edge, 'ignored' for a benign
 * duplicate on an absolute terminal (or a non-reconciler event on TryCaptured), and 'rejected' for any
 * undefined (state, event) pair. Never throws.
 */
export function transition(state: State, event: Event): TransitionResult {
  // D7 — absolute terminals absorb any redelivered event with no state change and no effect.
  if (ABSOLUTE_TERMINALS.has(state)) return { status: 'ignored' };

  // D1 — void-pending states share the 3-valued void sub-machine.
  if (VOID_PENDING.has(state)) {
    switch (event.type) {
      case 'voidConfirmed':
        return t('TryHoldVoided', []);
      case 'voidUnknown':
        return t(state, ['rePollObserveOnly']); // re-poll cancel, never a new cancel
      case 'voidNotVoided':
        return t(state, ['fireCancel']); // bounded retry cancel
      default:
        return rejected(state, event);
    }
  }

  switch (state) {
    case 'Reserved':
      switch (event.type) {
        case 'preauthOk':
          return t('TryPreauthed', ['fireSolvencyCheck']);
        case 'preauthRejected':
          return t('FailedClean', ['releaseSeq', 'releaseReservation']);
        case 'preauthUnknown':
          return t('Reserved', ['rePollObserveOnly']); // D8: never advance while hold-placement is unknown
        default:
          return rejected(state, event);
      }

    case 'TryPreauthed':
      switch (event.type) {
        case 'solvencyOk':
          return t('UsdcSubmitted', ['persistInFlight', 'submitPay']);
        case 'solvencyFail':
          return t('SolvencyRejected', ['fireCancel']);
        case 'solvencyUnknown':
          return t('TryPreauthed', ['rePollObserveOnly']); // D4: never submit pay() on Unknown
        default:
          return rejected(state, event);
      }

    case 'UsdcSubmitted':
      switch (event.type) {
        case 'recover':
          return t('UsdcSubmitted', ['rePollObserveOnly']); // D5: read evidence only, no resubmit
        case 'evidenceSuccess':
          return t('UsdcConfirmed', []);
        case 'evidenceReverted':
          return t('UsdcReverted', ['confirmBurnedSeq']);
        case 'evidencePending':
          return t('UsdcPending', ['rePollObserveOnly']);
        default:
          return rejected(state, event);
      }

    case 'UsdcPending':
      switch (event.type) {
        case 'pollStillPending':
          return t('UsdcPending', ['rePollObserveOnly']); // D3
        case 'pollDead':
          return t('UsdcDead', []);
        case 'evidenceSuccess':
          return t('UsdcConfirmed', []);
        case 'evidenceReverted':
          return t('UsdcReverted', ['confirmBurnedSeq']); // D3
        default:
          return rejected(state, event);
      }

    case 'UsdcDead':
      switch (event.type) {
        case 'deadRetry':
          return event.retriesRemaining
            ? t('UsdcSubmitted', ['persistInFlight', 'submitReplacementSameSeq'])
            : t('AbandonedSeqReturned', ['releaseSeq', 'releaseReservation', 'fireCancel']); // D1: void the hold
        default:
          return rejected(state, event);
      }

    case 'UsdcReverted':
      switch (event.type) {
        case 'revertAlreadyProcessed':
          return t('UsdcConfirmed', []); // D2a: prior pay() sent USDC → capture the TRY (never Reconciled)
        case 'revertBalanceGuard':
          return t('SolvencyRejected', ['releaseReservation', 'fireCancel']); // D2b: clean, no loss (seq already burned)
        case 'revertOther':
          return t('UsdcSubmitted', ['reallocateSeq', 'persistInFlight', 'submitPay']); // D2c: NEW seq
        default:
          return rejected(state, event);
      }

    case 'UsdcConfirmed':
      switch (event.type) {
        case 'captureWriteAhead':
          return t('CaptureSubmitted', ['persistInFlight', 'firePostauth']);
        case 'holdExpired':
          return t('LossReview', ['flagLoss', 'fireCancel']); // D6/17a defensive
        default:
          return rejected(state, event);
      }

    case 'CaptureSubmitted':
      switch (event.type) {
        case 'recover':
          return t('CaptureSubmitted', ['rePollObserveOnly']); // D5: re-poll retrieve only, no new capture
        case 'captureSuccess':
          return t('TryCaptured', ['handToReconciler']);
        case 'captureUnknown':
          return t('CaptureSubmitted', ['rePollObserveOnly']); // ⑥: never a new capture on Unknown
        case 'captureFailed':
          return event.retriesRemaining
            ? t('CaptureSubmitted', ['firePostauth']) // bounded retry (definitely-not-captured is safe to retry)
            : t('LossReview', ['flagLoss', 'fireCancel']); // D6/17b: USDC sent + capture failed = real loss
        default:
          return rejected(state, event);
      }

    case 'TryCaptured':
      switch (event.type) {
        case 'reconciled':
          return t('Reconciled', []);
        default:
          return { status: 'ignored' }; // D7/32: duplicate capture-family events are benign here
      }

    default:
      return rejected(state, event);
  }
}
