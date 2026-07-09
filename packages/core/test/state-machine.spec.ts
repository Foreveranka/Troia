import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_TERMINAL_STATES,
  ALL_STATES,
  initialState,
  isAbsoluteTerminal,
  isManualReview,
  isReversalPending,
  MUTATION_EFFECTS,
  REVERSAL_PENDING_STATES,
  transition,
} from '../src/index.js';
import type { Effect, Event, State, TransitionResult } from '../src/index.js';

// MONEY-FIRST model (Phase 4.6): reserve FIRST → charge the TRY (direct sale, no preauth) → submit the
// irreversible USDC leg LAST → on USDC failure void the completed sale. No capture/hold machinery.

const ALL_EVENTS: readonly Event[] = [
  { type: 'solvencyOk' },
  { type: 'solvencyFail' },
  { type: 'solvencyUnknown' },
  { type: 'chargeOk' },
  { type: 'chargeRejected' },
  { type: 'chargeUnknown' },
  { type: 'checkoutInitFailed' },
  { type: 'recover' },
  { type: 'recoverResubmit' },
  { type: 'evidenceSuccess' },
  { type: 'evidenceReverted' },
  { type: 'evidencePending' },
  { type: 'pollDead' },
  { type: 'pollStillPending' },
  { type: 'deadRetry', retriesRemaining: true },
  { type: 'deadRetry', retriesRemaining: false },
  { type: 'revertAlreadyProcessed' },
  { type: 'revertBalanceGuard' },
  { type: 'revertOther' },
  { type: 'reconciled' },
  { type: 'reversalConfirmed' },
  { type: 'reversalUnknown' },
  { type: 'reversalNotDone', retriesRemaining: true },
  { type: 'reversalNotDone', retriesRemaining: false },
];

interface Edge {
  state: State;
  event: Event;
  result: TransitionResult;
}

function allEdges(): Edge[] {
  const out: Edge[] = [];
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      out.push({ state, event, result: transition(state, event) });
    }
  }
  return out;
}

// Observe-only events must never carry an external mutation. recoverResubmit is DELIBERATELY excluded:
// it is a positively-proven-safe same-seq resubmit of a never-sent pay(), not an observe-only stay.
const OBSERVE_ONLY_EVENTS = new Set([
  'solvencyUnknown',
  'chargeUnknown',
  'reversalUnknown',
  'recover',
  'evidencePending',
  'pollStillPending',
]);

const MUTATIONS = new Set<Effect>(MUTATION_EFFECTS);

describe('state machine — totality & shape', () => {
  it('never throws and always returns one of the three statuses', () => {
    for (const { result } of allEdges()) {
      expect(['transition', 'ignored', 'rejected']).toContain(result.status);
    }
  });

  it('state classes are disjoint and cover the terminals correctly', () => {
    for (const s of ABSOLUTE_TERMINAL_STATES) {
      expect(isAbsoluteTerminal(s)).toBe(true);
      expect(isReversalPending(s)).toBe(false);
      expect(isManualReview(s)).toBe(false);
    }
    for (const s of REVERSAL_PENDING_STATES) {
      expect(isReversalPending(s)).toBe(true);
      expect(isAbsoluteTerminal(s)).toBe(false);
    }
    expect(isManualReview('LossReview')).toBe(true);
    expect(ALL_STATES.length).toBe(12);
  });

  it('initialState is Reserved and reserves solvency FIRST (before any charge)', () => {
    const init = initialState();
    expect(init.state).toBe('Reserved');
    expect(init.effects).toEqual(['fireSolvencyCheck']);
  });
});

describe('state machine — reachability & terminals (D7)', () => {
  it('every one of the 12 states is reachable from Reserved', () => {
    const reachable = new Set<State>(['Reserved']);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of [...reachable]) {
        for (const e of ALL_EVENTS) {
          const r = transition(s, e);
          if (r.status === 'transition' && !reachable.has(r.next)) {
            reachable.add(r.next);
            changed = true;
          }
        }
      }
    }
    expect(reachable.size).toBe(ALL_STATES.length);
  });

  it('absolute terminals absorb every event as an idempotent no-op', () => {
    for (const s of ABSOLUTE_TERMINAL_STATES) {
      for (const e of ALL_EVENTS) {
        expect(transition(s, e).status).toBe('ignored');
      }
    }
  });

  it('LossReview is a manual sink — absorbs every event, never auto-advances', () => {
    for (const e of ALL_EVENTS) {
      expect(transition('LossReview', e).status).toBe('ignored');
    }
  });

  it('every state that is not a terminal/sink has at least one outgoing transition', () => {
    for (const s of ALL_STATES) {
      if (isAbsoluteTerminal(s) || isManualReview(s)) continue;
      const hasOut = ALL_EVENTS.some((e) => transition(s, e).status === 'transition');
      expect(hasOut, `state ${s} has no outgoing transition`).toBe(true);
    }
  });

  it('UsdcConfirmed advances only on reconciled and ignores duplicates', () => {
    expect(transition('UsdcConfirmed', { type: 'reconciled' })).toEqual({
      status: 'transition',
      next: 'Reconciled',
      effects: [],
    });
    expect(transition('UsdcConfirmed', { type: 'evidenceSuccess' }).status).toBe('ignored');
  });
});

