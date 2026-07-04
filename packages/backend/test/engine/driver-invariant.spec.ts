import { describe, expect, it } from 'vitest';
import { ALL_STATES, transition } from '@troia/core';
import type { Event } from '@troia/core';
import { planEffect } from '../../src/engine/plan.js';

// The driver's load-bearing assumption: every core transition emits AT MOST ONE event-feeding effect, and it is
// the LAST element. The driver runs a batch of effects in order and treats the last-produced event as the fed
// next event; if a future core edit appended a non-feeding effect AFTER a feeder (or added a second feeder), the
// driver would silently drop/misorder the fed event — so this is a hard CI invariant over the WHOLE money-first
// table (Phase 4.6: solvency-reserve → hosted charge → USDC leg → same-day void on failure), not a spot check.
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
