import { describe, expect, it } from 'vitest';
import { verdictToCore } from '../src/submit-reducer.js';
import type { PollVerdict } from '../src/outcomes.js';
import { transition } from '../../core/src/index.js';
import type { State } from '../../core/src/index.js';

// Proves the client and the @troia/core state machine are ONE machine: every event verdictToCore emits is
// actually accepted by core.transition in the state we claim to be in, and lands in the expected state.

function expectEvent(verdict: PollVerdict, from: State, expectNext: State): void {
  const m = verdictToCore(verdict, from);
  expect(m.kind).toBe('event');
  if (m.kind !== 'event') return;
  const r = transition(from, m.event);
  expect(r.status).toBe('transition');
  if (r.status === 'transition') expect(r.next).toBe(expectNext);
}

describe('verdictToCore — one machine with @troia/core §3', () => {
  it('LANDED_SUCCESS -> evidenceSuccess -> UsdcConfirmed', () => {
    expectEvent('LANDED_SUCCESS', 'UsdcSubmitted', 'UsdcConfirmed');
    expectEvent('LANDED_SUCCESS', 'UsdcPending', 'UsdcConfirmed');
  });

  it('LANDED_REVERTED -> evidenceReverted -> UsdcReverted', () => {
    expectEvent('LANDED_REVERTED', 'UsdcSubmitted', 'UsdcReverted');
  });

  it('STILL_PENDING picks the event valid in the current state', () => {
    expectEvent('STILL_PENDING', 'UsdcSubmitted', 'UsdcPending'); // evidencePending
    expectEvent('STILL_PENDING', 'UsdcPending', 'UsdcPending'); // pollStillPending
  });

  it('DEAD_REPLACEABLE advances through UsdcPending before it can go dead', () => {
    expectEvent('DEAD_REPLACEABLE', 'UsdcSubmitted', 'UsdcPending'); // evidencePending first
    expectEvent('DEAD_REPLACEABLE', 'UsdcPending', 'UsdcDead'); // pollDead
  });

  it('INDETERMINATE_LOSS_REVIEW escalates to the reconciler (no clean core event)', () => {
    const m = verdictToCore('INDETERMINATE_LOSS_REVIEW', 'UsdcPending');
    expect(m.kind).toBe('escalate');
  });
});
