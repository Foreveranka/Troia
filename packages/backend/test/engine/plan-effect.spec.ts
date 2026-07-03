import { describe, expect, it } from 'vitest';
import { planEffect } from '../../src/engine/plan.js';

describe('planEffect — the pure effect->port/call/event mapping seam', () => {
  it('firePreauth is the hosted-form start-and-wait (URL side-output, outcome via webhook)', () => {
    expect(planEffect('firePreauth')).toEqual({
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

  it('rePollObserveOnly is a durable wait — no port, no event, never a mutation', () => {
    expect(planEffect('rePollObserveOnly')).toEqual({
      port: 'none',
      call: 'none',
      mutates: false,
      feedsEventVia: 'none',
    });
  });
});
