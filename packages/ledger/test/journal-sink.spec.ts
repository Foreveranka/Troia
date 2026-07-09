import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError, decodeJournalEntry, encodeJournalEntry } from '../src/index.js';
import type { JournalEntry, JournalSink } from '../src/index.js';

// The ledger's durability contract. The ledger itself stays pure — it never imports `node:fs`; a JournalSink is
// injected by the composition root. What is pinned here is the ORDERING (durable before in-memory), the codec
// (bigint legs survive exactly), and REPLAY (hydrate reconstructs the same seq and the same duplicate-ref set,
// so the drift baseline that detectDrift compares against the chain is the one that existed before the restart).

const STROOP = 10_000_000n;
const USER = 405_000n; // 4050.00 TRY in kurus
const SPREAD = 5_000n;

/** A sink that records what it was handed AND how many entries the ledger held at that instant. `lengthAtCall`
 *  is the assertion that matters: if the durable write really precedes the in-memory push, the ledger must still
 *  be one entry short when the sink runs — i.e. lengthAtCall[i] === seq of the entry being written. */
function spySink(): JournalSink & {
  calls: string[];
  lengthAtCall: number[];
  bind(l: Ledger): void;
} {
  const calls: string[] = [];
  const lengthAtCall: number[] = [];
  let bound: Ledger | null = null;
  return {
    calls,
    lengthAtCall,
    bind(l: Ledger): void {
      bound = l;
    },
    append(payload: string): void {
      calls.push(payload);
      lengthAtCall.push(bound === null ? -1 : bound.all().length);
    },
  };
}

const throwingSink: JournalSink = {
  append(): void {
    throw new Error('disk is on fire');
  },
};

function topUp(l: Ledger, ref: string): JournalEntry {
  return l.recordTopUp({ ref, usdcStroops: 100n * STROOP, valueKurus: USER });
}

describe('Ledger — JournalSink (durable-first, pure)', () => {
  it('a ledger with no sink books identically and never reaches for one', () => {
    const l = new Ledger();
    const e = topUp(l, 't1');
    expect(e.seq).toBe(0);
    expect(l.nativeBalance('USDC_POOL')).toBe(100n * STROOP);
    expect(l.all()).toHaveLength(1);
  });

  it('post() hands the sink the encoded entry BEFORE the entry is visible in memory', () => {
    const sink = spySink();
    const l = new Ledger(sink);
    sink.bind(l);
    topUp(l, 't1');
    topUp(l, 't2');
    expect(sink.calls).toHaveLength(2);
    // the ledger was still one entry short at each append -> the durable write ran first, both times
    expect(sink.lengthAtCall).toEqual([0, 1]);
    expect(l.all().map((e) => e.seq)).toEqual([0, 1]);
    // and what was handed over is exactly what landed in memory
    expect(sink.calls.map(decodeJournalEntry)).toEqual([...l.all()]);
  });

  it('a throwing sink books nothing: no entry, no ref consumed, and the seq is reusable', () => {
    const l = new Ledger(throwingSink);
    expect(() => topUp(l, 't1')).toThrow('disk is on fire');
    expect(l.all()).toHaveLength(0);
    expect(l.nativeBalance('USDC_POOL')).toBe(0n);
    // the ref was never registered, so the SAME ref is still postable once the disk recovers
    const healthy = new Ledger();
    expect(healthy.recordTopUp({ ref: 't1', usdcStroops: STROOP, valueKurus: 100n }).seq).toBe(0);
  });

  it('hydrate() never touches the sink — replay writes nothing back to disk', () => {
    const source = new Ledger();
    topUp(source, 't1');

    const sink = spySink();
    const replayed = new Ledger(sink);
    sink.bind(replayed);
    replayed.hydrate(source.all());
    expect(sink.calls).toEqual([]);
    expect(replayed.all()).toHaveLength(1);
  });
});

describe('Ledger — journal codec (bigint legs survive exactly)', () => {
  it('round-trips an entry whose native leg exceeds 2^53 stroops', () => {
    const huge = 9_007_199_254_740_993n * 1000n; // > Number.MAX_SAFE_INTEGER, and not representable as a double
    const l = new Ledger();
    const e = l.recordTopUp({ ref: 'big', usdcStroops: huge, valueKurus: 1n });
    const back = decodeJournalEntry(encodeJournalEntry(e));
    expect(back).toEqual(e);
    expect(back.debits[0]?.native).toBe(huge); // exact, no Number() hop
  });

  it('encodes bigints as decimal strings (JSON.stringify would throw on a raw bigint)', () => {
    const l = new Ledger();
    const payload = encodeJournalEntry(topUp(l, 't1'));
    const raw = JSON.parse(payload) as { v: number; debits: { native: unknown }[] };
    expect(raw.v).toBe(1);
    expect(raw.debits[0]?.native).toBe('1000000000');
  });

  it('decode rejects an unknown record version', () => {
    const l = new Ledger();
    const payload = encodeJournalEntry(topUp(l, 't1')).replace('"v":1', '"v":2');
    expect(() => decodeJournalEntry(payload)).toThrowError(
      expect.objectContaining({ code: 'CorruptJournal' }),
    );
  });

  it('decode rejects a non-canonical amount that BigInt() cannot parse', () => {
    const l = new Ledger();
    const payload = encodeJournalEntry(topUp(l, 't1')).replace('"1000000000"', '"1e+21"');
    expect(() => decodeJournalEntry(payload)).toThrowError(
      expect.objectContaining({ code: 'CorruptJournal' }),
    );
  });

  it('decode rejects a structurally wrong record', () => {
    expect(() => decodeJournalEntry('{"v":1}')).toThrowError(
      expect.objectContaining({ code: 'CorruptJournal' }),
    );
    expect(() => decodeJournalEntry('not json')).toThrowError(
      expect.objectContaining({ code: 'CorruptJournal' }),
    );
  });
});

