import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import type { OrderCtx } from '../../src/ctx.js';
import type { State } from '@troia/core';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { KeyedMutex } from '../../src/store/mutex.js';
import { pollInFlight } from '../../src/worker/poll-worker.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// The money-first crash-recovery worker: READ (re-observe / re-retrieve) THEN DECIDE, never a blind resubmit.
// Every USDC send it drives is a positively-proven-safe path (same-seq replacement under the sequence shield).

/** Seed one order into the registry at `state` with a REAL allocated seq. Defaults give a witnessed USDC row
 *  (hashHex/signedXdr/payMaxTimeUnix set) — override to model a crash-before-submit or a pre-charge row. */
function seed(
  h: ReturnType<typeof makeHarness>,
  orderId: string,
  state: State,
  overrides: Partial<OrderCtx> = {},
) {
  const ctx = makeCtx(h.store, {
    orderId,
    hashHex: `hash_${orderId}`,
    signedXdr: `xdr_${orderId}`,
    payMaxTimeUnix: 2_000_000_000,
    ...overrides,
  });
  const registry = new InMemoryOrderRegistry();
  registry.put(ctx, state);
  return { ctx, registry, locks: new KeyedMutex() };
}

describe('pollInFlight — crash-recovery worker', () => {
  // ---- (A) stuck-charge recovery: re-retrieve the direct-sale result and re-drive chargeEvent ----

  it('(A) re-retrieves a stuck SolvencyReserved charge and, on chargeOk, resumes the irreversible USDC leg', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // the resumed USDC leg lands in the durable pending wait
    // token set (a form was issued); default psp retrieve => paymentStatus SUCCESS + fraud 1 => chargeOk
    const { registry, locks } = seed(h, 'order-1', 'SolvencyReserved', { token: 'tok-1' });

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 1, escalated: 0, quarantined: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('UsdcPending'); // charged, USDC submitted, now pending
    expect(h.trace).toContain('psp.retrieveCheckoutFormResult'); // the direct-sale re-retrieve ran
    expect(h.stellar.submitReqs).toHaveLength(1); // the USDC leg was fired exactly once
  });

  it('(A) a still-UNKNOWN charge (PRE_AUTH read) stays in SolvencyReserved — NEVER submits USDC on an unknown', async () => {
    const h = makeHarness();
    h.psp.retrievePhase = 'PRE_AUTH'; // an uncaptured hold reads UNKNOWN => chargeUnknown
    const { registry, locks } = seed(h, 'order-1', 'SolvencyReserved', { token: 'tok-1' });

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('SolvencyReserved'); // unchanged
    expect(h.trace).toContain('psp.retrieveCheckoutFormResult');
    expect(h.stellar.submitReqs).toHaveLength(0); // an unknown charge never advances to the money leg
  });

  // ---- (B) never-sent pay recovery: witness-null + charge done + seq active => same-seq replacement ----

  it('(B) a witness-null UsdcSubmitted with the charge done + seq active does a same-seq resubmit, NOT a quarantine', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // the replacement lands in the durable pending wait
    // hashHex null (pay never sent) but paymentId + activeSeq present (default makeCtx) => recoverable resubmit
    const { ctx, registry, locks } = seed(h, 'order-1', 'UsdcSubmitted', {
      hashHex: null,
      signedXdr: null,
      payMaxTimeUnix: null,
    });

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 1, quarantined: 0, escalated: 0 });
    expect(h.store.losses).toEqual([]); // NOT a loss — the pay was provably never sent
    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one same-seq replacement
    expect(h.stellar.submitReqs[0]?.seq).toBe((BigInt(ctx.activeSeq as string) - 1n).toString()); // SAME seq
    expect(h.store.deadRetries.get('order-1')).toBeUndefined(); // recoverResubmit does NOT consume the dead budget
    expect(registry.getByOrderId('order-1')?.state).toBe('UsdcPending');
  });

  // ---- (C) normal READ path: observe the known tx and let the core pick the money-safe next step ----

  it('(C) resumes a UsdcPending order when the tx has LANDED (observe SUCCESS -> UsdcConfirmed, evidence handed off)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'LANDED_SUCCESS';
    const { registry, locks } = seed(h, 'order-1', 'UsdcPending');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 1, escalated: 0, quarantined: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('UsdcConfirmed');
    expect(h.trace).toContain('stellar.observe');
    expect(h.trace).toContain('store.appendEvidence'); // handToReconciler ran (no capture leg anymore)
  });

  it('(C) READ-THEN-DECIDE: a STILL_PENDING tx is left in place with NO resubmit (no blind resubmit)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING';
    const { registry, locks } = seed(h, 'order-1', 'UsdcPending');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ polled: 1, advanced: 0 });
    expect(registry.getByOrderId('order-1')?.state).toBe('UsdcPending'); // unchanged
    expect(h.stellar.submitReqs).toHaveLength(0); // NEVER a submit on a still-live tx
  });

  it('(C) a DEAD tx drives the DELIBERATE same-seq replacement (budget-gated reuseOnDead, not a fresh seq)', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'DEAD_REPLACEABLE';
    const { ctx, registry, locks } = seed(h, 'order-1', 'UsdcPending');

    await pollInFlight(registry, locks, h.deps);

    expect(h.stellar.submitReqs).toHaveLength(1); // exactly one replacement
    expect(h.stellar.submitReqs[0]?.seq).toBe((BigInt(ctx.activeSeq as string) - 1n).toString()); // SAME seq
    expect(h.store.deadRetries.get('order-1')).toBe(1); // consumed the dead-retry budget
  });

  it('(C) an INDETERMINATE verdict quarantines (flagLoss) without advancing or touching the seq', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'INDETERMINATE_LOSS_REVIEW';
    const { ctx, registry, locks } = seed(h, 'order-1', 'UsdcPending');

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ escalated: 1, advanced: 0 });
    expect(h.store.losses).toEqual([{ orderId: 'order-1', bucket: 'indeterminateLossReview', usdcTxHash: 'hash_order-1' }]);
    expect((h.store.sequences as SequenceAllocator).statusOf(BigInt(ctx.activeSeq as string))).toBe('active');
  });

  it('a witness-null durable-wait row that CANNOT prove the pay was never sent is QUARANTINED (never stranded)', async () => {
    const h = makeHarness();
    // UsdcPending + null witness => the (B) never-sent proof does not apply (only UsdcSubmitted qualifies) => quarantine
    const { registry, locks } = seed(h, 'order-1', 'UsdcPending', { hashHex: null, signedXdr: null, payMaxTimeUnix: null });

    const report = await pollInFlight(registry, locks, h.deps);

    expect(report).toMatchObject({ quarantined: 1, advanced: 0 });
    expect(h.store.losses).toEqual([{ orderId: 'order-1', bucket: 'indeterminateLossReview', usdcTxHash: null }]);
    expect(h.trace).not.toContain('stellar.observe'); // no observe on a null witness — quarantine before READ
  });

  it('the snapshot work-list excludes orders already past the USDC wait (not even iterated)', async () => {
    const h = makeHarness();
    const { ctx, registry, locks } = seed(h, 'order-1', 'UsdcPending');
    registry.put(ctx, 'UsdcConfirmed'); // ordersInStates only returns SolvencyReserved/UsdcSubmitted/UsdcPending
    const report = await pollInFlight(registry, locks, h.deps);
    expect(report.polled).toBe(0);
  });

  it('the in-lock RE-READ skips an order that advanced AFTER the snapshot but before the lock (no stale drive)', async () => {
    const h = makeHarness();
    const { ctx, registry, locks } = seed(h, 'order-1', 'UsdcPending'); // IS in the UsdcPending snapshot
    // simulate a concurrent webhook/tick advancing it between the snapshot and the lock body: the in-lock
    // getByOrderId re-read now returns a UsdcConfirmed record, so the worker must skip and NOT observe/drive.
    registry.getByOrderId = () => ({ ctx, state: 'UsdcConfirmed' });
    const report = await pollInFlight(registry, locks, h.deps);
    expect(report).toMatchObject({ polled: 1, advanced: 0, escalated: 0, quarantined: 0 });
    expect(h.trace).not.toContain('stellar.observe'); // re-read guard fires BEFORE the READ
  });
});
