import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/store/in-memory-store.js';

const UNIT = 10_000_000n;
const mk = (): InMemoryStore => new InMemoryStore({ balanceStroops: 100n * UNIT, baseSeq: 1000n });

describe('InMemoryStore — Store interface conformance', () => {
  it('createIfAbsent is idempotent: created once, exists after', async () => {
    const s = mk();
    expect(await s.createIfAbsent('o1')).toBe('created');
    expect(await s.createIfAbsent('o1')).toBe('exists');
    expect(s.orderRow('o1')?.state).toBe('Reserved');
  });

  it('persistState upserts state and merges only defined patch fields', async () => {
    const s = mk();
    await s.persistState('o1', 'UsdcSubmitted', { seq: '1001' });
    await s.persistState('o1', 'UsdcSubmitted', { hashHex: 'h', signedXdr: 'x' });
    const row = s.orderRow('o1');
    expect(row).toEqual({ state: 'UsdcSubmitted', seq: '1001', hashHex: 'h', signedXdr: 'x' });
  });

  it('markWebhookSeen dedups by eventId (first then duplicate)', async () => {
    const s = mk();
    expect(await s.markWebhookSeen('evt-1', 'o1', 1)).toBe('first');
    expect(await s.markWebhookSeen('evt-1', 'o1', 2)).toBe('duplicate');
    expect(await s.markWebhookSeen('evt-2', 'o1', 3)).toBe('first');
  });

  it('appendEvidence and flagLoss record durably', async () => {
    const s = mk();
    await s.appendEvidence('o1', { txHash: 'h', signedXdr: 'x', seq: '1001' });
    await s.flagLoss('o1', 'captureFailed', 'h');
    expect(s.evidenceRecords()).toEqual([{ orderId: 'o1', record: { txHash: 'h', signedXdr: 'x', seq: '1001' } }]);
    expect(s.lossRecords()[0]).toMatchObject({ orderId: 'o1', bucket: 'captureFailed', usdcTxHash: 'h' });
  });

  it('bump*Retries return the NEW post-increment value from 0', async () => {
    const s = mk();
    expect(await s.bumpDeadRetries('o1')).toBe(1);
    expect(await s.bumpDeadRetries('o1')).toBe(2);
    expect(await s.bumpCaptureRetries('o1')).toBe(1); // independent counter
    expect(await s.bumpVoidRetries('o1')).toBe(1);
  });

  it('reserve is idempotent per order (one reservation, same id, counted once)', async () => {
    const s = mk();
    const r1 = await s.reserve('o1', UNIT, 60_000, 0);
    const r2 = await s.reserve('o1', UNIT, 60_000, 0);
    expect(r1).toEqual({ kind: 'reserved', reservationId: 'res-o1' });
    expect(r2).toEqual({ kind: 'reserved', reservationId: 'res-o1' });
    expect(s.availableStroops()).toBe(99n * UNIT); // charged once, not twice
  });

  it('reserve fails closed on a same-order re-reserve for a DIFFERENT amount', async () => {
    const s = mk();
    await s.reserve('o1', UNIT, 60_000, 0);
    const bigger = await s.reserve('o1', 2n * UNIT, 60_000, 0);
    expect(bigger.kind).toBe('insufficient');
    expect(s.availableStroops()).toBe(99n * UNIT); // unchanged
  });

  it('releaseReservation frees capacity and re-reserve works', async () => {
    const s = mk();
    await s.reserve('o1', UNIT, 60_000, 0);
    expect(s.availableStroops()).toBe(99n * UNIT);
    await s.releaseReservation('o1', 'balanceGuardRevert');
    expect(s.availableStroops()).toBe(100n * UNIT);
    await s.reserve('o1', UNIT, 60_000, 0);
    expect(s.availableStroops()).toBe(99n * UNIT);
  });

  it('the real SequenceAllocator is wired (allocate hands out baseSeq+1)', async () => {
    const s = mk();
    expect(s.sequences.allocate('o1')).toBe(1001n);
    expect(s.sequences.allocate('o1')).toBe(1001n); // idempotent per order
  });
});
