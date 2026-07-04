import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import { advance, start } from '../../src/engine/driver.js';
import { body, makeCtx, makeHarness, TIMEOUT } from '../fakes/harness.js';

// The money-critical FAILURE paths the adversarial verify found uncovered: void-retry termination, the
// capture-loss branch, the whole USDC-revert (double-pay) family, the solvency-reject void, and the two
// bootstrap/witness durability fixes.

describe('void retry is bounded (no unbounded fireCancel loop)', () => {
  it('a persistently-declining cancel terminates after maxVoidRetries+1 attempts and quiesces', async () => {
    const h = makeHarness();
    h.store.reserveResult = { kind: 'insufficient', available: 0n, requested: 1n };
    h.psp.cancelResult = body({ status: 'failure', conversationId: 'cid' }); // definite void FAILURE, forever
    const ctx = makeCtx(h.store);

    // preauthOk -> solvencyFail -> SolvencyRejected + fireCancel (declines repeatedly)
    const r = await advance(ctx, 'Reserved', { type: 'preauthOk' }, h.deps);

    expect(r.state).toBe('SolvencyRejected'); // quiesced in the void-pending state, hold left to expire
    expect(r.quiescence).toBe('waiting');
    // exactly maxVoidRetries retries + the final exhausting attempt
    expect(h.trace.filter((t) => t === 'psp.cancel')).toHaveLength(h.config.policy.maxVoidRetries + 1);
    expect(h.store.voidRetries.get(ctx.orderId)).toBe(h.config.policy.maxVoidRetries + 1);
  });
});

describe('capture-FAILURE loss path (USDC sent, TRY not captured)', () => {
  it('exhausts the capture-retry budget then flags loss(captureFailed) and voids', async () => {
    const h = makeHarness();
    h.psp.postAuth = body({ status: 'failure', errorCode: '10051', conversationId: 'cid' }); // whitelisted decline
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceSuccess' }, h.deps);

    expect(r.state).toBe('TryHoldVoided'); // LossReview -> fireCancel(voidConfirmed) -> terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.trace.filter((t) => t === 'psp.createPostAuth')).toHaveLength(h.config.policy.maxCaptureRetries + 1);
    expect(h.store.losses).toEqual([{ orderId: ctx.orderId, bucket: 'captureFailed', usdcTxHash: 'usdc-hash' }]);
  });
});

describe('USDC-revert family (D2) — the double-pay-critical chain', () => {
  it('revertAlreadyProcessed (code 1): burns seq, captures TRY, sends NO second USDC', async () => {
    const h = makeHarness();
    h.stellar.revertCode = 1;
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });
    const burnedSeq = BigInt(ctx.activeSeq as string);

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(h.trace).toContain('stellar.readRevertErrorCode');
    expect(r.state).toBe('TryCaptured'); // prior pay() already sent USDC -> capture, never a resubmit
    expect(h.stellar.submitReqs).toHaveLength(0); // NO second USDC payment
    expect((h.store.sequences as SequenceAllocator).statusOf(burnedSeq)).toBe('burned');
  });

  it('revertBalanceGuard (code 2): clean release(balanceGuardRevert) + void, NO resubmit', async () => {
    const h = makeHarness();
    h.stellar.revertCode = 2;
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(r.state).toBe('TryHoldVoided');
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'balanceGuardRevert' }]);
    expect(h.stellar.submitReqs).toHaveLength(0);
  });

  it('revertOther (code null): reallocates a FRESH seq and resubmits exactly once (never reuses the burned seq)', async () => {
    const h = makeHarness();
    h.stellar.revertCode = null; // -> Other
    const ctx = makeCtx(h.store, { hashHex: 'prior-hash', signedXdr: 'prior-xdr' });
    const burnedTxSeq = (BigInt(ctx.activeSeq as string) - 1n).toString();

    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceReverted' }, h.deps);

    expect(r.state).toBe('TryCaptured'); // fresh seq resubmit lands + captures
    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one resubmit
    expect(h.stellar.submitReqs[0]?.seq).not.toBe(burnedTxSeq); // a NEW seq, not the burned one
  });
});

describe('solvency-reject void path', () => {
  it('solvencyFail voids the hold with NO releaseReservation on the reject path', async () => {
    const h = makeHarness();
    h.store.reserveResult = { kind: 'insufficient', available: 0n, requested: 1n };
    const ctx = makeCtx(h.store);

    const r = await advance(ctx, 'Reserved', { type: 'preauthOk' }, h.deps);

    expect(r.state).toBe('TryHoldVoided');
    expect(h.trace).toContain('psp.cancel');
    expect(h.store.releases).toHaveLength(0); // solvencyFail emits fireCancel only, not releaseReservation
  });
});

describe('start() bootstrap failure is durably recorded (not silently bricked)', () => {
  it('a malformed checkout-init writes a checkoutInitFailed marker and escalates', async () => {
    const h = makeHarness();
    h.psp.init = TIMEOUT; // -> projectCheckoutFormInit malformed -> escalate
    const ctx = makeCtx(h.store);

    const r = await start(ctx, h.deps);

    expect(r.quiescence).toBe('escalated');
    expect(r.state).toBe('Reserved');
    expect(h.store.losses).toEqual([{ orderId: ctx.orderId, bucket: 'checkoutInitFailed', usdcTxHash: null }]);
  });
});

describe('pay witness is durably persisted at submit time (cross-process resume safety)', () => {
  it('a STILL_PENDING quiesce leaves the witness in a persisted OrderRow, not only in-memory', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // quiesce in UsdcPending (the durable wait)
    const ctx = makeCtx(h.store);

    const r = await advance(ctx, 'TryPreauthed', { type: 'solvencyOk' }, h.deps);

    expect(r.state).toBe('UsdcPending');
    expect(r.quiescence).toBe('waiting');
    // the witness is durable (a rebuilt-from-OrderRow ctx would carry hashHex), not lost with the in-memory ctx
    expect(h.store.persisted.some((p) => p.patch.hashHex === 'hash_order-001' && p.patch.signedXdr === 'xdr_order-001')).toBe(true);
  });
});
