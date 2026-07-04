// Settlement state machine — the single source of truth (docs/ARCHITECTURE.md §3, troia-olay-orgusu.md §4).
// A PURE, TOTAL reducer: transition(state, event) returns a result and NEVER throws. Side effects are
// returned as descriptors (data), not executed here — the backend (Phase 4) performs them and feeds the
// results back as the next event.
//
// MONEY-FIRST ordering (Phase 4.6): reserve solvency FIRST (before the user is charged), then CHARGE the
// TRY via a direct hosted-sale form (NO preauth/hold), then submit the IRREVERSIBLE USDC leg LAST. This
// places the only irreversible action at the very end, after the reversible TRY charge is secured, so a
// failed USDC send unwinds by voiding the completed sale (reversible) instead of a permanent LossReview.
// The user is never charged unless a USDC reservation is already held (fail-closed at /intent).

export type State =
  | 'Reserved' // order created, seq allocated; about to reserve pool solvency
  | 'SolvencyReserved' // reservation held, direct-sale hosted form shown; awaiting the charge outcome
  | 'UsdcSubmitted'
  | 'UsdcConfirmed' // USDC landed; awaiting the offline reconciler (no capture leg anymore)
  | 'UsdcPending'
  | 'UsdcDead'
  | 'UsdcReverted'
  | 'ChargeReversing' // USDC failed after the charge → void the completed sale (same-day /payment/cancel)
  | 'ChargeReversed' // the sale was voided; the customer's TRY is returned. Clean terminal.
  | 'Reconciled'
  | 'LossReview' // manual sink: USDC fate genuinely unknown, or a reversal that could not complete
  | 'FailedClean'; // charge declined / solvency rejected before any charge — nothing moved

export const ALL_STATES: readonly State[] = [
  'Reserved',
  'SolvencyReserved',
  'UsdcSubmitted',
  'UsdcConfirmed',
  'UsdcPending',
  'UsdcDead',
  'UsdcReverted',
  'ChargeReversing',
  'ChargeReversed',
  'Reconciled',
  'LossReview',
  'FailedClean',
];

/** Clean absolute terminals: any event is an idempotent no-op (at-least-once redelivery, D7). */
export const ABSOLUTE_TERMINAL_STATES = ['Reconciled', 'FailedClean', 'ChargeReversed'] as const;
/** Reversal-pending: a completed TRY sale is being voided; the void call is 3-valued (mirrors the old void
 *  sub-machine). reversalConfirmed → ChargeReversed; exhausted budget → LossReview (durable, NOT silent). */
export const REVERSAL_PENDING_STATES = ['ChargeReversing'] as const;

const ABSOLUTE_TERMINALS: ReadonlySet<State> = new Set(ABSOLUTE_TERMINAL_STATES);
const REVERSAL_PENDING: ReadonlySet<State> = new Set(REVERSAL_PENDING_STATES);

export function isAbsoluteTerminal(state: State): boolean {
  return ABSOLUTE_TERMINALS.has(state);
}
export function isReversalPending(state: State): boolean {
  return REVERSAL_PENDING.has(state);
}
/** LossReview is a manual sink: no automated transition leaves it; it absorbs redeliveries like a terminal. */
export function isManualReview(state: State): boolean {
  return state === 'LossReview';
}