describe('state machine — money-safety invariants', () => {
  const transitions = allEdges().filter(
    (
      e,
    ): e is Edge & { result: { status: 'transition'; next: State; effects: readonly Effect[] } } =>
      e.result.status === 'transition',
  );

  it('Reconciled is reachable ONLY via UsdcConfirmed + reconciled', () => {
    const intoReconciled = transitions.filter((e) => e.result.next === 'Reconciled');
    expect(intoReconciled).toHaveLength(1);
    expect(intoReconciled[0]!.state).toBe('UsdcConfirmed');
    expect(intoReconciled[0]!.event.type).toBe('reconciled');
  });

  it('the irreversible USDC submit never fires before the TRY charge, nor on an unknown charge', () => {
    const submits = new Set<Effect>(['submitPay', 'submitReplacementSameSeq']);
    for (const e of transitions) {
      const carriesSubmit = e.result.effects.some((eff) => submits.has(eff));
      if (!carriesSubmit) continue;
      // A submit may only be reached AFTER the charge (from a post-charge state), never from Reserved/
      // SolvencyReserved on an ambiguous event.
      expect(e.state, `submit fired from ${e.state}`).not.toBe('Reserved');
      if (e.state === 'SolvencyReserved') expect(e.event.type).toBe('chargeOk');
    }
  });

  it('entering a reversal-pending state always voids the completed sale (no stranded charge)', () => {
    const pending = new Set<State>(REVERSAL_PENDING_STATES);
    for (const e of transitions) {
      if (pending.has(e.result.next) && e.result.next !== e.state) {
        expect(e.result.effects, `entry ${e.state}->${e.result.next} must void`).toContain(
          'fireCancel',
        );
      }
    }
  });

  it('Unknown / recover / stay transitions never carry a mutation effect', () => {
    for (const e of transitions) {
      if (!OBSERVE_ONLY_EVENTS.has(e.event.type)) continue;
      expect(e.result.effects).toEqual(['rePollObserveOnly']);
      for (const eff of e.result.effects) expect(MUTATIONS.has(eff)).toBe(false);
    }
  });

  it('the operator sequence is allocated LATE — only on chargeOk, never before the charge (Approach B)', () => {
    // The seq is handed out at the FIRST step of the USDC leg, so a pending/failed/abandoned order holds none.
    const allocs = transitions.filter((e) => e.result.effects.includes('allocateSeq' as Effect));
    expect(allocs).toHaveLength(1); // exactly one edge allocates a seq
    expect(allocs[0]!.state).toBe('SolvencyReserved');
    expect(allocs[0]!.event.type).toBe('chargeOk');
    // allocateSeq is FIRST so persistInFlight/submitPay downstream read the freshly-allocated seq
    expect(allocs[0]!.result.effects).toEqual(['allocateSeq', 'persistInFlight', 'submitPay']);
  });

  it('no pre-charge edge (Reserved, or a non-chargeOk SolvencyReserved event) touches the sequence', () => {
    // Money-safety of late allocation: nothing before the charge may allocate/release/burn a seq — the whole
    // point is that an order that never charges leaves the operator sequence space untouched (no gap).
    const seqEffects = new Set<Effect>([
      'allocateSeq' as Effect,
      'releaseSeq',
      'reallocateSeq',
      'confirmBurnedSeq',
    ]);
    for (const e of transitions) {
      const preCharge =
        e.state === 'Reserved' || (e.state === 'SolvencyReserved' && e.event.type !== 'chargeOk');
      if (!preCharge) continue;
      for (const eff of e.result.effects) {
        expect(seqEffects.has(eff), `${e.state}/${e.event.type} must not touch the seq`).toBe(
          false,
        );
      }
    }
  });

  it('allocateSeq is a MUTATION_EFFECT (can never sit on an observe-only edge)', () => {
    expect(MUTATIONS.has('allocateSeq' as Effect)).toBe(true);
  });

  it('DEAD reuses the SAME seq while REVERTED-other reallocates a NEW seq', () => {
    const deadRetry = transition('UsdcDead', { type: 'deadRetry', retriesRemaining: true });
    const revertOther = transition('UsdcReverted', { type: 'revertOther' });
    if (deadRetry.status === 'transition') {
      expect(deadRetry.effects).toContain('submitReplacementSameSeq');
      expect(deadRetry.effects).not.toContain('reallocateSeq');
    } else {
      throw new Error('deadRetry should transition');
    }
    if (revertOther.status === 'transition') {
      expect(revertOther.effects).toContain('reallocateSeq');
      expect(revertOther.effects).not.toContain('submitReplacementSameSeq');
    } else {
      throw new Error('revertOther should transition');
    }
  });

  it('UsdcReverted classify: AlreadyProcessed -> UsdcConfirmed (no handToReconciler), BalanceGuard -> ChargeReversing', () => {
    const ap = transition('UsdcReverted', { type: 'revertAlreadyProcessed' });
    const bg = transition('UsdcReverted', { type: 'revertBalanceGuard' });
    expect(ap).toEqual({ status: 'transition', next: 'UsdcConfirmed', effects: [] }); // reverted hash, no evidence append
    expect(bg.status === 'transition' && bg.next).toBe('ChargeReversing');
    if (bg.status === 'transition') expect(bg.effects).toContain('fireCancel');
  });

  it('recoverResubmit resends the never-sent pay() on the SAME seq, write-ahead first', () => {
    const r = transition('UsdcSubmitted', { type: 'recoverResubmit' });
    expect(r).toEqual({
      status: 'transition',
      next: 'UsdcSubmitted',
      effects: ['persistInFlight', 'submitReplacementSameSeq'],
    });
  });

  it('write-ahead precedes every entering submit (D5), self-loops included', () => {
    const writeGuarded: readonly Effect[] = ['submitPay', 'submitReplacementSameSeq'];
    for (const e of transitions) {
      const effects = e.result.effects;
      for (const guarded of writeGuarded) {
        const gi = effects.indexOf(guarded);
        if (gi >= 0) {
          const pi = effects.indexOf('persistInFlight');
          expect(
            pi,
            `${e.state}->${e.result.next} must persist before ${guarded}`,
          ).toBeGreaterThanOrEqual(0);
          expect(pi).toBeLessThan(gi);
        }
      }
    }
  });
});

