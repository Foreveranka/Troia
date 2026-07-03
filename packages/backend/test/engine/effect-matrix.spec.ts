import { describe, expect, it } from 'vitest';
import { MUTATION_EFFECTS } from '@troia/core';
import type { Effect } from '@troia/core';
import { planEffect } from '../../src/engine/plan.js';

const ALL_EFFECTS: readonly Effect[] = [
  'firePreauth',
  'fireSolvencyCheck',
  'persistInFlight',
  'submitPay',
  'submitReplacementSameSeq',
  'reallocateSeq',
  'confirmBurnedSeq',
  'releaseSeq',
  'releaseReservation',
  'firePostauth',
  'fireCancel',
  'flagLoss',
  'handToReconciler',
  'rePollObserveOnly',
];

const LOCAL_EFFECTS: readonly Effect[] = [
  'persistInFlight',
  'reallocateSeq',
  'confirmBurnedSeq',
  'releaseSeq',
  'releaseReservation',
  'flagLoss',
  'rePollObserveOnly',
];

describe('effect matrix — all 14 effects map, and `mutates` mirrors core MUTATION_EFFECTS', () => {
  it('every effect has a total plan', () => {
    for (const e of ALL_EFFECTS) {
      const plan = planEffect(e);
      expect(plan, e).toBeDefined();
      expect(['psp', 'stellar', 'store', 'sequences', 'none']).toContain(plan.port);
    }
  });

  it('planEffect(e).mutates === MUTATION_EFFECTS.includes(e) for every effect', () => {
    const mut = new Set<Effect>(MUTATION_EFFECTS);
    for (const e of ALL_EFFECTS) {
      expect(planEffect(e).mutates, e).toBe(mut.has(e));
    }
  });

  it('local effects (persist/seq/release/flag/observe) neither call psp/stellar nor feed an event directly', () => {
    for (const e of LOCAL_EFFECTS) {
      const plan = planEffect(e);
      expect(['store', 'sequences', 'none'], e).toContain(plan.port);
      // classifyRevertCause is the one local exception: confirmBurnedSeq feeds a revert event.
      if (e !== 'confirmBurnedSeq') expect(plan.feedsEventVia, e).toBe('none');
    }
  });
});
