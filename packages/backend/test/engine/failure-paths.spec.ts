import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import { advance, start } from '../../src/engine/driver.js';
import { body, makeCtx, makeHarness, TIMEOUT } from '../fakes/harness.js';

// The money-critical FAILURE paths (money-first, Phase 4.6): the bounded reversal (same-day void) loop, the
// dead-retry-budget exhaustion that voids the completed sale, the whole USDC-revert (double-pay) family, the
// two clean-reject paths (solvencyFail / chargeRejected — nothing charged), the checkout-init clean failure,
// and the pay-witness durability fix. There is no preauth/capture leg anymore, so the old capture-loss and
// solvency-reject-void scenarios are re-mapped to their closest money-first analogues (the dead-exhaustion
// void and the solvencyFail clean fail) so coverage does not shrink.

describe('reversal (same-day void) retry is bounded (no unbounded fireCancel loop)', () => {
  it('a persistently-declining cancel terminates in LossReview after maxReversalRetries+1 attempts and quiesces', async () => {
    const h = makeHarness();
    h.psp.cancelResult = body({ status: 'failure', conversationId: 'cid' }); // definite void FAILURE, forever
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });

    // dead budget exhausted -> ChargeReversing[releaseSeq,releaseReservation,fireCancel]; the void declines
    // forever, so the bounded fireCancel loop must terminate in the durable stuck-refund sink (NOT a silent loop).
    const r = await advance(ctx, 'UsdcDead', { type: 'deadRetry', retriesRemaining: false }, h.deps);

    expect(r.state).toBe('LossReview'); // reversal budget exhausted -> flagLoss -> manual sink
    expect(r.quiescence).toBe('waiting'); // LossReview is a manual sink, not an absolute terminal
    // exactly maxReversalRetries retries + the final exhausting attempt
    expect(h.trace.filter((t) => t === 'psp.cancel')).toHaveLength(h.config.policy.maxReversalRetries + 1);
    expect(h.store.reversalRetries.get(ctx.orderId)).toBe(h.config.policy.maxReversalRetries + 1);
    // the stuck reversal is DURABLY recorded with the on-chain witness, not silently parked
    expect(h.store.losses).toEqual([{ orderId: ctx.orderId, bucket: 'reversalExhausted', usdcTxHash: 'usdc-hash' }]);
  });
});

describe('dead-retry budget exhaustion voids the completed sale (USDC could not land)', () => {
  it('exhausts the same-seq replacement budget then voids the sale to ChargeReversed, no second USDC', async () => {
    const h = makeHarness(); // default cancelResult = success -> the void completes cleanly
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });

    // deadRetry(false): the replacement budget is spent -> abandon the seq, release the reservation, void the sale.
    const r = await advance(ctx, 'UsdcDead', { type: 'deadRetry', retriesRemaining: false }, h.deps);

    expect(r.state).toBe('ChargeReversed'); // ChargeReversing -> reversalConfirmed -> clean terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.trace.filter((t) => t === 'psp.cancel')).toHaveLength(1); // one successful void, no retry loop
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]);
    expect(h.store.losses).toHaveLength(0); // a clean unwind, not a loss
    expect(h.stellar.submitReqs).toHaveLength(0); // the USDC leg is NOT re-attempted once we void
  });
});

