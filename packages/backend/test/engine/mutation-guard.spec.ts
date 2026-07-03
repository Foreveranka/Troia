import { describe, expect, it } from 'vitest';
import { ALL_STATES, MUTATION_EFFECTS, transition } from '@troia/core';
import type { Event } from '@troia/core';
import {
  assertNoMutationOnUnknown,
  containsMutation,
  isObserveOnlyEvent,
} from '../../src/engine/mutation-guard.js';

// A representative value of EVERY event type (the 3-valued families + backend-decision + recovery events).
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

describe('mutation-on-uncertainty guard (property over the whole core table)', () => {
  // EFFECT-DRIVEN (not gated on the predicate under test, so it catches an incomplete predicate): the GROUND
  // TRUTH is the effect list. Every transition that emits rePollObserveOnly is observe-only, so it must (a)
  // carry no mutation, and (b) have its triggering event classified observe-only by isObserveOnlyEvent —
  // otherwise the guard has a blind spot (this is exactly what caught evidencePending).
  it('every rePollObserveOnly transition is mutation-free AND its event is classified observe-only', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const r = transition(state, event);
        if (r.status !== 'transition' || !r.effects.includes('rePollObserveOnly')) continue;
        expect(containsMutation(r.effects), `${state}/${event.type} must not mutate`).toBe(false);
        expect(isObserveOnlyEvent(event), `${state}/${event.type} must be classified observe-only`).toBe(true);
      }
    }
  });

  it('the guard never throws on any real observe-only transition', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (!isObserveOnlyEvent(event)) continue;
        const r = transition(state, event);
        if (r.status === 'transition') {
          expect(() => assertNoMutationOnUnknown(event, r.effects), `${state}/${event.type}`).not.toThrow();
        }
      }
    }
  });

  it('the guard THROWS if a mutation effect is ever paired with an observe-only event (synthetic)', () => {
    const oneMutation = MUTATION_EFFECTS.slice(0, 1);
    expect(() => assertNoMutationOnUnknown({ type: 'preauthUnknown' }, oneMutation)).toThrow();
    expect(() => assertNoMutationOnUnknown({ type: 'recover' }, oneMutation)).toThrow();
    // a non-observe-only event with a mutation is fine
    expect(() => assertNoMutationOnUnknown({ type: 'solvencyOk' }, oneMutation)).not.toThrow();
  });
});
