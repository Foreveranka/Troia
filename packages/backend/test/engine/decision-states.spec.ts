import { describe, expect, it } from 'vitest';
import { advance } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// The two PURE-decision states the driver auto-advances: UsdcConfirmed (capture vs hold-expired) and UsdcDead
// (same-seq replacement budget). Both are exercised at the budget/time edges.
describe('engine decision states', () => {
  it('UsdcConfirmed proceeds to capture while the hold is live', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store, { hashHex: 'h', signedXdr: 'x' });
    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceSuccess' }, h.deps);
    expect(r.state).toBe('TryCaptured');
    expect(h.trace).toContain('psp.createPostAuth');
    expect(h.store.losses).toHaveLength(0);
  });

  it('UsdcConfirmed with an EXPIRED hold flags loss and voids (defensive holdExpired)', async () => {
    const h = makeHarness();
    h.clock.now = h.config.policy.preauthValidityUnix + 1;
    const ctx = makeCtx(h.store, { hashHex: 'usdc-hash', signedXdr: 'x' });
    const r = await advance(ctx, 'UsdcSubmitted', { type: 'evidenceSuccess' }, h.deps);
    expect(r.state).toBe('TryHoldVoided'); // LossReview -> fireCancel(voidConfirmed) -> terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.store.losses).toEqual([{ orderId: ctx.orderId, bucket: 'holdExpired', usdcTxHash: 'usdc-hash' }]);
    expect(h.trace).toContain('psp.cancel');
    expect(h.trace).not.toContain('psp.createPostAuth');
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

  it('UsdcDead ABANDONS once the replacement budget is exhausted (releases seq + reservation, voids)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);
    h.store.deadRetries.set(ctx.orderId, h.config.policy.maxDeadRetries); // next bump -> maxDead+1 -> false
    const r = await advance(ctx, 'UsdcPending', { type: 'pollDead' }, h.deps);
    expect(r.state).toBe('TryHoldVoided'); // AbandonedSeqReturned -> fireCancel(voidConfirmed) -> terminal
    expect(r.quiescence).toBe('terminal');
    expect(h.store.releases).toEqual([{ orderId: ctx.orderId, reason: 'abandoned' }]);
    expect(h.stellar.submitReqs).toHaveLength(0); // no further money-moving submit
    expect(h.trace).toContain('psp.cancel');
  });
});
