// perform() — the IMPURE effect executor. planEffect (wave-1) decided WHICH port call an effect becomes;
// perform actually makes the call and PROJECTS its result into the next core Event using the already-tested
// pure projectors (@troia/stellar-client verdictToCore, @troia/psp classify/voidEvent, ./classify-revert).
// It holds NO money-branching of its own — every SUCCESS/FAILURE/UNKNOWN decision is delegated to those
// pure functions, so the money-safety asymmetry proven in psp/stellar-client is preserved here verbatim.
//
// Contract: at most ONE effect per core transition feeds an event (audited: it is always the LAST effect),
// so the driver takes perform()'s `event` as THE next event. Local effects (persist/seq/release/flag/observe)
// return event:null. firePreauth is start-and-wait (URL side-output, no event). submit escalate carries a
// burned-but-unproven seq to the driver's durable quarantine (no core event exists for it).

import { deriveIds } from '@troia/core';
import type { Effect, Event, State } from '@troia/core';
import type { PayRequest, ReducerState } from '@troia/stellar-client';
import { verdictToCore } from '@troia/stellar-client';
import type {
  Address,
  BasketItem,
  Buyer,
  CancelParams,
  InitializeCheckoutFormParams,
  PostAuthParams,
} from '@troia/psp';
import { classifyIyzicoResult, projectCheckoutFormInit } from '@troia/psp';
import type { OrderCtx } from '../ctx.js';
import type { InFlightPatch } from '../ports.js';
import { classifyRevertCause, revertEvent } from './classify-revert.js';
import { EngineError } from './errors.js';
import { flagLossBucket, releaseReason } from './events.js';
import type { EngineDeps, PerformResult } from './events.js';

const NO_EVENT: PerformResult = { event: null };

function requireSeq(ctx: OrderCtx): string {
  if (ctx.activeSeq === null) throw new EngineError(`order ${ctx.orderId}: no active sequence for pay()`);
  return ctx.activeSeq;
}
function requirePaymentId(ctx: OrderCtx): string {
  if (ctx.paymentId === null) throw new EngineError(`order ${ctx.orderId}: no paymentId for psp call`);
  return ctx.paymentId;
}

/** Build the InFlightPatch from the currently-known ctx facts (exactOptionalPropertyTypes: omit, never
 *  assign undefined). */
function inFlightPatch(ctx: OrderCtx): InFlightPatch {
  return {
    ...(ctx.activeSeq !== null ? { seq: ctx.activeSeq } : {}),
    ...(ctx.paymentId !== null ? { paymentId: ctx.paymentId } : {}),
    ...(ctx.hashHex !== null ? { hashHex: ctx.hashHex } : {}),
    ...(ctx.signedXdr !== null ? { signedXdr: ctx.signedXdr } : {}),
  };
}

function checkoutFormParams(ctx: OrderCtx, deps: EngineDeps): InitializeCheckoutFormParams {
  const { psp } = deps.config;
  const buyer: Buyer = { ...psp.buyer, ip: ctx.ip };
  const basketItems: readonly BasketItem[] = [{ ...psp.basketItemTemplate, price: ctx.paidPriceTry }];
  return {
    locale: psp.locale,
    conversationId: ctx.conversationId,
    price: ctx.paidPriceTry,
    paidPrice: ctx.paidPriceTry,
    currency: ctx.currency,
    basketId: ctx.orderId,
    paymentGroup: psp.paymentGroup,
    callbackUrl: psp.callbackUrl,
    buyer,
    shippingAddress: psp.shippingAddress as Address,
    billingAddress: psp.billingAddress as Address,
    basketItems,
  };
}

function postAuthParams(ctx: OrderCtx, deps: EngineDeps): PostAuthParams {
  return {
    locale: deps.config.psp.locale,
    conversationId: ctx.conversationId,
    paymentId: requirePaymentId(ctx),
    paidPrice: ctx.paidPriceTry,
    currency: ctx.currency,
    ip: ctx.ip,
  };
}

function cancelParams(ctx: OrderCtx, deps: EngineDeps): CancelParams {
  return {
    locale: deps.config.psp.locale,
    conversationId: ctx.conversationId,
    paymentId: requirePaymentId(ctx),
    ip: ctx.ip,
  };
}

