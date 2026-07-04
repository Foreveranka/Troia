import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import type { OrderCtx } from '../../src/ctx.js';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { KeyedMutex } from '../../src/store/mutex.js';
import { pollInFlight } from '../../src/worker/poll-worker.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// The SPIKE-2 crash-recovery worker: READ (re-observe) THEN DECIDE, never a blind resubmit.

function seedPending(h: ReturnType<typeof makeHarness>, orderId: string, overrides: Partial<OrderCtx> = {}) {
  const ctx = makeCtx(h.store, {
    orderId,
    hashHex: `hash_${orderId}`,
    signedXdr: `xdr_${orderId}`,
    payMaxTimeUnix: 2_000_000_000,
    ...overrides,
  });
  const registry = new InMemoryOrderRegistry();
  registry.put(ctx, 'UsdcPending');
  return { ctx, registry, locks: new KeyedMutex() };
}

describe('pollInFlight — crash-recovery worker', () => {
  it('resumes a UsdcPending order to completion when the tx has landed (observe SUCCESS -> capture)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'LANDED_SUCCESS';
    const { registry, locks } = seedPending(h, 'order-1');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 1, escalated: 0, quarantined: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('TryCaptured');
    expect(h.trace).toContain('stellar.observe');
    expect(h.trace).toContain('psp.createPostAuth'); // the capture leg ran
  });

  it('READ-THEN-DECIDE: a STILL_PENDING tx is left in place with NO resubmit (no blind resubmit)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING';
    const { registry, locks } = seedPending(h, 'order-1');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('UsdcPending'); // unchanged
    expect(h.stellar.submitReqs).toHaveLength(0); // NEVER a submit on a still-live tx
  });

  it('a DEAD tx drives the DELIBERATE same-seq replacement (budget-gated reuseOnDead, not a fresh seq)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'DEAD_REPLACEABLE';
    const { ctx, registry, locks } = seedPending(h, 'order-1');

    await pollInFlight(registry, locks, h.deps);

    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one replacement
    expect(h.stellar.submitReqs[0]?.seq).toBe((BigInt(ctx.activeSeq as string) - 1n).toString()); // SAME seq
    expect(h.store.deadRetries.get('order-1')).toBe(1); // consumed the retry budget
  });

  it('an INDETERMINATE verdict quarantines (flagLoss) without advancing or touching the seq', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'INDETERMINATE_LOSS_REVIEW';
    const { ctx, registry, locks } = seedPending(h, 'order-1');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ escalated: 1, advanced: 0 });
    expect(h.store.losses).toEqual([{ orderId: 'order-1', bucket: 'indeterminateLossReview', usdcTxHash: 'hash_order-1' }]);
    expect((h.store.sequences as SequenceAllocator).statusOf(BigInt(ctx.activeSeq as string))).toBe('active');
  });

  it('a witness-null durable-wait row is QUARANTINED (not silently skipped) so it is never stranded', async () => {
    const h = makeHarness();
    const { registry, locks } = seedPending(h, 'order-1', { hashHex: null, signedXdr: null, payMaxTimeUnix: null });

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ quarantined: 1, advanced: 0 });
    expect(h.store.losses).toEqual([{ orderId: 'order-1', bucket: 'indeterminateLossReview', usdcTxHash: null }]);
    expect(h.trace).not.toContain('stellar.observe'); // no observe on a null witness — quarantine before READ
  });

  it('the snapshot work-list excludes orders already past the USDC wait (not even iterated)', async () => {
    const h = makeHarness();
    const { ctx, registry, locks } = seedPending(h, 'order-1');
    registry.put(ctx, 'TryCaptured'); // ordersInStates only returns UsdcSubmitted/UsdcPending
    const report = await pollInFlight(registry, locks, h.deps);
    expect(report.polled).toBe(0);
  });

  it('the in-lock RE-READ skips an order that advanced AFTER the snapshot but before the lock (no stale drive)', async () => {
    const h = makeHarness();
    const { ctx, registry, locks } = seedPending(h, 'order-1'); // IS in the UsdcPending snapshot
    // simulate a concurrent webhook/tick advancing it between the snapshot and the lock body: the in-lock
    // getByOrderId re-read now returns a TryCaptured record, so the worker must skip and NOT observe/drive.
    registry.getByOrderId = () => ({ ctx, state: 'TryCaptured' });
    const report = await pollInFlight(registry, locks, h.deps);
    expect(report).toMatchObject({ polled: 1, advanced: 0, escalated: 0, quarantined: 0 });
    expect(h.trace).not.toContain('stellar.observe'); // re-read guard fires BEFORE the READ
  });
});
