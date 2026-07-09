import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import { decodeEvidenceRow, encodeEvidenceRow } from '../../src/store/evidence-codec.js';
import type { DurableLog, EvidenceRecord, EvidenceRow, OrderFacts } from '../../src/ports.js';

const FACTS: OrderFacts = {
  destination: 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000',
  amountStroops: 1_000_000_000n,
  memoHex: 'ab'.repeat(32),
  appliedRateStroops: 340_000_000n,
  paidPriceTry: '3400.00',
  spreadKurus: 5_000n,
  feeKurus: 2_000n,
};

// The evidence log is the durable answer to "which USDC payouts did I authorize?" — the local half of the
// rogue-payout check that a later step performs against the chain. It hangs off `handToReconciler`, an effect
// the plan marks `mutates: false`, so nothing here may touch the money path: no lock is taken, no await is
// introduced, and reserve()/the sequence allocator are not reachable from any of it.

const UNIT = 10_000_000n;
const REC: EvidenceRecord = {
  txHash: 'a'.repeat(64),
  signedXdr: 'AAAAAg==',
  seq: '1001',
  witnessedAtUnix: 1_700_000_000,
};

function fakeLog(): DurableLog & { lines: string[] } {
  const lines: string[] = [];
  return { lines, append: (p) => void lines.push(p) };
}

const throwingLog: DurableLog = {
  append(): void {
    throw new Error('ENOSPC');
  },
};

const base = { balanceStroops: 100n * UNIT, baseSeq: 1000n };

describe('evidence codec', () => {
  it('round-trips a row (no bigint on the wire — EvidenceRecord.seq is already a string)', () => {
    const row: EvidenceRow = { orderId: 'o1', record: REC, order: FACTS };
    expect(decodeEvidenceRow(encodeEvidenceRow(row))).toEqual(row);
    expect((JSON.parse(encodeEvidenceRow(row)) as { v: number }).v).toBe(2);
  });

  it('fails closed on an unknown version and on a wrong shape', () => {
    const good = encodeEvidenceRow({ orderId: 'o1', record: REC, order: FACTS });
    expect(() => decodeEvidenceRow(good.replace('"v":2', '"v":9'))).toThrow();
    expect(() => decodeEvidenceRow('{"v":2,"orderId":"o1"}')).toThrow();
    expect(() => decodeEvidenceRow('nope')).toThrow();
  });
});

describe('InMemoryStore — durable evidence log', () => {
  it('appendEvidence writes to the log BEFORE the row is visible in memory', async () => {
    const seenAtAppend: number[] = [];
    const store: InMemoryStore = new InMemoryStore({
      ...base,
      evidenceLog: {
        append: (): void => void seenAtAppend.push(store.evidenceRecords().length),
      },
    });
    await store.appendEvidence('o1', REC, FACTS);
    await store.appendEvidence('o2', REC, FACTS);
    // the store was still one row short at each append -> the durable write ran first, both times
    expect(seenAtAppend).toEqual([0, 1]);
    expect(store.evidenceRecords()).toHaveLength(2);
  });

  it('a throwing log books nothing — the row never reaches memory', async () => {
    const s = new InMemoryStore({ ...base, evidenceLog: throwingLog });
    await expect(s.appendEvidence('o1', REC, FACTS)).rejects.toThrow('ENOSPC');
    expect(s.evidenceRecords()).toEqual([]);
  });

  it('appendEvidence hands the log exactly what decodes back to the row', async () => {
    const log = fakeLog();
    const s = new InMemoryStore({ ...base, evidenceLog: log });
    await s.appendEvidence('o1', REC, FACTS);
    expect(log.lines.map(decodeEvidenceRow)).toEqual([
      { orderId: 'o1', record: REC, order: FACTS },
    ]);
  });

  it('without a log it behaves exactly as before — the offline store stays pure', async () => {
    const s = new InMemoryStore(base);
    await s.appendEvidence('o1', REC, FACTS);
    expect(s.evidenceRecords()).toEqual([{ orderId: 'o1', record: REC, order: FACTS }]);
  });

  it('seeded rows are restored without being re-appended to the log', async () => {
    const log = fakeLog();
    const seed: readonly EvidenceRow[] = [{ orderId: 'o1', record: REC, order: FACTS }];
    const s = new InMemoryStore({ ...base, evidenceLog: log, seedEvidence: seed });
    expect(s.evidenceRecords()).toEqual(seed);
    expect(log.lines).toEqual([]); // replay writes nothing back
    await s.appendEvidence('o2', REC, FACTS);
    expect(log.lines).toHaveLength(1); // only the new row
    expect(s.evidenceRecords()).toHaveLength(2);
  });

  it('evidenceRecords() hands out a frozen copy — the append-only log cannot be spliced from outside', async () => {
    const s = new InMemoryStore(base);
    await s.appendEvidence('o1', REC, FACTS);
    const rows = s.evidenceRecords();
    expect(Object.isFrozen(rows)).toBe(true);
    expect(() =>
      (rows as EvidenceRow[]).push({ orderId: 'x', record: REC, order: FACTS }),
    ).toThrow();
    expect(s.evidenceRecords()).toHaveLength(1);
    expect(s.evidenceRecords()).not.toBe(rows); // a fresh copy each call
  });

  it('the durable log does not touch solvency: reserve, pool balance and sequences are unchanged', async () => {
    const s = new InMemoryStore({
      ...base,
      evidenceLog: fakeLog(),
      seedEvidence: [{ orderId: 'o1', record: REC, order: FACTS }],
    });
    expect(s.availableStroops()).toBe(100n * UNIT); // the pool base is NOT seeded from evidence
    expect((await s.reserve('o1', 40n * UNIT, 60_000, 0)).kind).toBe('reserved');
    expect(s.availableStroops()).toBe(60n * UNIT);
    expect(s.sequences.allocate('o1')).toBe(1001n); // baseSeq + 1, untouched by replay
  });
});