function payRequest(ctx: OrderCtx, deps: EngineDeps): { req: PayRequest; ourSeq: bigint; maxTime: number } {
  const activeSeq = requireSeq(ctx);
  const ids = deriveIds(ctx.orderId, ctx.destination, ctx.amountStroops);
  const minTime = deps.clock.nowUnix();
  const maxTime = minTime + deps.config.stellar.timeboundsSecs;
  const ourSeq = BigInt(activeSeq);
  const req: PayRequest = {
    orderId: ctx.orderId,
    operatorPublic: deps.config.stellar.operatorPublic,
    // BuildParams.seq is the account-CURRENT seq; TransactionBuilder increments to seq+1. activeSeq is the
    // allocated TX seqNum, so seq = activeSeq-1 yields tx seqNum == activeSeq (audited, no txBAD_SEQ).
    seq: (ourSeq - 1n).toString(),
    minTime,
    maxTime,
    fee: deps.config.stellar.feeStroops,
    passphrase: deps.config.stellar.passphrase,
    troyPool: deps.config.stellar.troyPool,
    txId32: ids.txId,
    amount: ctx.amountStroops,
    appliedRate: ctx.appliedRateStroops,
    merchant: ctx.destination,
    memo32: ids.memo,
  };
  return { req, ourSeq, maxTime };
}

/** submit -> observe ONCE -> verdictToCore. Shared by submitPay and (post reuseOnDead) submitReplacementSameSeq.
 *  The single observe yields the first verdict; STILL_PENDING routes to a durable wait (poll worker re-observes
 *  later). ctxPatch records the pay() witness so handToReconciler/flagLoss can cite it. */
async function doSubmitAndObserve(ctx: OrderCtx, coreState: State, deps: EngineDeps): Promise<PerformResult> {
  const { req, ourSeq, maxTime } = payRequest(ctx, deps);
  const submit = await deps.stellar.submitPay(req);
  // Durably record the pay() witness IMMEDIATELY — before observe / any quiescence — so a cross-process poll
  // or recovery worker that resumes the UsdcSubmitted/UsdcPending durable wait (rebuilding ctx from the
  // OrderRow) still has hashHex/signedXdr to re-observe, append settlement evidence, and cite the loss-bucket
  // txHash. Without this, a STILL_PENDING quiesce persists only the pre-submit (witness-null) state.
  await deps.store.persistState(ctx.orderId, coreState, {
    ...inFlightPatch(ctx),
    hashHex: submit.hashHex,
    signedXdr: submit.signedXdr,
  });
  const state: ReducerState = { phase: 'polling', hashHex: submit.hashHex, ourSeq, maxTime };
  const obs = await deps.stellar.observe(state);
  const mapping = verdictToCore(obs.verdict ?? 'STILL_PENDING', coreState);
  const ctxPatch: Partial<OrderCtx> = { hashHex: submit.hashHex, signedXdr: submit.signedXdr };
  if (mapping.kind === 'escalate') return { event: null, ctxPatch, escalate: { reason: mapping.reason } };
  return { event: mapping.event, ctxPatch };
}

/**
 * Execute one effect. `coreState` is the state just ENTERED (r.next); `enteringEvent` is the event that
 * triggered the transition, or null for the eventless bootstrap (only firePreauth runs there, which does not
 * consult it). Total over the 14 effects.
 */
