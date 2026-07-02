import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_TERMINAL_STATES,
  ALL_STATES,
  initialState,
  isAbsoluteTerminal,
  isVoidPending,
  MUTATION_EFFECTS,
  transition,
  VOID_PENDING_STATES,
} from '../src/index.js';
import type { Effect, Event, State, TransitionResult } from '../src/index.js';

const ALL_EVENTS: readonly Event[] = [
  { type: 'preauthOk' },
  { type: 'preauthRejected' },
  { type: 'preauthUnknown' },
  { type: 'solvencyOk' },
  { type: 'solvencyFail' },
  { type: 'solvencyUnknown' },
  { type: 'recover' },
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
  { type: 'captureWriteAhead' },
  { type: 'holdExpired' },
  { type: 'captureSuccess' },
  { type: 'captureUnknown' },
  { type: 'captureFailed', retriesRemaining: true },
  { type: 'captureFailed', retriesRemaining: false },
  { type: 'reconciled' },
  { type: 'voidConfirmed' },
  { type: 'voidUnknown' },
  { type: 'voidNotVoided' },
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

const OBSERVE_ONLY_EVENTS = new Set([
  'preauthUnknown',
  'solvencyUnknown',
  'captureUnknown',
  'voidUnknown',
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
      expect(isVoidPending(s)).toBe(false);
    }
    for (const s of VOID_PENDING_STATES) {
      expect(isVoidPending(s)).toBe(true);
      expect(isAbsoluteTerminal(s)).toBe(false);
    }
    expect(ALL_STATES.length).toBe(15);
  });

  it('initialState is Reserved and fires the preauth', () => {
    const init = initialState();
    expect(init.state).toBe('Reserved');
    expect(init.effects).toEqual(['firePreauth']);
  });
});