describe('state machine — canonical walks', () => {
  it('happy path: Reserved -> ... -> Reconciled', () => {
    const steps: [State, Event, State][] = [
      ['Reserved', { type: 'solvencyOk' }, 'SolvencyReserved'],
      ['SolvencyReserved', { type: 'chargeOk' }, 'UsdcSubmitted'],
      ['UsdcSubmitted', { type: 'evidenceSuccess' }, 'UsdcConfirmed'],
      ['UsdcConfirmed', { type: 'reconciled' }, 'Reconciled'],
    ];
    for (const [from, event, to] of steps) {
      const r = transition(from, event);
      expect(r.status).toBe('transition');
      if (r.status === 'transition') expect(r.next).toBe(to);
    }
  });

  it('solvency-fail is clean before any charge: Reserved -> FailedClean (no seq held yet, no void)', () => {
    expect(transition('Reserved', { type: 'solvencyFail' })).toEqual({
      status: 'transition',
      next: 'FailedClean',
      effects: [], // late allocation: no seq is held before the charge, so there is nothing to release
    });
  });

  it('a declined sale is clean: SolvencyReserved -> FailedClean (release reservation only; no seq held yet, no void)', () => {
    expect(transition('SolvencyReserved', { type: 'chargeRejected' })).toEqual({
      status: 'transition',
      next: 'FailedClean',
      effects: ['releaseReservation'], // late allocation: the seq is not handed out until chargeOk
    });
  });

  it('dead -> abandonment releases seq AND voids the completed sale', () => {
    const r = transition('UsdcDead', { type: 'deadRetry', retriesRemaining: false });
    expect(r).toEqual({
      status: 'transition',
      next: 'ChargeReversing',
      effects: ['releaseSeq', 'releaseReservation', 'fireCancel'],
    });
  });

  it('reversal 3-valued: Unknown re-polls, NotVoided retries within budget then escalates to LossReview', () => {
    expect(transition('ChargeReversing', { type: 'reversalUnknown' })).toEqual({
      status: 'transition',
      next: 'ChargeReversing',
      effects: ['rePollObserveOnly'],
    });
    // budget remaining -> bounded retry void
    expect(
      transition('ChargeReversing', { type: 'reversalNotDone', retriesRemaining: true }),
    ).toEqual({
      status: 'transition',
      next: 'ChargeReversing',
      effects: ['fireCancel'],
    });
    // budget exhausted -> DURABLE flag + LossReview (a failed refund does NOT self-heal; never silent-quiesce)
    expect(
      transition('ChargeReversing', { type: 'reversalNotDone', retriesRemaining: false }),
    ).toEqual({
      status: 'transition',
      next: 'LossReview',
      effects: ['flagLoss'],
    });
  });

  it('reversal confirmed reaches the clean terminal ChargeReversed', () => {
    expect(transition('ChargeReversing', { type: 'reversalConfirmed' })).toEqual({
      status: 'transition',
      next: 'ChargeReversed',
      effects: [],
    });
  });
});

describe('state machine — rejects undefined pairs', () => {
  it('rejects events that do not belong to the state', () => {
    expect(transition('Reserved', { type: 'chargeOk' }).status).toBe('rejected');
    expect(transition('SolvencyReserved', { type: 'solvencyOk' }).status).toBe('rejected');
    expect(transition('UsdcSubmitted', { type: 'reconciled' }).status).toBe('rejected');
  });
});
