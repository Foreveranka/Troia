import { describe, expect, it } from 'vitest';
import { InMemoryJournal, SystemClock } from '../src/in-memory-journal.js';

describe('InMemoryJournal — write-ahead persistence (PoC single-process)', () => {
  it('persists then loads the exact envelope', async () => {
    const j = new InMemoryJournal();
    await j.persistPreSubmit('order-1', '1000', 'deadbeef', 'AAAA==');
    expect(await j.loadPersisted('order-1')).toEqual({ hashHex: 'deadbeef', signedXdr: 'AAAA==' });
  });

  it('returns null for an unknown order (no witness -> the safe re-drive default upstream)', async () => {
    expect(await new InMemoryJournal().loadPersisted('nope')).toBeNull();
  });

  it('a same-seq replacement submit overwrites with the latest envelope', async () => {
    const j = new InMemoryJournal();
    await j.persistPreSubmit('order-1', '1000', 'aaaa', 'X1==');
    await j.persistPreSubmit('order-1', '1000', 'bbbb', 'X2==');
    expect(await j.loadPersisted('order-1')).toEqual({ hashHex: 'bbbb', signedXdr: 'X2==' });
  });

  it('keeps orders independent', async () => {
    const j = new InMemoryJournal();
    await j.persistPreSubmit('a', '1', 'ha', 'sa');
    await j.persistPreSubmit('b', '2', 'hb', 'sb');
    expect(await j.loadPersisted('a')).toEqual({ hashHex: 'ha', signedXdr: 'sa' });
    expect(await j.loadPersisted('b')).toEqual({ hashHex: 'hb', signedXdr: 'sb' });
  });
});

describe('SystemClock', () => {
  it('nowUnix returns integer epoch seconds', () => {
    const t = new SystemClock().nowUnix();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(1_700_000_000); // after 2023-11 — a sane lower bound
  });
});
