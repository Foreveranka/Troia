import { describe, expect, it } from 'vitest';
import { chargeEvent, reversalEvent } from '../src/classify.js';
import type { RawIyzicoResult } from '../src/outcomes.js';
import { transition } from '../../core/src/index.js';
import type { Event, State } from '../../core/src/index.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });

function expectTransition(from: State, event: Event, to: State): void {
  const r = transition(from, event);
  expect(r.status).toBe('transition');
  if (r.status === 'transition') expect(r.next).toBe(to);
}

// Proves psp and the @troia/core state machine (§3) are ONE machine: every event the money-first mappers emit
// is accepted by core.transition in the state it is meant for, and lands where the 3-valued design says.

describe('psp classify -> core §3 events (one machine, money-first)', () => {
  it('Charge (from SolvencyReserved): Ok->UsdcSubmitted, Rejected->FailedClean, Unknown->SolvencyReserved (observe)', () => {
    expectTransition('SolvencyReserved', chargeEvent(body({ status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1 })), 'UsdcSubmitted');
    expectTransition('SolvencyReserved', chargeEvent(body({ status: 'failure', errorCode: '10051' })), 'FailedClean');
    expectTransition('SolvencyReserved', chargeEvent({ kind: 'timeout' }), 'SolvencyReserved');
    // a PRE_AUTH hold or a paymentId-less success is not a completed charge -> Unknown -> stay (NEVER to USDC)
    expectTransition('SolvencyReserved', chargeEvent(body({ status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1, phase: 'PRE_AUTH' })), 'SolvencyReserved');
    expectTransition('SolvencyReserved', chargeEvent(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 })), 'SolvencyReserved');
  });

  it('Reversal (from ChargeReversing): Confirmed->ChargeReversed, NotDone(retry)->ChargeReversing, NotDone(exhausted)->LossReview, Unknown->ChargeReversing', () => {
    expectTransition('ChargeReversing', reversalEvent(body({ status: 'success' }), true), 'ChargeReversed');
    expectTransition('ChargeReversing', reversalEvent(body({ status: 'failure' }), true), 'ChargeReversing');
    expectTransition('ChargeReversing', reversalEvent(body({ status: 'failure' }), false), 'LossReview');
    expectTransition('ChargeReversing', reversalEvent({ kind: 'malformed', reason: 'x' }, true), 'ChargeReversing');
  });
});