describe('state machine — reachability & terminals (D7)', () => {
  it('every one of the 15 states is reachable from Reserved', () => {
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

  it('every non-absolute-terminal state has at least one outgoing transition', () => {
    for (const s of ALL_STATES) {
      if (isAbsoluteTerminal(s)) continue;
      const hasOut = ALL_EVENTS.some((e) => transition(s, e).status === 'transition');
      expect(hasOut, `state ${s} has no outgoing transition`).toBe(true);
    }
  });

  it('TryCaptured advances only on reconciled and ignores duplicates', () => {
    expect(transition('TryCaptured', { type: 'reconciled' })).toEqual({
      status: 'transition',
      next: 'Reconciled',
      effects: [],
    });
    expect(transition('TryCaptured', { type: 'captureSuccess' }).status).toBe('ignored');
  });
});

describe('state machine — money-safety invariants', () => {
  const transitions = allEdges().filter(
    (e): e is Edge & { result: { status: 'transition'; next: State; effects: readonly Effect[] } } =>
      e.result.status === 'transition',
  );

  it('Reconciled is reachable ONLY via TryCaptured + reconciled', () => {
    const intoReconciled = transitions.filter((e) => e.result.next === 'Reconciled');
    expect(intoReconciled).toHaveLength(1);
    expect(intoReconciled[0]!.state).toBe('TryCaptured');
    expect(intoReconciled[0]!.event.type).toBe('reconciled');
  });

  it('entering a void-pending state always fires the cancel (no stranded TRY hold)', () => {
    const voidPending = new Set<State>(VOID_PENDING_STATES);
    for (const e of transitions) {
      if (voidPending.has(e.result.next) && e.result.next !== e.state) {
        expect(e.result.effects, `entry ${e.state}->${e.result.next} must void`).toContain('fireCancel');
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

  it('DEAD reuses the SAME seq while REVERTED-other reallocates a NEW seq', () => {
    const deadRetry = transition('UsdcDead', { type: 'deadRetry', retriesRemaining: true });
    const revertOther = transition('UsdcReverted', { type: 'revertOther' });
    expect(deadRetry.status).toBe('transition');
    expect(revertOther.status).toBe('transition');
    if (deadRetry.status === 'transition') {
      expect(deadRetry.effects).toContain('submitReplacementSameSeq');
      expect(deadRetry.effects).not.toContain('reallocateSeq');
    }
    if (revertOther.status === 'transition') {
      expect(revertOther.effects).toContain('reallocateSeq');
      expect(revertOther.effects).not.toContain('submitReplacementSameSeq');
    }
  });

  it('UsdcReverted classify: AlreadyProcessed -> UsdcConfirmed, BalanceGuard -> SolvencyRejected', () => {
    const ap = transition('UsdcReverted', { type: 'revertAlreadyProcessed' });
    const bg = transition('UsdcReverted', { type: 'revertBalanceGuard' });
    expect(ap.status === 'transition' && ap.next).toBe('UsdcConfirmed'); // NOT Reconciled (D2a)
    expect(bg.status === 'transition' && bg.next).toBe('SolvencyRejected'); // NOT LossReview (D2b)
  });

  it('write-ahead precedes every entering submit/postauth (D5)', () => {
    const writeGuarded: readonly Effect[] = ['submitPay', 'submitReplacementSameSeq', 'firePostauth'];
    for (const e of transitions) {
      if (e.result.next === e.state) continue; // self-loop retries already persisted on entry
      const effects = e.result.effects;
      for (const guarded of writeGuarded) {
        const gi = effects.indexOf(guarded);
        if (gi >= 0) {
          const pi = effects.indexOf('persistInFlight');
          expect(pi, `${e.state}->${e.result.next} must persist before ${guarded}`).toBeGreaterThanOrEqual(0);
          expect(pi).toBeLessThan(gi);
        }
      }
    }
  });
});

describe('state machine — canonical walks', () => {
  it('happy path: Reserved -> ... -> Reconciled', () => {
    const steps: [State, Event, State][] = [
      ['Reserved', { type: 'preauthOk' }, 'TryPreauthed'],
      ['TryPreauthed', { type: 'solvencyOk' }, 'UsdcSubmitted'],
      ['UsdcSubmitted', { type: 'evidenceSuccess' }, 'UsdcConfirmed'],
      ['UsdcConfirmed', { type: 'captureWriteAhead' }, 'CaptureSubmitted'],
      ['CaptureSubmitted', { type: 'captureSuccess' }, 'TryCaptured'],
      ['TryCaptured', { type: 'reconciled' }, 'Reconciled'],
    ];
    for (const [from, event, to] of steps) {
      const r = transition(from, event);
      expect(r.status).toBe('transition');
      if (r.status === 'transition') expect(r.next).toBe(to);
    }
  });

  it('solvency-fail path voids the hold: TryPreauthed -> SolvencyRejected -> TryHoldVoided', () => {
    const r1 = transition('TryPreauthed', { type: 'solvencyFail' });
    expect(r1).toEqual({ status: 'transition', next: 'SolvencyRejected', effects: ['fireCancel'] });
    const r2 = transition('SolvencyRejected', { type: 'voidConfirmed' });
    expect(r2).toEqual({ status: 'transition', next: 'TryHoldVoided', effects: [] });
  });

  it('dead -> abandonment releases seq AND voids the hold (D1)', () => {
    const r = transition('UsdcDead', { type: 'deadRetry', retriesRemaining: false });
    expect(r.status).toBe('transition');
    if (r.status === 'transition') {
      expect(r.next).toBe('AbandonedSeqReturned');
      expect(r.effects).toEqual(['releaseSeq', 'releaseReservation', 'fireCancel']);
    }
  });

  it('void 3-valued: Unknown stays (no new cancel), NotVoided retries', () => {
    expect(transition('LossReview', { type: 'voidUnknown' })).toEqual({
      status: 'transition',
      next: 'LossReview',
      effects: ['rePollObserveOnly'],
    });
    expect(transition('LossReview', { type: 'voidNotVoided' })).toEqual({
      status: 'transition',
      next: 'LossReview',
      effects: ['fireCancel'],
    });
  });
});

describe('state machine — rejects undefined pairs', () => {
  it('rejects events that do not belong to the state', () => {
    expect(transition('Reserved', { type: 'solvencyOk' }).status).toBe('rejected');
    expect(transition('UsdcConfirmed', { type: 'captureSuccess' }).status).toBe('rejected');
    expect(transition('TryPreauthed', { type: 'voidConfirmed' }).status).toBe('rejected');
  });
});
