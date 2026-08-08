// Durable homes for the sequence machinery (A-5, and the missing piece of A-1's recovery):
//
//   SqliteSequenceStore  — a SequenceStore over orders.db, one row per SCOPE ('operator', or a channel
//                          G-address). Before this, the allocator state was in-memory even on the durable
//                          deployment, which left a post-restart hole: a recovered in-flight order calling
//                          reuseOnDead/confirmBurned hit an allocator that had forgotten its seq (UnknownSeq,
//                          forever). With the snapshot durable, recovery picks up mid-flight exactly where
//                          the crash left it.
//   SqliteChannelMapStore — the order -> channel assignment (A-5 stickiness). As money-critical as the seq
//                          snapshots: re-dealing an in-flight order onto another channel would step outside
//                          the per-account double-pay shield.
//
// The snapshot codec is bigint-as-decimal-string, same discipline as every other codec here; decoding fails
// closed on shape drift.

import type { ChannelMapStore, SequenceSnapshot, SequenceStore, SeqRecord } from '@troia/core';
import type { OrderDb } from './order-db.js';

const SNAPSHOT_VERSION = 1;

export class SeqSnapshotCodecError extends Error {
  constructor(what: string) {
    super(`sequence snapshot is not decodable: ${what}`);
    this.name = 'SeqSnapshotCodecError';
  }
}

export function encodeSequenceSnapshot(s: SequenceSnapshot): string {
  return JSON.stringify({
    v: SNAPSHOT_VERSION,
    baseSeq: s.baseSeq.toString(),
    nextSeq: s.nextSeq.toString(),
    freeList: s.freeList.map((n) => n.toString()),
    records: s.records.map((r) => ({
      seq: r.seq.toString(),
      orderId: r.orderId,
      status: r.status,
    })),
    byOrder: s.byOrder.map(([orderId, seq]) => [orderId, seq.toString()]),
  });
}

function big(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) {
    throw new SeqSnapshotCodecError(`non-canonical ${field}`);
  }
  return BigInt(v);
}

export function decodeSequenceSnapshot(payload: string): SequenceSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new SeqSnapshotCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new SeqSnapshotCodecError('not an object');
  const o = raw as Record<string, unknown>;
  if (o.v !== SNAPSHOT_VERSION)
    throw new SeqSnapshotCodecError(`unsupported version ${String(o.v)}`);
  if (!Array.isArray(o.freeList) || !Array.isArray(o.records) || !Array.isArray(o.byOrder)) {
    throw new SeqSnapshotCodecError('bad shape');
  }
  const records: SeqRecord[] = o.records.map((r: unknown) => {
    const rec = r as Record<string, unknown>;
    if (typeof rec.orderId !== 'string' || (rec.status !== 'active' && rec.status !== 'burned')) {
      throw new SeqSnapshotCodecError('bad record');
    }
    return { seq: big(rec.seq, 'record.seq'), orderId: rec.orderId, status: rec.status };
  });
  return {
    baseSeq: big(o.baseSeq, 'baseSeq'),
    nextSeq: big(o.nextSeq, 'nextSeq'),
    freeList: o.freeList.map((n: unknown) => big(n, 'freeList[]')),
    records,
    byOrder: o.byOrder.map((e: unknown) => {
      const [orderId, seq] = e as [unknown, unknown];
      if (typeof orderId !== 'string') throw new SeqSnapshotCodecError('bad byOrder key');
      return [orderId, big(seq, 'byOrder[]')] as const;
    }),
  };
}

export class SqliteSequenceStore implements SequenceStore {
  constructor(
    private readonly db: OrderDb,
    /** 'operator' for the single-operator allocator; a channel G-address per channel allocator. */
    private readonly scope: string,
  ) {}

  read(): SequenceSnapshot | null {
    const row = this.db.get('SELECT snapshot_json FROM seq_snapshots WHERE scope = ?', this.scope);
    return row === undefined ? null : decodeSequenceSnapshot(row.snapshot_json as string);
  }

  write(snapshot: SequenceSnapshot): void {
    this.db.run(
      `INSERT INTO seq_snapshots (scope, snapshot_json) VALUES (?, ?)
       ON CONFLICT (scope) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      this.scope,
      encodeSequenceSnapshot(snapshot),
    );
  }
}

export class SqliteChannelMapStore implements ChannelMapStore {
  constructor(private readonly db: OrderDb) {}

  read(): readonly (readonly [string, string])[] | null {
    const rows = this.db.all('SELECT order_id, channel FROM channel_map');
    return rows.length === 0 ? null : rows.map((r) => [r.order_id as string, r.channel as string]);
  }

  write(entries: readonly (readonly [string, string])[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM channel_map');
      for (const [orderId, channel] of entries) {
        this.db.run('INSERT INTO channel_map (order_id, channel) VALUES (?, ?)', orderId, channel);
      }
    });
  }
}