// Side-effect descriptors. `rePollObserveOnly` is load-bearing: it is the ONLY effect emitted on
// Unknown / recover / stay transitions, and it must never carry an external mutation — this is how the
// "Unknown never advances toward an irreversible action" rule is encoded.
export type Effect =
  | 'fireSolvencyCheck' // reserve pool USDC BEFORE the user can be charged (moved to the front, D-4.6)
  | 'fireCheckoutForm' // initialize the direct-SALE hosted form (replaces the preauth form)
  | 'persistInFlight' // write-ahead: persist the in-flight state BEFORE the side-effecting call
  | 'submitPay' // submit pay() with the order's current (fresh) seq
  | 'submitReplacementSameSeq' // UsdcDead retry / never-sent recovery: SAME seq S, new timebounds
  | 'reallocateSeq' // UsdcReverted 'other': NEW seq, then submit (never same-seq)
  | 'confirmBurnedSeq' // tx landed + reverted → burn the seq
  | 'releaseSeq' // true-abandonment: return the unburned seq to the pool
  | 'releaseReservation'
  | 'fireCancel' // iyzico.cancel — void the completed TRY sale (same-day reversal)
  | 'flagLoss' // LossReview: record the one irreversible-loss / stuck-reversal bucket
  | 'handToReconciler'
  | 'rePollObserveOnly'; // recover / stay / Unknown: observe again, NEVER a new external mutation

/** Effects that move money or place/void a charge — forbidden on Unknown/stay/recover transitions. */
export const MUTATION_EFFECTS: readonly Effect[] = [
  'fireCheckoutForm',
  'submitPay',
  'submitReplacementSameSeq',
  'reallocateSeq',
  'fireCancel',
];

export type Event =
  // Reserved (solvency is 3-valued — reserve is now FIRST)
  | { readonly type: 'solvencyOk' }
  | { readonly type: 'solvencyFail' }
  | { readonly type: 'solvencyUnknown' }
  // SolvencyReserved (the direct sale is 3-valued; outcome arrives via the webhook retrieve)
  | { readonly type: 'chargeOk' }
  | { readonly type: 'chargeRejected' }
  | { readonly type: 'chargeUnknown' }
  | { readonly type: 'checkoutInitFailed' } // the hosted-form init itself failed (nothing charged)
  // crash/restart recovery
  | { readonly type: 'recover' } // observe-only: a landed pay() witness exists (hashHex set)
  | { readonly type: 'recoverResubmit' } // pay() was never sent (hashHex null, charge done) → same-seq submit
  // evidence observation (UsdcSubmitted rows + shared with UsdcPending)
  | { readonly type: 'evidenceSuccess' }
  | { readonly type: 'evidenceReverted' }
  | { readonly type: 'evidencePending' }
  // UsdcPending poll
  | { readonly type: 'pollDead' }
  | { readonly type: 'pollStillPending' }
  // UsdcDead retry budget
  | { readonly type: 'deadRetry'; readonly retriesRemaining: boolean }
  // UsdcReverted classification
  | { readonly type: 'revertAlreadyProcessed' }
  | { readonly type: 'revertBalanceGuard' }
  | { readonly type: 'revertOther' }
  // UsdcConfirmed
  | { readonly type: 'reconciled' }
  // ChargeReversing (the void is 3-valued)
  | { readonly type: 'reversalConfirmed' }
  | { readonly type: 'reversalUnknown' }
  | { readonly type: 'reversalNotDone'; readonly retriesRemaining: boolean };

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

/** The entry point: a freshly reserved order (seq allocated) reserves pool solvency BEFORE any charge. */
export function initialState(): { state: State; effects: readonly Effect[] } {
  return { state: 'Reserved', effects: ['fireSolvencyCheck'] };
}

/**
 * Pure, total transition function. Returns 'transition' for a table-listed edge, 'ignored' for a benign
 * duplicate on an absolute terminal / manual sink (or a non-reconciler event on UsdcConfirmed), and
 * 'rejected' for any undefined (state, event) pair. Never throws.
 */
