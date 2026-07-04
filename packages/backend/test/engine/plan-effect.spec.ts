import { describe, expect, it } from 'vitest';
import { MUTATION_EFFECTS } from '@troia/core';
import type { Effect } from '@troia/core';
import { planEffect } from '../../src/engine/plan.js';

describe('planEffect — the pure effect->port/call/event mapping seam', () => {
  it('fireCheckoutForm is the direct-SALE hosted-form start (URL side-output, outcome via webhook)', () => {
    // money-first: the preauth form is gone; the hosted form now places the DIRECT sale. It is a mutation
    // (mutates:true so it can never fire on an Unknown/stay) but feeds NO happy-path event — the charge
    // verdict arrives later via the webhook retrieve, not inline.
    expect(planEffect('fireCheckoutForm')).toEqual({
      port: 'psp',
      call: 'initializeCheckoutForm',
      mutates: true,
      feedsEventVia: 'none',
    });
  });

  it('submitPay -> stellar submit+observe -> verdictToCore', () => {
    expect(planEffect('submitPay')).toEqual({
      port: 'stellar',
      call: 'submitPay',
      mutates: true,
      feedsEventVia: 'verdictToCore',
    });
  });

  it('fireSolvencyCheck -> store.reserve -> reserveOutcome (not a mutation effect)', () => {
    expect(planEffect('fireSolvencyCheck')).toEqual({
      port: 'store',
      call: 'reserve',
      mutates: false,
      feedsEventVia: 'reserveOutcome',
    });
  });

  it('fireCancel -> psp.cancel -> reversalEvent (void the completed sale, the LAST-resort mutation)', () => {
    // the irreversible-USDC-failure leg: void the already-completed TRY sale (same-day cancel).
    expect(planEffect('fireCancel')).toEqual({
      port: 'psp',
      call: 'cancel',
      mutates: true,
      feedsEventVia: 'reversalEvent',
    });
  });

  it('rePollObserveOnly is a durable wait — no port, no event, never a mutation', () => {
    expect(planEffect('rePollObserveOnly')).toEqual({
      port: 'none',
      call: 'none',
      mutates: false,
      feedsEventVia: 'none',
    });
  });

  it('plan.mutates mirrors core MUTATION_EFFECTS exactly (no other effect claims to mutate)', () => {
    const ALL_EFFECTS: readonly Effect[] = [
      'fireSolvencyCheck',
      'fireCheckoutForm',
      'persistInFlight',
      'submitPay',
      'submitReplacementSameSeq',
      'reallocateSeq',
      'confirmBurnedSeq',
      'releaseSeq',
      'releaseReservation',
      'fireCancel',
      'flagLoss',
      'handToReconciler',
      'rePollObserveOnly',
    ];
    const mutating = ALL_EFFECTS.filter((e) => planEffect(e).mutates);
    expect(new Set(mutating)).toEqual(new Set(MUTATION_EFFECTS));
  });
});
