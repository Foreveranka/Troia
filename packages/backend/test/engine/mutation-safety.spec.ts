import { describe, expect, it } from 'vitest';
import type { Event, State } from '@troia/core';
import { advance } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// "Unknown / uncertain / recover NEVER advances toward an irreversible action." Every observe-only event in the
// money-first table must quiesce with ZERO money-moving / charge-placing port calls (fireCheckoutForm, submitPay,
// submitReplacementSameSeq, fireCancel — the traceable MUTATION_EFFECTS) and no retry-budget consumption.
const MUTATIONS = ['psp.initializeCheckoutForm', 'psp.cancel', 'stellar.submitPay'];

// The complete set of observe-only rows across the money-first table: each of the six observe-only events
// (solvencyUnknown, chargeUnknown, reversalUnknown, recover, evidencePending, pollStillPending) at the single
// state where the core pairs it with ['rePollObserveOnly']. This exhaustively translates the old preauth/capture
// uncertainty rows (preauthUnknown, solvencyUnknown@TryPreauthed, captureUnknown/recover@CaptureSubmitted) onto
// their closest money-first analogues (solvencyUnknown@Reserved, chargeUnknown@SolvencyReserved,
// reversalUnknown@ChargeReversing) while preserving the UsdcSubmitted/UsdcPending in-flight rows verbatim.
const OBSERVE_ONLY: { state: State; event: Event; quiesceState: State }[] = [
  { state: 'Reserved', event: { type: 'solvencyUnknown' }, quiesceState: 'Reserved' },
  { state: 'SolvencyReserved', event: { type: 'chargeUnknown' }, quiesceState: 'SolvencyReserved' },
  { state: 'UsdcSubmitted', event: { type: 'recover' }, quiesceState: 'UsdcSubmitted' },
  { state: 'UsdcSubmitted', event: { type: 'evidencePending' }, quiesceState: 'UsdcPending' },
  { state: 'UsdcPending', event: { type: 'pollStillPending' }, quiesceState: 'UsdcPending' },
  { state: 'ChargeReversing', event: { type: 'reversalUnknown' }, quiesceState: 'ChargeReversing' },
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
      // no retry budget is spent on an uncertain step (money-first counters: deadRetries + reversalRetries)
      expect(h.store.deadRetries.get(ctx.orderId)).toBeUndefined();
      expect(h.store.reversalRetries.get(ctx.orderId)).toBeUndefined();
    });
  }
});
