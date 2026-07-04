import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import { advance } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// INDETERMINATE_LOSS_REVIEW: the IRREVERSIBLE USDC leg's observe returns a verdict with NO clean core event
// (verdictToCore -> escalate). The driver must DURABLY flag it and QUARANTINE the seq — never burn/reuse it,
// never void the completed sale, never move money — for the reconciler.
describe('engine escalate (indeterminate loss review)', () => {
  it('durably flags loss and quarantines the seq without any mutation', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'INDETERMINATE_LOSS_REVIEW';
    const ctx = makeCtx(h.store);

    // SolvencyReserved --chargeOk--> UsdcSubmitted[persistInFlight, submitPay]; the single observe returns the
    // indeterminate verdict, which escalates (there is no core event to advance on).
    const r = await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);

    expect(r.quiescence).toBe('escalated');
    expect(r.state).toBe('UsdcSubmitted'); // stays in the live in-flight state (no core event exists)
    expect(r.escalate).not.toBeNull();

    // DURABLE record with the pay() witness, keyed to the indeterminate bucket
    expect(h.store.losses).toEqual([
      { orderId: ctx.orderId, bucket: 'indeterminateLossReview', usdcTxHash: 'hash_order-001' },
    ]);

    // seq QUARANTINED: still active, never burned, never released, never reused
    const seqs = h.store.sequences as SequenceAllocator;
    expect(seqs.statusOf(BigInt(ctx.activeSeq as string))).toBe('active');
    expect(h.store.releases).toHaveLength(0);
    expect(h.trace).not.toContain('stellar.readRevertErrorCode'); // no confirmBurnedSeq
    expect(h.trace).not.toContain('psp.cancel'); // no void of the completed TRY sale
  });
});
