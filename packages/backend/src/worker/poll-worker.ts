// The poll / crash-recovery worker (money-first). It resumes orders parked in a recoverable wait and drives
// the money-safe next step under the SAME per-order lock as /intent and /webhook (passed by the composition
// root), so a tick and a concurrent webhook for one order serialize. It NEVER blind-resubmits: every USDC send
// is a positively-proven-safe path inside the engine (same-seq replacement under the sequence shield, or a
// NEW-seq resubmit only after a landed-and-reverted no-money tx).
//
// Three recoverable groups:
//   (A) SolvencyReserved — a charge whose outcome was UNKNOWN (e.g. the webhook retrieve timed out) would be
//       stranded: TRY possibly charged, no USDC, no reversal. Re-retrieve the DIRECT-SALE result by the
//       persisted token and re-drive chargeEvent. chargeUnknown stays (form not completed yet); chargeOk
//       advances to the USDC leg; chargeRejected fails clean. This closes the money-first stuck-charge window.
//   (B) UsdcSubmitted with NO witness (hashHex null) but the charge done (paymentId) and the seq still active —
//       a crash between chargeOk-persist and submitPay. The pay() was NEVER sent, so a same-seq replacement is
//       money-safe (the sequence shield lets at most one tx land). This is a RECOVERABLE resubmit, NOT a loss.
//   (C) UsdcSubmitted/UsdcPending WITH a witness — observe the tx on-chain (READ) and let the core pick the
//       money-safe next step (confirm / dead-retry / revert-reallocate / quarantine on INDETERMINATE).

import { chargeEvent, projectCheckoutFormResult } from '@troia/psp';
import { verdictToCore } from '@troia/stellar-client';
import type { ReducerState } from '@troia/stellar-client';
import type { State } from '@troia/core';
import { advance, applyEscalate } from '../engine/driver.js';
import type { EngineDeps } from '../engine/events.js';
import type { OrderRegistry } from '../http/order-registry.js';
import type { KeyedMutex } from '../store/mutex.js';

/** The recoverable waits the worker resumes. The ChargeReversing (sale-void) re-poll needs a psp retrieve-status
 *  method that arrives with live iyzico in Phase 4.5, so a crash mid-reversal stays parked (fail-SAFE) until
 *  then — an aging-order alert surfaces it. */
const RECOVERY_STATES: readonly State[] = ['SolvencyReserved', 'UsdcSubmitted', 'UsdcPending'];

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
  const snapshot = registry.ordersInStates(RECOVERY_STATES); // materialized copy — safe against mid-poll puts
  const report = { polled: 0, advanced: 0, escalated: 0, quarantined: 0 };

  for (const snap of snapshot) {
    const orderId = snap.ctx.orderId;
    const outcome: Outcome = await orderLocks.run(orderId, async () => {
      // RE-READ inside the lock: the order may have advanced (webhook / a prior tick) since the snapshot.
      const rec = registry.getByOrderId(orderId);
      if (rec === undefined) return 'skip';
      const state = rec.state;
      const ctx = rec.ctx; // bind from the RE-READ record, never the stale snapshot

      // (A) Stuck-charge recovery: re-retrieve the direct-sale result and re-drive chargeEvent.
      if (state === 'SolvencyReserved') {
        if (ctx.token === null) return 'skip'; // no form issued yet (should not happen in SolvencyReserved)
        const retrieved = await deps.psp.retrieveCheckoutFormResult({
          conversationId: ctx.conversationId,
          token: ctx.token,
        });
        const proj = projectCheckoutFormResult(retrieved);
        if (proj.kind === 'ok' && proj.conversationId !== ctx.conversationId) return 'polled'; // integrity: stay
        const patched = proj.kind === 'ok' ? { ...ctx, paymentId: proj.paymentId } : ctx;
        // Only chargeOk (which advances to the irreversible USDC leg) when a durable paymentId was extracted; a
        // malformed retrieve stays as chargeUnknown, never a chargeOk we could not later void.
        const event = proj.kind === 'ok' ? chargeEvent(retrieved) : { type: 'chargeUnknown' as const };
        const r = await advance(patched, state, event, deps);
        registry.put(r.ctx, r.state);
        return r.state !== state ? 'advanced' : 'polled';
      }

      if (state !== 'UsdcSubmitted' && state !== 'UsdcPending') return 'skip';

      // (B) Never-sent pay recovery: witness-null + charge done + seq active ⇒ the pay() was never submitted ⇒
      // same-seq replacement (money-safe under the sequence shield). NOT an indeterminate loss.
      if (ctx.hashHex === null) {
        if (state === 'UsdcSubmitted' && ctx.paymentId !== null && ctx.activeSeq !== null) {
          const r = await advance(ctx, state, { type: 'recoverResubmit' }, deps);
          registry.put(r.ctx, r.state);
          return r.state !== state ? 'advanced' : 'polled';
        }
        // No witness AND we cannot prove the pay was never sent → quarantine for the reconciler (money-safe:
        // flagLoss moves nothing, the seq is left active).
        await applyEscalate(ctx, deps);
        return 'quarantined';
      }

      // (B2) A tx was submitted (hashHex) but the observe input cannot be rebuilt → quarantine.
      if (ctx.activeSeq === null || ctx.payMaxTimeUnix === null) {
        await applyEscalate(ctx, deps);
        return 'quarantined';
      }

      // (C) Normal: observe the known tx on-chain (READ, never a submit) and let the core decide.
      const reducerState: ReducerState = {
        phase: 'polling',
        hashHex: ctx.hashHex,
        ourSeq: BigInt(ctx.activeSeq),
        maxTime: ctx.payMaxTimeUnix,
      };
      const obs = await deps.stellar.observe(reducerState);
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