export function transition(state: State, event: Event): TransitionResult {
  // Absolute terminals + the manual review sink absorb any redelivered event with no state change.
  if (ABSOLUTE_TERMINALS.has(state) || state === 'LossReview') return { status: 'ignored' };

  // The reversal-pending sub-machine: void a completed sale, 3-valued. Exhausted budget → LossReview
  // with a DURABLE flag (a failed refund does NOT self-heal, so it must be observable, not silently parked).
  if (REVERSAL_PENDING.has(state)) {
    switch (event.type) {
      case 'reversalConfirmed':
        return t('ChargeReversed', []);
      case 'reversalUnknown':
        return t(state, ['rePollObserveOnly']); // re-poll the void, never a new cancel
      case 'reversalNotDone':
        return event.retriesRemaining ? t(state, ['fireCancel']) : t('LossReview', ['flagLoss']);
      default:
        return rejected(state, event);
    }
  }

  switch (state) {
    case 'Reserved':
      switch (event.type) {
        case 'solvencyOk':
          return t('SolvencyReserved', ['fireCheckoutForm']); // reserve held → show the direct-sale form
        case 'solvencyFail':
          return t('FailedClean', ['releaseSeq']); // nothing committed; the allocated seq goes back
        case 'solvencyUnknown':
          return t('Reserved', ['rePollObserveOnly']); // never charge while solvency is unknown
        default:
          return rejected(state, event);
      }

    case 'SolvencyReserved':
      switch (event.type) {
        case 'chargeOk':
          return t('UsdcSubmitted', ['persistInFlight', 'submitPay']); // TRY charged → USDC leg (LAST)
        case 'chargeRejected':
          return t('FailedClean', ['releaseSeq', 'releaseReservation']); // sale declined, nothing taken
        case 'chargeUnknown':
          return t('SolvencyReserved', ['rePollObserveOnly']); // NEVER submit USDC on an unknown charge
        case 'checkoutInitFailed':
          return t('FailedClean', ['releaseSeq', 'releaseReservation']); // form never opened, nothing taken
        default:
          return rejected(state, event);
      }

    case 'UsdcSubmitted':
      switch (event.type) {
        case 'recover':
          return t('UsdcSubmitted', ['rePollObserveOnly']); // witness exists → read evidence only, no resubmit
        case 'recoverResubmit':
          // A crash between the charge and submitPay left this row with NO pay() witness (hashHex null) but
          // the seq still active and the TRY already charged. The pay was never sent; a same-seq replacement
          // is money-safe (the sequence shield lets at most one tx land). This is NOT an irreversible loss.
          return t('UsdcSubmitted', ['persistInFlight', 'submitReplacementSameSeq']);
        case 'evidenceSuccess':
          return t('UsdcConfirmed', ['handToReconciler']);
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
          return t('UsdcPending', ['rePollObserveOnly']);
        case 'pollDead':
          return t('UsdcDead', []);
        case 'evidenceSuccess':
          return t('UsdcConfirmed', ['handToReconciler']);
        case 'evidenceReverted':
          return t('UsdcReverted', ['confirmBurnedSeq']);
        default:
          return rejected(state, event);
      }

    case 'UsdcDead':
      switch (event.type) {
        case 'deadRetry':
          return event.retriesRemaining
            ? t('UsdcSubmitted', ['persistInFlight', 'submitReplacementSameSeq'])
            : t('ChargeReversing', ['releaseSeq', 'releaseReservation', 'fireCancel']); // void the sale
        default:
          return rejected(state, event);
      }

    case 'UsdcReverted':
      switch (event.type) {
        case 'revertAlreadyProcessed':
          // A prior pay() on this order already delivered USDC; treat as confirmed. Do NOT handToReconciler
          // here — ctx.hashHex is the REVERTED tx, not the successful one; the offline reconciler resolves
          // ground truth from the full evidence chain.
          return t('UsdcConfirmed', []);
        case 'revertBalanceGuard':
          return t('ChargeReversing', ['releaseReservation', 'fireCancel']); // USDC didn't move → void the sale
        case 'revertOther':
          return t('UsdcSubmitted', ['reallocateSeq', 'persistInFlight', 'submitPay']); // NEW seq
        default:
          return rejected(state, event);
      }

    case 'UsdcConfirmed':
      switch (event.type) {
        case 'reconciled':
          return t('Reconciled', []);
        default:
          return { status: 'ignored' }; // duplicate evidence/redeliveries are benign here
      }

    default:
      return rejected(state, event);
  }
}
