import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import { advance, start } from '../../src/engine/driver.js';
import { makeHarness, makePreChargeCtx } from '../fakes/harness.js';

// The headline property of Approach B (late sequence allocation): a reserved-but-never-charged order holds NO
// operator sequence, so it leaves NO gap in the monotonic operator sequence space — the next order that DOES
// charge gets the first seq. Under the old eager model, every abandoned checkout burned a seq and pushed the
// operator's sequence forward, so a burst of abandonment could strand the account behind a wall of unused seqs.
// FakeStore's baseSeq is 1000, so the FIRST allocation returns 1001 and BuildParams.seq (= activeSeq-1) is 1000.

describe('late sequence allocation — an abandoned order consumes no operator sequence (no gap)', () => {
  it('order A abandoned in SolvencyReserved holds no seq; order B (charged) gets the FIRST seq, gap-free', async () => {
    const h = makeHarness();
    const seqs = h.store.sequences as SequenceAllocator;

    // Order A: reserved + hosted form shown, but the customer never pays (abandoned in SolvencyReserved).
    const a = makePreChargeCtx(h.store, { orderId: 'A' });
    const ra = await start(a, h.deps);
    expect(ra.state).toBe('SolvencyReserved');
    expect(seqs.activeSeqFor('A')).toBeUndefined(); // A holds NO seq
    expect(seqs.snapshot().nextSeq).toBe(1001n); // nothing consumed yet — the pool is untouched by an abandonment

    // Order B: reserved + charged. Its seq is the FIRST ever handed out (1001), NOT 1002 — A left no gap.
    const b = makePreChargeCtx(h.store, { orderId: 'B' });
    await start(b, h.deps);
    const rb = await advance(b, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);
    expect(rb.ctx.activeSeq).toBe('1001'); // B got the FIRST seq — A consumed none
    expect(h.stellar.submitReqs[0]?.seq).toBe('1000'); // BuildParams.seq = activeSeq-1 => tx seqNum 1001
    expect(seqs.activeSeqFor('A')).toBeUndefined(); // A STILL holds none after B settles
  });

  it('a whole burst of abandoned orders consumes ZERO seqs — only the one that charges advances the pool', async () => {
    const h = makeHarness();
    const seqs = h.store.sequences as SequenceAllocator;

    // Ten customers open the form and walk away (abandoned in SolvencyReserved).
    for (let i = 0; i < 10; i++) {
      const ctx = makePreChargeCtx(h.store, { orderId: `abandon-${i}` });
      const r = await start(ctx, h.deps);
      expect(r.state).toBe('SolvencyReserved');
    }
    expect(seqs.snapshot().nextSeq).toBe(1001n); // still the base — ten abandonments consumed NOTHING

    // The eleventh actually pays: it gets seq 1001, not 1011 — the abandoned ten left no gap.
    const payer = makePreChargeCtx(h.store, { orderId: 'payer' });
    await start(payer, h.deps);
    const rp = await advance(payer, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);
    expect(rp.ctx.activeSeq).toBe('1001');
  });

  it('idempotent: a re-driven chargeOk (crash-retry) reuses the SAME seq — never double-allocates', async () => {
    const h = makeHarness();
    h.stellar.observeVerdict = 'STILL_PENDING'; // each chargeOk quiesces in UsdcPending (leaves the row live)
    const seqs = h.store.sequences as SequenceAllocator;
    const ctx = makePreChargeCtx(h.store, { orderId: 'C' });
    await start(ctx, h.deps);

    const r1 = await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);
    expect(r1.ctx.activeSeq).toBe('1001');

    // A crash between allocateSeq and the UsdcSubmitted persist leaves the row at SolvencyReserved; recovery
    // re-retrieves -> chargeOk again. allocate() is idempotent per order, so it returns the SAME seq.
    const r2 = await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);
    expect(r2.ctx.activeSeq).toBe('1001'); // same seq, no second allocation
    expect(seqs.snapshot().nextSeq).toBe(1002n); // exactly ONE seq consumed across both drives
    // both submits ride the SAME seq — the on-chain sequence shield guarantees at most one lands (no double-pay)
    expect(h.stellar.submitReqs).toHaveLength(2);
    expect(h.stellar.submitReqs.every((s) => s.seq === '1000')).toBe(true);
  });
});
