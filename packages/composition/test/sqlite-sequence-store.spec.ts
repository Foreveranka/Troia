// The durable sequence machinery (A-5 + the missing piece of A-1's recovery), proven the same way as every
// durable store here: do seq work, drop everything, reopen over the same file, and check the second life can
// finish what the first one started — the exact calls (reuseOnDead / confirmBurned / reallocate) a restarted
// poll worker makes for an in-flight order, which used to hit UnknownSeq on the forgotten allocator.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPoolProvider, SequenceAllocator } from '@troia/core';
import { openOrderDb } from '../src/order-db.js';
import {
  decodeSequenceSnapshot,
  encodeSequenceSnapshot,
  SeqSnapshotCodecError,
  SqliteChannelMapStore,
  SqliteSequenceStore,
} from '../src/sqlite-sequence-store.js';
import { SqliteOrderStore } from '../src/sqlite-order-store.js';

const CH_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5A';
const CH_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUOF4';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-seqstore-'));
}

describe('sequence snapshot codec', () => {
  it('round-trips exactly (bigints as decimal strings) and fails closed on drift', () => {
    const snapshot = {
      baseSeq: 2n ** 60n,
      nextSeq: 2n ** 60n + 3n,
      freeList: [2n ** 60n + 1n],
      records: [{ seq: 2n ** 60n + 2n, orderId: 'o1', status: 'active' as const }],
      byOrder: [['o1', 2n ** 60n + 2n] as const],
    };
    expect(decodeSequenceSnapshot(encodeSequenceSnapshot(snapshot))).toEqual(snapshot);
    expect(() => decodeSequenceSnapshot('junk')).toThrow(SeqSnapshotCodecError);
    expect(() => decodeSequenceSnapshot('{"v":99}')).toThrow(/unsupported version/);
  });
});

describe('SqliteSequenceStore — the allocator survives a restart (the A-1 recovery gap, closed)', () => {
  it('a restarted allocator can reuseOnDead / confirmBurned / reallocate a seq the crash left in flight', () => {
    const dir = tmp();
    const life1 = new SequenceAllocator(
      new SqliteSequenceStore(openOrderDb(dir), 'operator'),
      1000n,
    );
    const seq = life1.allocate('o1'); // 1001n — in flight when the process dies

    const life2 = new SequenceAllocator(
      new SqliteSequenceStore(openOrderDb(dir), 'operator'),
      999_999n,
    );
    expect(life2.allocate('o1')).toBe(seq); // idempotent per order, ACROSS lives (not a fresh 1000000n)
    expect(life2.reuseOnDead(seq, 'o1')).toBe(seq); // the dead-path replacement no longer throws UnknownSeq
    life2.confirmBurned(seq); // ...nor does the reverted path
    expect(life2.reallocate('o1')).toBe(seq + 1n); // and the fresh seq continues the SAME space
  });

  it('the SqliteOrderStore wires it by default: its allocator state lives in orders.db', () => {
    const dir = tmp();
    const store1 = new SqliteOrderStore({
      db: openOrderDb(dir),
      balanceStroops: 0n,
      baseSeq: 1000n,
    });
    const seq = store1.sequences.allocate('o1');
    const store2 = new SqliteOrderStore({
      db: openOrderDb(dir),
      balanceStroops: 0n,
      baseSeq: 5000n,
    });
    expect(store2.sequences.reuseOnDead(seq, 'o1')).toBe(seq); // recovery works after the restart
  });
});

describe('SqliteChannelMapStore + ChannelPoolProvider over orders.db', () => {
  it('the sticky order->channel assignment and each channel seq space survive a restart together', () => {
    const dir = tmp();
    const db1 = openOrderDb(dir);
    const pool1 = new ChannelPoolProvider(
      [
        { publicKey: CH_A, baseSeq: 1000n, store: new SqliteSequenceStore(db1, CH_A) },
        { publicKey: CH_B, baseSeq: 1000n, store: new SqliteSequenceStore(db1, CH_B) },
      ],
      new SqliteChannelMapStore(db1),
    );
    const seq = pool1.allocate('o1');
    const home = pool1.channelFor('o1');

    // CRASH. The next life must find the same channel AND the same seq bookkeeping.
    const db2 = openOrderDb(dir);
    const pool2 = new ChannelPoolProvider(
      [
        { publicKey: CH_A, baseSeq: 9000n, store: new SqliteSequenceStore(db2, CH_A) },
        { publicKey: CH_B, baseSeq: 9000n, store: new SqliteSequenceStore(db2, CH_B) },
      ],
      new SqliteChannelMapStore(db2),
    );
    expect(pool2.channelFor('o1')).toBe(home); // never re-dealt — the double-pay shield's precondition
    expect(pool2.reuseOnDead(seq, 'o1')).toBe(seq); // and its seq space picked up mid-flight
  });

  it('an empty map reads as null (first boot), a written map reads back verbatim', () => {
    const db = openOrderDb(tmp());
    const map = new SqliteChannelMapStore(db);
    expect(map.read()).toBeNull();
    map.write([
      ['o1', CH_A],
      ['o2', CH_B],
    ]);
    expect(map.read()).toEqual([
      ['o1', CH_A],
      ['o2', CH_B],
    ]);
    map.write([['o1', CH_A]]); // rewrite replaces whole (o2 released)
    expect(map.read()).toEqual([['o1', CH_A]]);
  });
});
