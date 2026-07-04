import { describe, expect, it } from 'vitest';
import type { Event, State } from '@troia/core';
import { advance } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// "Unknown / uncertain / recover NEVER advances toward an irreversible action." Each observe-only event must
// quiesce with ZERO psp/stellar money-moving calls and no retry-budget consumption.
const MUTATIONS = ['psp.initializeCheckoutForm', 'psp.createPostAuth', 'psp.cancel', 'stellar.submitPay'];

const OBSERVE_ONLY: { state: State; event: Event; quiesceState: State }[] = [
  { state: 'Reserved', event: { type: 'preauthUnknown' }, quiesceState: 'Reserved' },
  { state: 'TryPreauthed', event: { type: 'solvencyUnknown' }, quiesceState: 'TryPreauthed' },
  { state: 'UsdcSubmitted', event: { type: 'recover' }, quiesceState: 'UsdcSubmitted' },
  { state: 'UsdcSubmitted', event: { type: 'evidencePending' }, quiesceState: 'UsdcPending' },
  { state: 'UsdcPending', event: { type: 'pollStillPending' }, quiesceState: 'UsdcPending' },
  { state: 'CaptureSubmitted', event: { type: 'captureUnknown' }, quiesceState: 'CaptureSubmitted' },
  { state: 'CaptureSubmitted', event: { type: 'recover' }, quiesceState: 'CaptureSubmitted' },
];

describe('engine mutation-on-uncertainty safety', () => {
  for (const c of OBSERVE_ONLY) {
    it(`${c.state} + ${c.event.type} quiesces observe-only with no mutation`, async () => {
      const h = makeHarness();
      const ctx = makeCtx(h.store);
      const r = await advance(ctx, c.state, c.event, h.deps);
      expect(r.state).toBe(c.quiesceState);
      expect(r.quiescence).toBe('waiting');
      for (const m of MUTATIONS) expect(h.trace).not.toContain(m);
      // the durable-wait is a genuine no-op: the poll/recovery worker re-observes later (perform never observes)
      expect(h.trace).not.toContain('stellar.observe');
      expect(h.store.captureRetries.get(ctx.orderId)).toBeUndefined();
      expect(h.store.deadRetries.get(ctx.orderId)).toBeUndefined();
    });
  }
});