describe('USDC-revert family (D2) — the double-pay-critical chain', () => {
  it('revertAlreadyProcessed (code 1): burns seq, treats as confirmed, sends NO second USDC', async () => {
    const h = makeHarness();
    h.stellar.revertCode = 1;
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });
    const burnedSeq = BigInt(ctx.activeSeq as string);

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(h.trace).toContain('stellar.readRevertErrorCode');
    expect(r.state).toBe('UsdcConfirmed'); // prior pay() already delivered USDC -> treat as confirmed, never resubmit
    expect(h.stellar.submitReqs).toHaveLength(0); // NO second USDC payment
    expect(h.store.evidence).toHaveLength(0); // revertAlreadyProcessed does NOT handToReconciler (reverted tx isn't the winner)
    expect((h.store.sequences as SequenceAllocator).statusOf(burnedSeq)).toBe('burned');
  });

  it('revertBalanceGuard (code 2): clean releaseReservation + void the sale -> ChargeReversed, NO resubmit', async () => {
    const h = makeHarness(); // default cancelResult = success -> the void completes cleanly
    h.stellar.revertCode = 2;
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(r.state).toBe('ChargeReversed'); // USDC didn't move -> void the completed sale -> clean terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.trace).toContain('psp.cancel');
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]); // releaseReason(ChargeReversing)
    expect(h.stellar.submitReqs).toHaveLength(0); // NO resubmit — the seq is burned, money didn't move
  });

  it('an UNKNOWN (timeout) void NEVER strands ChargeReversing — it retries within budget then escalates to LossReview', async () => {
    // Regression (adversarial finding #1): before the fix, reversalUnknown -> rePollObserveOnly parked a CHARGED
    // order in ChargeReversing forever (nothing re-polls it, no loss flag). A same-day void is idempotent, so an
    // UNKNOWN outcome now re-drives within the budget and converges to a DURABLE LossReview — never a silent strand.
    const h = makeHarness();
    h.stellar.revertCode = 2; // -> revertBalanceGuard -> ChargeReversing
    h.psp.cancelResult = TIMEOUT; // the void is always UNKNOWN (transport timeout), forever
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(r.state).toBe('LossReview'); // converges — NOT stranded in ChargeReversing
    expect(h.trace.filter((t) => t === 'psp.cancel')).toHaveLength(h.config.policy.maxReversalRetries + 1);
    expect(h.store.losses).toEqual([{ orderId: ctx.orderId, bucket: 'reversalExhausted', usdcTxHash: 'usdc-hash' }]);
  });

  it('revertOther (code null): reallocates a FRESH seq and resubmits exactly once (never reuses the burned seq)', async () => {
    const h = makeHarness();
    h.stellar.revertCode = null; // -> Other
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });
    const burnedTxSeq = (BigInt(ctx.activeSeq as string) - 1n).toString();

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(r.state).toBe('UsdcConfirmed'); // fresh-seq resubmit lands (default LANDED_SUCCESS) -> awaits reconciler
    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one resubmit
    expect(h.stellar.submitReqs[0]?.seq).not.toBe(burnedTxSeq); // a NEW seq, not the burned one
  });
});

describe('clean rejection paths (nothing charged, no void)', () => {
  it('solvencyFail -> FailedClean with releaseSeq only, NO releaseReservation and NO void', async () => {
    const h = makeHarness();
    h.store.reserveResult = { kind: 'insufficient', available: 0n, requested: 1n };
    const ctx = makeCtx(h.store);

    // money-first: solvency is reserved FIRST (at bootstrap). An insufficient reserve fails clean before any charge.
    const r = await start(ctx, h.deps);

    expect(r.state).toBe('FailedClean');
    expect(r.quiescence).toBe('terminal');
    expect(h.store.releases).toHaveLength(0); // solvencyFail emits releaseSeq only, never releaseReservation
    expect(h.trace).not.toContain('psp.cancel'); // nothing was charged -> nothing to void
    expect((h.store.sequences as SequenceAllocator).activeSeqFor(ctx.orderId)).toBeUndefined(); // seq released
  });

  it('chargeRejected -> FailedClean with releaseSeq + releaseReservation, NO void', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);

    const r = await advance(ctx, 'SolvencyReserved', { type: 'chargeRejected' }, h.deps);

    expect(r.state).toBe('FailedClean');
    expect(r.quiescence).toBe('terminal');
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]); // reservation freed, sale declined
    expect(h.trace).not.toContain('psp.cancel'); // a declined sale takes nothing -> no void
    expect(h.stellar.submitReqs).toHaveLength(0); // no USDC leg on a declined charge
    expect((h.store.sequences as SequenceAllocator).activeSeqFor(ctx.orderId)).toBeUndefined(); // seq released
  });
});

describe('checkout-init failure is a money-safe clean failure (not silently bricked)', () => {
  it('a malformed checkout-init drives checkoutInitFailed -> FailedClean, releasing the reservation', async () => {
    const h = makeHarness();
    h.psp.init = TIMEOUT; // -> projectCheckoutFormInit malformed -> checkoutInitFailed (a clean, money-safe failure)
    const ctx = makeCtx(h.store);

    const r = await start(ctx, h.deps);

    expect(r.state).toBe('FailedClean'); // reserve succeeded, form init malformed -> clean fail, nothing charged
    expect(r.quiescence).toBe('terminal');
    expect(h.trace).toContain('psp.initializeCheckoutForm');
    expect(h.store.losses).toHaveLength(0); // NEVER an indeterminate-loss escalate — the form never opened
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]); // the reservation is freed
  });
});

describe('pay witness is durably persisted at submit time (cross-process resume safety)', () => {
  it('a STILL_PENDING quiesce leaves the witness in a persisted OrderRow, not only in-memory', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // quiesce in UsdcPending (the durable wait)
    const ctx = makeCtx(h.store);

    // charge succeeded -> the USDC leg is submitted LAST; the submit observes STILL_PENDING -> evidencePending.
    const r = await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);

    expect(r.state).toBe('UsdcPending');
    expect(r.quiescence).toBe('waiting');
    // the witness is durable (a rebuilt-from-OrderRow ctx would carry hashHex), not lost with the in-memory ctx
    expect(h.store.persisted.some((p) => p.patch.hashHex === 'hash_order-001' && p.patch.signedXdr === 'xdr_order-001')).toBe(true);
  });
});
