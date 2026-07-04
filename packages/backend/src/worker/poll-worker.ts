// The poll / crash-recovery worker — the SPIKE-2 recovery: READ (re-observe on-chain) THEN DECIDE, never a
// blind resubmit. It resumes orders parked in a USDC durable wait (UsdcSubmitted / UsdcPending) by observing
// the on-chain fate and feeding the resulting core event through advance(); the engine's state machine then
// picks the money-safe next step. The worker itself NEVER calls submitPay: the only USDC resubmits are the two
// DELIBERATE, positively-proven-dead paths inside the engine — same-seq replacement (UsdcDead -> deadRetry,
// gated by the retry budget + reuseOnDead, and only when deadness is SAFE_TO_REPLACE = timebounds-expired +
// unburned) and a NEW-seq resubmit (UsdcReverted -> revertOther, only after a landed-and-reverted tx where no
// USDC moved). STILL_PENDING / TIMEOUT / NOT_FOUND-within-timebounds all route to rePollObserveOnly (stay).
//
// It runs under the SAME per-order lock as /intent and /webhook (passed by the composition root), so a poll
// tick and a concurrent webhook for one order serialize — without that shared lock two overlapping drives
// could both fire a same-seq replacement (a double-pay). The lock is order-outer / pool-inner, the identical
// nesting the HTTP routes use, so there is no inversion.

import { verdictToCore } from '@troia/stellar-client';
import type { ReducerState } from '@troia/stellar-client';
import type { State } from '@troia/core';
import { advance, applyEscalate } from '../engine/driver.js';
import type { EngineDeps } from '../engine/events.js';
import type { OrderRegistry } from '../http/order-registry.js';
import type { KeyedMutex } from '../store/mutex.js';

/** The USDC durable waits the worker resumes. CaptureSubmitted + the void-pending states are intentionally
 *  EXCLUDED: re-polling a capture / cancel needs a psp retrieve-status method that arrives with live iyzico in
 *  Phase 4.5. A crash mid-capture therefore stays stuck in CaptureSubmitted (fail-SAFE: parked, never a
 *  wrongful payout) until 4.5 — an aging-order alert surfaces it. */
const USDC_WAIT_STATES: readonly State[] = ['UsdcSubmitted', 'UsdcPending'];

export interface PollReport {
  readonly polled: number;
  readonly advanced: number;
  readonly escalated: number;
  readonly quarantined: number;
}

type Outcome = 'skip' | 'polled' | 'advanced' | 'escalated' | 'quarantined';

export async function pollInFlight(
  registry: OrderRegistry,
  orderLocks: KeyedMutex,
  deps: EngineDeps,
): Promise<PollReport> {
  const snapshot = registry.ordersInStates(USDC_WAIT_STATES); // materialized copy — safe against mid-poll puts
  const report = { polled: 0, advanced: 0, escalated: 0, quarantined: 0 };

  for (const snap of snapshot) {
    const orderId = snap.ctx.orderId;
    const outcome: Outcome = await orderLocks.run(orderId, async () => {
      // RE-READ inside the lock: the order may have advanced (webhook / a prior tick) since the snapshot.
      const rec = registry.getByOrderId(orderId);
      if (rec === undefined) return 'skip';
      const state = rec.state;
      if (state !== 'UsdcSubmitted' && state !== 'UsdcPending') return 'skip';
      const ctx = rec.ctx; // bind from the RE-READ record, never the stale snapshot

      // A crash between persistInFlight and the witness persist can leave a USDC-wait row with no witness (the
      // hash survives in the write-ahead journal, orderId-keyed, but not in the engine ctx). Do NOT silently
      // skip — that strands the order with no driver forever. Quarantine it for the reconciler (money-safe:
      // flagLoss moves nothing, the seq is left active), which resolves it from the journal.
      if (ctx.hashHex === null || ctx.activeSeq === null || ctx.payMaxTimeUnix === null) {
        await applyEscalate(ctx, deps);
        return 'quarantined';
      }

      const reducerState: ReducerState = {
        phase: 'polling',
        hashHex: ctx.hashHex,
        ourSeq: BigInt(ctx.activeSeq),
        maxTime: ctx.payMaxTimeUnix,
      };
      const obs = await deps.stellar.observe(reducerState); // READ on-chain; never a submit
      const mapping = verdictToCore(obs.verdict ?? 'STILL_PENDING', state);
      if (mapping.kind === 'escalate') {
        await applyEscalate(ctx, deps);
        return 'escalated';
      }

      const r = await advance(ctx, state, mapping.event, deps);
      registry.put(r.ctx, r.state);
      return r.state !== state ? 'advanced' : 'polled';
    });

    report.polled += 1;
    if (outcome === 'advanced') report.advanced += 1;
    else if (outcome === 'escalated') report.escalated += 1;
    else if (outcome === 'quarantined') report.quarantined += 1;
  }

  return report;
}