describe('Ledger — hydrate (replay reconstructs the pre-restart state)', () => {
  /** Book a realistic history, then replay it into a fresh ledger the way a restart would. */
  function bookHistory(l: Ledger): void {
    l.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 4_050_000n });
    l.recordSettlement({
      orderId: 'o1',
      usdcStroops: 10n * STROOP,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    l.recordSettlement({
      orderId: 'o2',
      usdcStroops: 25n * STROOP,
      userTryKurus: USER,
      spreadKurus: SPREAD,
    });
    l.recordTopUp({ ref: 'topup:o1', usdcStroops: 10n * STROOP, valueKurus: USER });
  }

  it('rebuilds entries in file order with seq === index, and the next live post continues at N', () => {
    const before = new Ledger();
    bookHistory(before);
    const wire = before.all().map(encodeJournalEntry).map(decodeJournalEntry);

    const after = new Ledger();
    after.hydrate(wire);
    expect(after.all().map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(after.all()).toEqual(before.all());
    expect(after.recordTopUp({ ref: 'next', usdcStroops: STROOP, valueKurus: 100n }).seq).toBe(4);
  });

  it('reproduces the drift baseline exactly — the whole point of the step', () => {
    const before = new Ledger();
    bookHistory(before);
    const expected = before.nativeBalance('USDC_POOL');

    const after = new Ledger();
    after.hydrate(before.all().map(encodeJournalEntry).map(decodeJournalEntry));
    expect(after.nativeBalance('USDC_POOL')).toBe(expected);
    expect(after.detectDrift(expected)).toEqual(before.detectDrift(expected));
    expect(after.detectDrift(expected).inSync).toBe(true);
    // and a real shortfall is still seen after the restart
    expect(after.detectDrift(expected - STROOP).inSync).toBe(false);
  });

  it('re-registers refs, so a replayed ref still throws DuplicateRef after a restart', () => {
    const before = new Ledger();
    bookHistory(before);
    const after = new Ledger();
    after.hydrate(before.all());
    expect(() =>
      after.recordSettlement({
        orderId: 'o1',
        usdcStroops: STROOP,
        userTryKurus: USER,
        spreadKurus: SPREAD,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DuplicateRef' }));
    expect(() =>
      after.recordTopUp({ ref: 'topup:o1', usdcStroops: STROOP, valueKurus: 1n }),
    ).toThrowError(expect.objectContaining({ code: 'DuplicateRef' }));
  });

  it('fails closed on a seq gap or reorder — a synchronous single writer cannot produce one', () => {
    const l = new Ledger();
    bookHistory(l);
    const entries = l.all();

    const gapped = new Ledger();
    expect(() =>
      gapped.hydrate([entries[0] as JournalEntry, entries[2] as JournalEntry]),
    ).toThrowError(expect.objectContaining({ code: 'CorruptJournal' }));

    const reordered = new Ledger();
    expect(() =>
      reordered.hydrate([entries[1] as JournalEntry, entries[0] as JournalEntry]),
    ).toThrowError(expect.objectContaining({ code: 'CorruptJournal' }));
  });

  it('fails closed on a duplicate ref in the replayed set', () => {
    const l = new Ledger();
    topUp(l, 'dup');
    const e = l.all()[0] as JournalEntry;
    const twice = new Ledger();
    expect(() => twice.hydrate([e, { ...e, seq: 1 }])).toThrowError(
      expect.objectContaining({ code: 'DuplicateRef' }),
    );
  });

  it('fails closed on a record that violates the double-entry laws', () => {
    const l = new Ledger();
    topUp(l, 't1');
    const e = l.all()[0] as JournalEntry;
    const unbalanced: JournalEntry = {
      ...e,
      credits: [{ account: 'EXTERNAL_FUNDING', native: 1n, kurus: 1n }],
    };
    const fresh = new Ledger();
    expect(() => fresh.hydrate([unbalanced])).toThrowError(LedgerError);
  });
});
