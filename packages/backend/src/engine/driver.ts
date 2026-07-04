// The driver — the run-to-quiescence loop that turns the pure core reducer + impure perform() into a working
// engine. It feeds an event to transition(), runs the returned effects IN ORDER, applies ctx patches / side
// outputs, and AUTO-ADVANCES: if an effect fed the next event (the ≤1 feeding effect, always last) it loops;
// else if the entered state is a pure-decision state it synthesizes the decision event and loops; else it
// quiesces (durable wait or terminal). It performs no money-branching — that all lives in the pure core and
// the pure projectors perform() delegates to.
//
// Money-safety hooks the driver OWNS:
//   - assertNoMutationOnUnknown before every effect batch (belt-and-suspenders over the core's own guarantee).
//   - escalate: a burned-but-unproven seq (verdictToCore INDETERMINATE_LOSS_REVIEW) has NO core event, so the
//     driver writes a DURABLE indeterminateLossReview loss flag and quiesces WITHOUT burning/reusing the seq
//     or moving money — quarantined for the reconciler. (4.3d recovery must not re-drive a loss-flagged order.)
//   - start(): guarded, idempotent bootstrap — the reserve->checkout-form sequence runs to quiescence ONLY on
//     a fresh createIfAbsent, so an at-least-once /intent or a crash-retry can never double-reserve the pool
//     or open a second checkout session.

import { initialState, isAbsoluteTerminal, transition } from '@troia/core';
import type { Event, State } from '@troia/core';
import type { OrderCtx } from '../ctx.js';
import { EngineError } from './errors.js';
import { assertNoMutationOnUnknown } from './mutation-guard.js';
import { decisionEvent } from './events.js';
import type { EngineDeps, SideOutput } from './events.js';
import { perform } from './perform.js';

export type Quiescence = 'terminal' | 'waiting' | 'escalated' | 'ignored' | 'alreadyStarted';

export interface RunResult {
  readonly ctx: OrderCtx;
  readonly state: State;
  readonly sideOutputs: readonly SideOutput[];
  readonly escalate: { readonly reason: string } | null;
  readonly quiescence: Quiescence;
}

function finish(
  ctx: OrderCtx,
  state: State,
  sideOutputs: readonly SideOutput[],
  escalate: { readonly reason: string } | null,
  quiescence: Quiescence,
): RunResult {
  return { ctx, state, sideOutputs, escalate, quiescence };
}

/**
 * The durable quarantine for a burned-but-unproven sequence (verdictToCore INDETERMINATE_LOSS_REVIEW, which
 * has NO core event): record the loss WITHOUT moving money or touching the sequence (left ACTIVE for the
 * reconciler). Shared by run() and the poll/recovery worker so the quarantine is identical on both paths.
 * flagLoss accepts a null usdcTxHash (a witness may be absent on the crash-recovery path).
 */
export async function applyEscalate(ctx: OrderCtx, deps: EngineDeps): Promise<void> {
  await deps.store.flagLoss(ctx.orderId, 'indeterminateLossReview', ctx.hashHex);
}

/**
 * Feed `event0` into the core at `state0` and run to quiescence. Total; throws EngineError only on a
 * dead-letter (unmapped (state,event)) or a broken flow (a required ctx field absent).
 */
export async function run(
  ctx0: OrderCtx,
  state0: State,
  event0: Event,
  deps: EngineDeps,
): Promise<RunResult> {
  let ctx = ctx0;
  let state = state0;
  let event: Event | null = event0;
  const sideOutputs: SideOutput[] = [];
  let escalate: { readonly reason: string } | null = null;

  while (event !== null) {
    const r = transition(state, event);
    if (r.status === 'ignored') return finish(ctx, state, sideOutputs, escalate, 'ignored');
    if (r.status === 'rejected') throw new EngineError(r.reason);

    assertNoMutationOnUnknown(event, r.effects);
    state = r.next;

    let fed: Event | null = null;
    let escalated = false;
    for (const effect of r.effects) {
      const p = await perform(effect, ctx, state, event, deps);
      if (p.ctxPatch) ctx = { ...ctx, ...p.ctxPatch };
      if (p.sideOutput) sideOutputs.push(p.sideOutput);
      if (p.escalate) {
        escalate = p.escalate;
        escalated = true;
      }
      if (p.event) fed = p.event;
    }

    if (escalated) {
      // Durable quarantine: money-safe (flagLoss moves nothing), seq left ACTIVE (never burned/reused here).
      await applyEscalate(ctx, deps);
      return finish(ctx, state, sideOutputs, escalate, 'escalated');
    }
    if (fed !== null) {
      event = fed;
      continue;
    }
    const decision = await decisionEvent(state, ctx, deps);
    if (decision !== null) {
      event = decision;
      continue;
    }
    event = null; // quiesce: durable wait (rePollObserveOnly / UsdcConfirmed / fireCheckoutForm) or terminal
  }

  return finish(ctx, state, sideOutputs, escalate, isAbsoluteTerminal(state) ? 'terminal' : 'waiting');
}

/**
 * Guarded, idempotent bootstrap. initialState() = {Reserved, [fireSolvencyCheck]} has NO triggering event, so
 * the bootstrap effect runs directly (perform ignores the null entering event). Because fireSolvencyCheck FEEDS
 * a core event (solvencyOk/Fail/Unknown), the bootstrap must then RUN TO QUIESCENCE via run(): solvencyOk
 * drives Reserved->SolvencyReserved[fireCheckoutForm] and quiesces with the hosted-form side-output; solvencyFail
 * ->FailedClean; solvencyUnknown stays in Reserved. createIfAbsent makes this crash-safe: 'exists' short-circuits
 * WITHOUT re-reserving or re-opening a form. The reserve therefore happens BEFORE the customer can be charged.
 */
export async function start(ctx: OrderCtx, deps: EngineDeps): Promise<RunResult> {
  const boot = initialState();
  const created = await deps.store.createIfAbsent(ctx.orderId);
  if (created === 'exists') return finish(ctx, boot.state, [], null, 'alreadyStarted');

  let c = ctx;
  const bootSideOutputs: SideOutput[] = [];
  let fed: Event | null = null;
  for (const effect of boot.effects) {
    const p = await perform(effect, c, boot.state, null, deps);
    if (p.ctxPatch) c = { ...c, ...p.ctxPatch };
    if (p.sideOutput) bootSideOutputs.push(p.sideOutput);
    if (p.escalate) {
      // Defensive: no bootstrap effect (fireSolvencyCheck) can escalate today, but if one ever does, quarantine
      // money-safely rather than leave the order bricked. Nothing was charged at this point.
      await applyEscalate(c, deps);
      return finish(c, boot.state, bootSideOutputs, p.escalate, 'escalated');
    }
    if (p.event) fed = p.event;
  }
  // fireSolvencyCheck always feeds a solvency event → continue to quiescence (reserve, then the checkout form).
  if (fed !== null) {
    const rest = await run(c, boot.state, fed, deps);
    return finish(rest.ctx, rest.state, [...bootSideOutputs, ...rest.sideOutputs], rest.escalate, rest.quiescence);
  }
  return finish(c, boot.state, bootSideOutputs, null, 'waiting');
}

/** Feed an external event: webhook (charge), poll-worker (evidence/poll/recovery), or reconciler (reconciled). */
export function advance(ctx: OrderCtx, state: State, event: Event, deps: EngineDeps): Promise<RunResult> {
  return run(ctx, state, event, deps);
}
