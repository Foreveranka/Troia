import { describe, expect, it } from 'vitest';
import { advance } from '../../src/engine/driver.js';
import { body, makeCtx, makeHarness } from '../fakes/harness.js';

// Money-first: the driver now auto-advances exactly ONE pure-decision state — UsdcDead (the same-seq
// replacement budget) — exercised at both budget edges. The states that USED to be decisions are gone:
// UsdcConfirmed is now a reconciled-only DURABLE WAIT (no capture leg — the driver must NOT synthesize a
// forward event), and the old "expired hold -> loss + void" defensive edge is re-mapped to its closest
// money-first analogue, the reversal leg (a completed charge whose same-day void exhausts its budget ->
// LossReview flagLoss).
describe('engine decision states', () => {
  it('UsdcConfirmed is a reconciled-only durable wait (driver does NOT auto-advance a capture leg)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store, { hashHex: 'h', signedXdr: 'x' });
    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceSuccess' }, h.deps);
    expect(r.state).toBe('UsdcConfirmed'); // no capture: quiesce here, wait for the offline reconciler
    expect(r.quiescence).toBe('waiting');
    expect(h.trace).toContain('store.appendEvidence'); // handToReconciler recorded the landed witness
    expect(h.store.evidence).toHaveLength(1);
    expect(h.store.evidence[0]?.record.txHash).toBe('h');
    expect(h.store.evidence[0]?.record.seq).toBe(ctx.activeSeq);
    expect(h.trace).not.toContain('psp.cancel'); // no void on the success path
    expect(h.store.losses).toHaveLength(0);
  });

  it('exhausted reversal budget flags the stuck-refund loss after the void keeps failing (was: expired-hold loss+void)', async () => {
    const h = makeHarness();
    h.psp.cancelResult = body({ status: 'failure', conversationId: 'cid' }); // void keeps FAILING
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });
    h.store.reversalRetries.set(ctx.orderId, h.config.policy.maxReversalRetries); // next bump -> maxReversal+1 -> false
    const r = await advance(
      ctx,
      'ChargeReversing',
      { type: 'reversalNotDone', retriesRemaining: true },
      h.deps,
    );
    expect(r.state).toBe('LossReview'); // fireCancel(FAILURE) -> reversalNotDone(false) -> LossReview['flagLoss']
    expect(r.quiescence).toBe('waiting'); // manual sink (not an absolute terminal)
    expect(h.store.losses).toEqual([
      { orderId: ctx.orderId, bucket: 'reversalExhausted', usdcTxHash: 'usdc-hash' },
    ]);
    expect(h.trace).toContain('psp.cancel');
    expect(h.trace).toContain('store.flagLoss:reversalExhausted');
    expect(h.stellar.submitReqs).toHaveLength(0); // no money-moving submit on the reversal leg
  });

  it('UsdcDead RETRIES a same-seq replacement while budget remains (bumps the persisted counter)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // the replacement stays in flight -> quiesce in UsdcPending
    const ctx = makeCtx(h.store);
    const r = await advance(ctx, 'UsdcPending', { type: 'pollDead' }, h.deps);
    expect(r.state).toBe('UsdcPending');
    expect(r.quiescence).toBe('waiting');
    expect(h.store.deadRetries.get(ctx.orderId)).toBe(1);
    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one same-seq replacement submitted
    expect(h.stellar.submitReqs[0]?.seq).toBe((BigInt(ctx.activeSeq as string) - 1n).toString());
  });

  it('UsdcDead ABANDONS once the replacement budget is exhausted (releases seq + reservation, voids the sale)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);
    h.store.deadRetries.set(ctx.orderId, h.config.policy.maxDeadRetries); // next bump -> maxDead+1 -> false
    const r = await advance(ctx, 'UsdcPending', { type: 'pollDead' }, h.deps);
    expect(r.state).toBe('ChargeReversed'); // deadRetry(false) -> ChargeReversing -> fireCancel(SUCCESS) -> terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]);
    expect(h.stellar.submitReqs).toHaveLength(0); // no further money-moving submit
    expect(h.trace).toContain('psp.cancel');
  });
});
