import { describe, expect, it } from 'vitest';
import { captureEvent, preauthEvent, voidEvent } from '../src/classify.js';
import type { RawIyzicoResult } from '../src/outcomes.js';
import { transition } from '../../core/src/index.js';
import type { Event, State } from '../../core/src/index.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });

function expectTransition(from: State, event: Event, to: State): void {
  const r = transition(from, event);
  expect(r.status).toBe('transition');
  if (r.status === 'transition') expect(r.next).toBe(to);
}

// Proves psp and the @troia/core state machine (§3) are ONE machine: every event the per-op mappers emit is
// accepted by core.transition in the state it is meant for, and lands where the 3-valued design says.

describe('psp classify -> core §3 events (one machine)', () => {
  it('PreAuth (from Reserved): Ok->TryPreauthed, Rejected->FailedClean, Unknown->Reserved (observe)', () => {
    expectTransition('Reserved', preauthEvent(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 })), 'TryPreauthed');
    expectTransition('Reserved', preauthEvent(body({ status: 'failure', errorCode: '10051' })), 'FailedClean');
    expectTransition('Reserved', preauthEvent({ kind: 'timeout' }), 'Reserved');
  });

  it('Capture (from CaptureSubmitted): Success->TryCaptured, Failed(retry)->CaptureSubmitted, Failed(no retry)->LossReview, Unknown->CaptureSubmitted', () => {
    expectTransition('CaptureSubmitted', captureEvent(body({ status: 'success', paymentId: 'p1' }), true), 'TryCaptured');
    expectTransition('CaptureSubmitted', captureEvent(body({ status: 'failure', errorCode: '10005' }), true), 'CaptureSubmitted');
    expectTransition('CaptureSubmitted', captureEvent(body({ status: 'failure', errorCode: '10005' }), false), 'LossReview');
    expectTransition('CaptureSubmitted', captureEvent({ kind: 'timeout' }, true), 'CaptureSubmitted');
  });

  it('Void (from SolvencyRejected): Confirmed->TryHoldVoided, NotVoided->SolvencyRejected (retry), Unknown->SolvencyRejected (observe)', () => {
    expectTransition('SolvencyRejected', voidEvent(body({ status: 'success' }), true), 'TryHoldVoided');
    expectTransition('SolvencyRejected', voidEvent(body({ status: 'failure' }), true), 'SolvencyRejected');
    expectTransition('SolvencyRejected', voidEvent({ kind: 'malformed', reason: 'x' }, true), 'SolvencyRejected');
  });
});
