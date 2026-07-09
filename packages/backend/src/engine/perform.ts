// perform() — the IMPURE effect executor. planEffect (wave-1) decided WHICH port call an effect becomes;
// perform actually makes the call and PROJECTS its result into the next core Event using the already-tested
// pure projectors (@troia/stellar-client verdictToCore, @troia/psp classify, ./classify-revert). It holds NO
// money-branching of its own — every SUCCESS/FAILURE/UNKNOWN decision is delegated to those pure functions, so
// the money-safety asymmetry proven in psp/stellar-client is preserved here verbatim.
//
// Contract: at most ONE effect per core transition feeds an event (audited: it is always the LAST effect),
// so the driver takes perform()'s `event` as THE next event. Local effects (persist/seq/release/flag/observe)
// return event:null. fireCheckoutForm is start-and-wait (URL side-output, no event) except an inline
// checkoutInitFailed if the init malforms. submit escalate carries a burned-but-unproven seq to the driver's
// durable quarantine (no core event exists for it).

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
  if (ctx.activeSeq === null)
    throw new EngineError(`order ${ctx.orderId}: no active sequence for pay()`);
  return ctx.activeSeq;
}
function requirePaymentId(ctx: OrderCtx): string {
  if (ctx.paymentId === null)
    throw new EngineError(`order ${ctx.orderId}: no paymentId for psp call`);
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
  const basketItems: readonly BasketItem[] = [
    { ...psp.basketItemTemplate, price: ctx.paidPriceTry },
  ];
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

function cancelParams(ctx: OrderCtx, deps: EngineDeps): CancelParams {
  return {
    locale: deps.config.psp.locale,
    conversationId: ctx.conversationId,
    paymentId: requirePaymentId(ctx),
    ip: ctx.ip,
  };
}

function payRequest(
  ctx: OrderCtx,
  deps: EngineDeps,
): { req: PayRequest; ourSeq: bigint; maxTime: number } {
  const activeSeq = requireSeq(ctx);
  const ids = deriveIds(ctx.orderId, ctx.destination, ctx.amountStroops);
  const now = deps.clock.nowUnix();
  const maxTime = now + deps.config.stellar.timeboundsSecs;
  // minTime is 0 (no lower bound), NOT now(): a validated ledger's closeTime LAGS real-now by up to an
  // inter-ledger interval (~5s), so a tx with minTime=now() is rejected `txTooEarly` at submission and never
  // lands. maxTime is the real (deadness) expiry; the lower bound carries no money-safety role — replay/liveness
  // are covered by the order-pinned sequence + the on-chain Processed(tx_id) guard + maxTime — so 0 is safe and,
  // unlike a now()-derived bound, immune to clock skew / ledger lag.
  const minTime = 0;
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
async function doSubmitAndObserve(
  ctx: OrderCtx,
  coreState: State,
  deps: EngineDeps,
): Promise<PerformResult> {
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
  // record the maxTime too so the poll/recovery worker can rebuild this exact observe input after a crash.
  const ctxPatch: Partial<OrderCtx> = {
    hashHex: submit.hashHex,
    signedXdr: submit.signedXdr,
    payMaxTimeUnix: maxTime,
  };
  if (mapping.kind === 'escalate')
    return { event: null, ctxPatch, escalate: { reason: mapping.reason } };
  return { event: mapping.event, ctxPatch };
}

/**
 * Execute one effect. `coreState` is the state just ENTERED (r.next); `enteringEvent` is the event that
 * triggered the transition, or null for the eventless bootstrap (only fireSolvencyCheck runs there, which does
 * not consult it). Total over the 13 effects.
 */
export async function perform(
  effect: Effect,
  ctx: OrderCtx,
  coreState: State,
  enteringEvent: Event | null,
  deps: EngineDeps,
): Promise<PerformResult> {
  switch (effect) {
    case 'fireCheckoutForm': {
      // Hosted DIRECT-SALE start-and-wait: return the checkout URL/token side-output; the charge OUTCOME
      // arrives later via the webhook (retrieve -> chargeEvent). The happy path feeds NO core event. If the
      // form INIT itself malforms, emit a clean checkoutInitFailed (nothing was charged) -> FailedClean; this
      // is a money-SAFE clean failure, never an indeterminate-loss escalate.
      const raw = await deps.psp.initializeCheckoutForm(checkoutFormParams(ctx, deps));
      const proj = projectCheckoutFormInit(raw);
      if (proj.kind === 'malformed') return { event: { type: 'checkoutInitFailed' } };
      return {
        event: null,
        sideOutput: {
          kind: 'checkoutForm',
          token: proj.token,
          formContent: proj.checkoutFormContent,
          ...(proj.paymentPageUrl !== undefined ? { paymentPageUrl: proj.paymentPageUrl } : {}),
        },
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
        outcome.kind === 'reserved'
          ? 'solvencyOk'
          : outcome.kind === 'insufficient'
            ? 'solvencyFail'
            : 'solvencyUnknown';
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

    case 'allocateSeq': {
      // LATE allocation (Approach B): hand out the operator seq HERE, on chargeOk — the first step of the USDC
      // leg — so a pending/failed/abandoned order never holds one (no gap in the operator sequence space).
      // allocate() is idempotent per order, so a crash-retry of chargeOk returns the SAME seq (no leak, no
      // double-allocation). The trailing persistInFlight/submitPay in the same batch read this patched seq.
      //
      // Ordering note (adversarial-audited): allocate() persists the SequenceStore snapshot immediately, one
      // effect BEFORE persistInFlight writes the OrderRow with this seq. A crash in that window leaves the
      // SequenceStore holding seq S for an order whose durable OrderRow is still SolvencyReserved (seq null).
      // This is money-SAFE (no double-pay: the on-chain Processed(order_id) guard + the single-use sequence
      // shield both cap USDC delivery at one per order regardless of S) and, for a completed charge, self-heals:
      // recovery (poll worker group A) re-retrieves the SAME sale, which by iyzico retrieve monotonicity yields
      // chargeOk again -> idempotent allocate() returns S -> submitPay(S). The only residual is a THEORETICAL
      // liveness stranding of S (a durable-store-only, never-reachable-in-PoC case: the in-memory SequenceStore
      // is wiped by the very crash, so on restart the allocator re-bootstraps from the live on-chain seq). A
      // durable SequenceStore (Phase 2) closes it by reconciling ctx.activeSeq from activeSeqFor(orderId) on
      // recovery; see docs/SCOPE_AND_LIMITATIONS.md.
      const seq = deps.store.sequences.allocate(ctx.orderId);
      return { event: null, ctxPatch: { activeSeq: seq.toString() } };
    }

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

    case 'fireCancel': {
      // Void the completed TRY sale (same-day /payment/cancel), unwinding a charge whose USDC leg failed. Both a
      // definite FAILURE and an UNKNOWN mean "the sale is NOT confirmed voided". UNLIKE the irreversible USDC
      // leg, re-issuing a same-day void is money-SAFE — a second cancel of an already-voided sale cannot lose
      // money — so BOTH re-drive within a persisted budget and, once exhausted, escalate to a DURABLE LossReview.
      // (SUCCESS is the only confirming outcome.) There is no hold to expire in the money-first model, so an
      // UNKNOWN must NEVER be a bare observe-only stay: nothing re-polls ChargeReversing, so a stay would strand
      // a CHARGED order forever with no void and no loss flag. The bounded in-driver retry guarantees the
      // reversal always converges (ChargeReversed or LossReview) within a single advance().
      const raw = await deps.psp.cancel(cancelParams(ctx, deps));
      const cls = classifyIyzicoResult(raw, 'void');
      if (cls === 'SUCCESS') return { event: { type: 'reversalConfirmed' } };
      const n = await deps.store.bumpReversalRetries(ctx.orderId);
      return {
        event: {
          type: 'reversalNotDone',
          retriesRemaining: n <= deps.config.policy.maxReversalRetries,
        },
      };
    }

    case 'flagLoss':
      // A reversal budget was exhausted (a completed charge whose same-day void could not complete): record the
      // durable stuck-refund bucket with the on-chain witness, so it is observable for manual action. The bucket
      // is keyed off the entering event (reversalNotDone), which is always present on a flagLoss path.
      if (enteringEvent === null)
        throw new EngineError(`order ${ctx.orderId}: flagLoss without an entering event`);
      await deps.store.flagLoss(ctx.orderId, flagLossBucket(enteringEvent), ctx.hashHex);
      return NO_EVENT;

    case 'handToReconciler': {
      // Append the landed witness ONLY — do NOT synthesize {reconciled}. The order quiesces in UsdcConfirmed
      // (a durable wait); the offline reconciler drives ->Reconciled only after verifyReport MATCHES.
      if (ctx.hashHex === null || ctx.signedXdr === null || ctx.activeSeq === null) {
        throw new EngineError(
          `order ${ctx.orderId}: cannot append evidence — pay() witness missing`,
        );
      }
      // The row carries the ORDER as well as the witness. It is the only durable memory of this payout: the
      // registry that holds ctx lives in memory, and a crash a second from now would take it with it. Without
      // these facts the settlement worker could never rediscover the order, so its outflow would go unbooked and
      // its pool refill would be lost — both silently, while the solvency alarm rang about it forever.
      await deps.store.appendEvidence(
        ctx.orderId,
        {
          txHash: ctx.hashHex,
          signedXdr: ctx.signedXdr,
          seq: ctx.activeSeq,
          witnessedAtUnix: deps.clock.nowUnix(),
        },
        {
          destination: ctx.destination,
          amountStroops: ctx.amountStroops,
          memoHex: ctx.memoHex,
          appliedRateStroops: ctx.appliedRateStroops,
          paidPriceTry: ctx.paidPriceTry,
          spreadKurus: ctx.spreadKurus,
          feeKurus: ctx.feeKurus,
        },
      );
      return NO_EVENT;
    }

    case 'rePollObserveOnly':
      // Durable WAIT: the poll/recovery worker (4.3d) re-observes and later calls advance() with the event.
      // perform MUST NOT observe here — that is how "Unknown/uncertain never advances" is honored.
      return NO_EVENT;
  }
}
