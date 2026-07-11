import { ALL_STATES } from '@troia/core';
import type { State } from '@troia/core';
import { describe, expect, it } from 'vitest';
import { intentBody, makeHttpHarness } from './http-harness.js';
import type { PublicStatus } from '../../src/http/public-status.js';

// The money-first coarse mapping (public-status.ts) — kept in lockstep with the 12-state machine so the
// storefront only ever sees pending/processing/completed/failed/review and NEVER an internal crypto state.
const EXPECTED: Record<State, PublicStatus> = {
  Reserved: 'pending', // reserving pool solvency; nothing charged yet
  SolvencyReserved: 'pending', // hosted sale form shown; awaiting the charge
  UsdcSubmitted: 'processing', // charged; the irreversible USDC leg is in flight
  UsdcPending: 'processing', // USDC still pending on-chain
  UsdcDead: 'processing', // USDC dead/replaceable; being resolved
  UsdcReverted: 'processing', // USDC reverted; cause being classified
  UsdcConfirmed: 'completed', // USDC landed; awaiting the offline reconciler
  Reconciled: 'completed', // reconciled terminal
  FailedClean: 'failed', // declined / solvency-rejected BEFORE any charge — the only 'failed' bucket
  ChargeReversing: 'review', // charged; USDC failed; sale being voided — not 'failed' (a retry would re-charge)
  ChargeReversed: 'review', // charged then voided; TRY returned — not 'failed' (a retry would re-charge)
  LossReview: 'review', // manual sink: USDC fate unknown or reversal exhausted
};

describe('GET /status/:orderId — coarse public status (no crypto-state leak)', () => {
  it('404 for an unknown order', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'GET', url: '/status/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NotFound' });
  });

  it('pending right after /intent', async () => {
    const h = makeHttpHarness();
    await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    const res = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: 'order-1', status: 'pending' });
    // never leaks the internal State (SolvencyReserved/Reserved/…)
    expect(JSON.stringify(res.json())).not.toContain('Reserved');
  });

  it('the mapping is total over the 12-state machine (coverage cannot silently shrink)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_STATES].sort());
    expect(ALL_STATES).toHaveLength(12);
  });

  // Drive every one of the 12 internal states through the SAME HTTP surface: seed the registry via a real
  // /intent, then re-project the order into each state and assert /status returns only the coarse bucket and
  // never the raw internal identifier.
  describe('every internal State projects to its coarse bucket and leaks nothing', () => {
    for (const state of ALL_STATES) {
      it(`${state} -> ${EXPECTED[state]}`, async () => {
        const h = makeHttpHarness();
        await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
        const ctx = h.registry.getByOrderId('order-1')?.ctx;
        expect(ctx).toBeDefined();
        h.registry.put(ctx!, state);

        const res = await h.app.inject({ method: 'GET', url: '/status/order-1' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ orderId: 'order-1', status: EXPECTED[state] });
        // the crypto-leg identifier is never in the wire payload
        expect(JSON.stringify(res.json())).not.toContain(state);
      });
    }
  });
});