export async function perform(
  effect: Effect,
  ctx: OrderCtx,
  coreState: State,
  enteringEvent: Event | null,
  deps: EngineDeps,
): Promise<PerformResult> {
  switch (effect) {
    case 'firePreauth': {
      // Hosted-form start-and-wait: return the checkout URL/token side-output; the preauth OUTCOME arrives
      // later via the webhook (retrieve -> preauthEvent). NEVER feeds a core event here.
      const raw = await deps.psp.initializeCheckoutForm(checkoutFormParams(ctx, deps));
      const proj = projectCheckoutFormInit(raw);
      if (proj.kind === 'malformed') return { event: null, escalate: { reason: `checkout init: ${proj.reason}` } };
      return {
        event: null,
        sideOutput: { kind: 'checkoutForm', token: proj.token, formContent: proj.checkoutFormContent },
      };
    }

    case 'fireSolvencyCheck': {
      const outcome = await deps.store.reserve(
        ctx.orderId,
        ctx.amountStroops,
        deps.config.policy.reservationTtlMs,
        deps.clock.nowUnix() * 1000,
      );
      const type =
        outcome.kind === 'reserved' ? 'solvencyOk' : outcome.kind === 'insufficient' ? 'solvencyFail' : 'solvencyUnknown';
      return { event: { type } };
    }

    case 'persistInFlight':
      await deps.store.persistState(ctx.orderId, coreState, inFlightPatch(ctx));
      return NO_EVENT;

    case 'submitPay':
      return doSubmitAndObserve(ctx, coreState, deps);

    case 'submitReplacementSameSeq':
      // UsdcDead retry: pin the SAME (still-active) seq, then submit with fresh timebounds. reuseOnDead throws
      // if the seq is burned (that would be a REVERTED case, not DEAD) — a fail-closed structural guard.
      deps.store.sequences.reuseOnDead(BigInt(requireSeq(ctx)), ctx.orderId);
      return doSubmitAndObserve(ctx, coreState, deps);

    case 'reallocateSeq': {
      // UsdcReverted 'other': the burned seq is abandoned, a fresh one is handed out. The trailing submitPay
      // in the same effect list feeds the event; this only patches ctx.
      const newSeq = deps.store.sequences.reallocate(ctx.orderId);
      return { event: null, ctxPatch: { activeSeq: newSeq.toString() } };
    }

    case 'confirmBurnedSeq': {
      deps.store.sequences.confirmBurned(BigInt(requireSeq(ctx)));
      const code = await deps.stellar.readRevertErrorCode(ctx.orderId);
      return { event: revertEvent(classifyRevertCause(code)) };
    }

    case 'releaseSeq':
      deps.store.sequences.release(BigInt(requireSeq(ctx)), ctx.orderId);
      return NO_EVENT;

    case 'releaseReservation':
      await deps.store.releaseReservation(ctx.orderId, releaseReason(coreState));
      return NO_EVENT;

    case 'firePostauth': {
      const raw = await deps.psp.createPostAuth(postAuthParams(ctx, deps));
      const cls = classifyIyzicoResult(raw, 'capture');
      if (cls === 'SUCCESS') return { event: { type: 'captureSuccess' } };
      if (cls === 'UNKNOWN') return { event: { type: 'captureUnknown' } };
      // FAILURE (definitely-not-captured): consume the persisted retry budget, then decide retry vs LossReview.
      const n = await deps.store.bumpCaptureRetries(ctx.orderId);
      return { event: { type: 'captureFailed', retriesRemaining: n <= deps.config.policy.maxCaptureRetries } };
    }

    case 'fireCancel': {
      // Void the live TRY hold. A definite FAILURE is safe to re-drive (idempotent), but ONLY within a
      // persisted budget — otherwise a permanently-declining cancel (e.g. an already-expired hold) would loop
      // fireCancel forever. On budget exhaustion the core quiesces the void-pending state (hold expires).
      const raw = await deps.psp.cancel(cancelParams(ctx, deps));
      const cls = classifyIyzicoResult(raw, 'void');
      if (cls === 'SUCCESS') return { event: { type: 'voidConfirmed' } };
      if (cls === 'UNKNOWN') return { event: { type: 'voidUnknown' } };
      const n = await deps.store.bumpVoidRetries(ctx.orderId);
      return { event: { type: 'voidNotVoided', retriesRemaining: n <= deps.config.policy.maxVoidRetries } };
    }

    case 'flagLoss':
      // USDC was sent; record the one irreversible-loss bucket with the on-chain witness. The bucket is keyed
      // off the entering event (holdExpired vs captureFailed), which is always present on a flagLoss path.
      if (enteringEvent === null) throw new EngineError(`order ${ctx.orderId}: flagLoss without an entering event`);
      await deps.store.flagLoss(ctx.orderId, flagLossBucket(enteringEvent), ctx.hashHex);
      return NO_EVENT;

    case 'handToReconciler': {
      // Append the landed witness ONLY — do NOT synthesize {reconciled}. The order quiesces in TryCaptured
      // (a durable wait); the offline reconciler (4.3d) drives ->Reconciled only after verifyReport MATCHES.
      if (ctx.hashHex === null || ctx.signedXdr === null || ctx.activeSeq === null) {
        throw new EngineError(`order ${ctx.orderId}: cannot append evidence — pay() witness missing`);
      }
      await deps.store.appendEvidence(ctx.orderId, {
        txHash: ctx.hashHex,
        signedXdr: ctx.signedXdr,
        seq: ctx.activeSeq,
      });
      return NO_EVENT;
    }

    case 'rePollObserveOnly':
      // Durable WAIT: the poll/recovery worker (4.3d) re-observes and later calls advance() with the event.
      // perform MUST NOT observe here — that is how "Unknown/uncertain never advances" is honored.
      return NO_EVENT;
  }
}
