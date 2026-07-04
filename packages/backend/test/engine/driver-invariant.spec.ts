import { describe, expect, it } from 'vitest';
import { ALL_STATES, transition } from '@troia/core';
import type { Event } from '@troia/core';
import { planEffect } from '../../src/engine/plan.js';

// The driver's load-bearing assumption (audited 36/36 clean): every core transition emits AT MOST ONE
// event-feeding effect, and it is the LAST element. If a future core edit appended a non-feeding effect after
// a feeder (or added a second feeder), the driver would silently drop/misorder the fed event — so this is a
// hard CI invariant over the WHOLE table, not a spot check.
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
  { type: 'voidNotVoided', retriesRemaining: true },
  { type: 'voidNotVoided', retriesRemaining: false },
];

describe('driver invariant — at most one event-feeding effect per transition, and it is LAST', () => {
  it('holds for every (state, event) in the core table', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const r = transition(state, event);
        if (r.status !== 'transition') continue;
        const feeders = r.effects.filter((e) => planEffect(e).feedsEventVia !== 'none');
        expect(feeders.length, `${state}/${event.type} feeders`).toBeLessThanOrEqual(1);
        if (feeders.length === 1) {
          expect(r.effects[r.effects.length - 1], `${state}/${event.type} feeder must be last`).toBe(feeders[0]);
        }
      }
    }
  });
});
