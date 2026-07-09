import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Suspect } from '@troia/backend';
import { FileCursorStore, FileSuspectStore } from '../src/outflow-stores.js';

// The suspects store is durable for one reason, and it is the sharpest hole the design review found:
//
//   an unexplained outflow is opened as a suspect, the cursor moves past its page, and then the process dies.
//   If that suspect lived only in memory, it is gone — and the cursor will never fetch that ledger again. The
//   theft is silently forgotten, and the operator sees a cleanly advancing tail with no alarm.
//
// So a suspect is written to disk BEFORE the checkpoint advances, with the EVENT's own ledger close time. A
// restart rehydrates it with that original clock, so a catch-up cannot restart anyone's grace, and an escalation
// that already paged never pages again.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-tail-'));
}

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';

function suspect(txHash: string, firstSeen = 1000, amount = 12_800_000_000n): Suspect {
  return {
    txHash,
    firstSeenLedgerCloseUnix: firstSeen,
    ledger: 3_507_252,
    amountStroops: amount,
    to: MERCHANT,
    alarmed: false,
  };
}

describe('FileCursorStore — a checkpoint nobody can lose', () => {
  it('starts empty, then last-wins across a restart', () => {
    const dir = tmp();
    expect(new FileCursorStore(dir).load()).toBeNull();

    const s = new FileCursorStore(dir);
    s.save('0015063536933797887-4294967295');
    s.save('0015063536933797999-4294967295');
    expect(new FileCursorStore(dir).load()).toBe('0015063536933797999-4294967295');
  });

  it('a torn tail falls back one checkpoint, which only re-reads a page', () => {
    const dir = tmp();
    const s = new FileCursorStore(dir);
    s.save('C1');
    appendFileSync(join(dir, 'outflow-cursor.log'), 'L20,deadbeef|{"v":1,"curs');

    const revived = new FileCursorStore(dir);
    expect(revived.load()).toBe('C1');
    expect(revived.warnings).toHaveLength(1);
  });
});

describe('FileSuspectStore — a theft a restart cannot forget', () => {
  it('an open case survives a restart with its ORIGINAL chain-time clock', () => {
    const dir = tmp();
    new FileSuspectStore(dir).record(suspect(A, 1000));

    const revived = new FileSuspectStore(dir);
    expect(revived.all()).toEqual([suspect(A, 1000)]);
    expect(revived.all()[0]?.amountStroops).toBe(12_800_000_000n); // bigint exact, not a rounded number
  });

  it('an escalation survives too — a standing rogue never pages twice', () => {
    const dir = tmp();
    const s = new FileSuspectStore(dir);
    s.record(suspect(A));
    s.markAlarmed(A);

    expect(new FileSuspectStore(dir).all()[0]?.alarmed).toBe(true);
  });

  it('a cleared case is gone for good', () => {
    const dir = tmp();
    const s = new FileSuspectStore(dir);
    s.record(suspect(A));
    s.record(suspect(B));
    s.tombstone(A);

    expect(new FileSuspectStore(dir).all().map((x) => x.txHash)).toEqual([B]);
  });

  it('re-recording a case is a no-op — a re-read page must not restart its grace clock', () => {
    const dir = tmp();
    const s = new FileSuspectStore(dir);
    s.record(suspect(A, 1000));
    s.record(suspect(A, 9999)); // the same outflow, seen again after a crash before the checkpoint

    expect(s.all()[0]?.firstSeenLedgerCloseUnix).toBe(1000);
    expect(new FileSuspectStore(dir).all()[0]?.firstSeenLedgerCloseUnix).toBe(1000);
  });

  it('markAlarmed and tombstone on an unknown case write nothing', () => {
    const dir = tmp();
    const s = new FileSuspectStore(dir);
    s.markAlarmed(A);
    s.tombstone(A);
    expect(new FileSuspectStore(dir).all()).toEqual([]);
  });

  it('the full lifecycle folds correctly in file order', () => {
    const dir = tmp();
    const s = new FileSuspectStore(dir);
    s.record(suspect(A));
    s.markAlarmed(A);
    s.record(suspect(B));
    s.tombstone(A); // it turned out to be ours after all
    s.tombstone(B);
    s.record(suspect(A, 2000)); // and then a genuinely new outflow reused... nothing; a fresh case

    const revived = new FileSuspectStore(dir);
    expect(revived.all()).toEqual([suspect(A, 2000)]);
    expect(revived.all()[0]?.alarmed).toBe(false); // a new case starts un-paged
  });

  it('a corrupt record refuses to start — a store that guesses is a store that accuses', () => {
    const dir = tmp();
    new FileSuspectStore(dir).record(suspect(A));
    // a fully terminated record whose payload no longer verifies
    const path = join(dir, 'outflow-suspects.log');
    const buf = readFileSync(path);
    const at = buf.indexOf(Buffer.from('"seen"'));
    buf[at + 1] = 'x'.charCodeAt(0);
    writeFileSync(path, buf);

    expect(() => new FileSuspectStore(dir)).toThrow(/corrupt record/i);
  });
});
