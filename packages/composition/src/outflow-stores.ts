// The two durable stores the payout tail needs, both over the same append-only log the rest of the system uses.
//
// The cursor is a last-wins value, which is a trivial fold over an append-only file: replay everything, keep the
// last record. Inventing an atomic-rename format for one 40-byte checkpoint would buy nothing and would add a
// second crash contract to reason about.
//
// The suspects store is an event log, not a table: `seen` opens a case, `alarmed` marks it paged, `cleared`
// closes it. Folding those in order rebuilds the open cases — with their ORIGINAL first-seen chain time, which is
// what stops a restart from restarting anyone's grace clock. It is durable for the one reason that matters: a
// suspect held only in memory is a theft that a restart forgets, and the cursor has already moved past it.

import type { CursorStore, Suspect, SuspectStore } from '@troia/backend';
import { FileAppendLog } from './file-append-log.js';

const CURSOR_FILE = 'outflow-cursor.log';
const SUSPECTS_FILE = 'outflow-suspects.log';
const RECORD_VERSION = 1;

export class OutflowCodecError extends Error {
  constructor(what: string) {
    super(`outflow record is not decodable: ${what}`);
    this.name = 'OutflowCodecError';
  }
}

// --- cursor -------------------------------------------------------------------------------------------------

export class FileCursorStore implements CursorStore {
  private readonly log: FileAppendLog;
  private current: string | null;
  readonly warnings: readonly string[];

  constructor(dataDir: string) {
    this.log = new FileAppendLog(dataDir, CURSOR_FILE);
    const replayed = this.log.replay();
    this.warnings =
      replayed.recovered === null
        ? []
        : [
            `${CURSOR_FILE}: dropped a torn tail — the checkpoint fell back one tick, which only re-reads a page`,
          ];
    const last = replayed.payloads.at(-1);
    this.current = last === undefined ? null : decodeCursor(last);
  }

  load(): string | null {
    return this.current;
  }

  /** Durable before it is believed. A checkpoint that only exists in memory would let a crash re-scan forever. */
  save(cursor: string): void {
    this.log.append(JSON.stringify({ v: RECORD_VERSION, cursor }));
    this.current = cursor;
  }
}

function decodeCursor(payload: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new OutflowCodecError('cursor is not JSON');
  }
  if (typeof raw !== 'object' || raw === null)
    throw new OutflowCodecError('cursor is not an object');
  const { v, cursor } = raw as Record<string, unknown>;
  if (v !== RECORD_VERSION) throw new OutflowCodecError(`unsupported cursor version ${String(v)}`);
  if (typeof cursor !== 'string' || cursor.length === 0) throw new OutflowCodecError('bad cursor');
  return cursor;
}

// --- suspects -----------------------------------------------------------------------------------------------

type SuspectRecord =
  | { readonly t: 'seen'; readonly s: Suspect }
  | { readonly t: 'alarmed'; readonly txHash: string }
  | { readonly t: 'cleared'; readonly txHash: string };

function encodeSuspect(r: SuspectRecord): string {
  if (r.t === 'seen') {
    return JSON.stringify({
      v: RECORD_VERSION,
      t: 'seen',
      txHash: r.s.txHash,
      firstSeenLedgerCloseUnix: r.s.firstSeenLedgerCloseUnix,
      ledger: r.s.ledger,
      amountStroops: String(r.s.amountStroops), // JSON.stringify throws on a bigint, and a number would round
      to: r.s.to,
    });
  }
  return JSON.stringify({ v: RECORD_VERSION, t: r.t, txHash: r.txHash });
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function decodeSuspect(payload: string): SuspectRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new OutflowCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new OutflowCodecError('not an object');
  const r = raw as Record<string, unknown>;
  if (r.v !== RECORD_VERSION) throw new OutflowCodecError(`unsupported version ${String(r.v)}`);
  if (typeof r.txHash !== 'string' || r.txHash.length === 0)
    throw new OutflowCodecError('bad txHash');
  if (r.t === 'alarmed' || r.t === 'cleared') return { t: r.t, txHash: r.txHash };
  if (r.t !== 'seen') throw new OutflowCodecError(`unknown record type ${String(r.t)}`);

  const { firstSeenLedgerCloseUnix, ledger, amountStroops, to } = r;
  if (!Number.isSafeInteger(firstSeenLedgerCloseUnix)) throw new OutflowCodecError('bad firstSeen');
  if (!Number.isSafeInteger(ledger)) throw new OutflowCodecError('bad ledger');
  if (typeof amountStroops !== 'string' || !DECIMAL.test(amountStroops)) {
    throw new OutflowCodecError('bad amount');
  }
  if (typeof to !== 'string' || to.length === 0) throw new OutflowCodecError('bad to');
  return {
    t: 'seen',
    s: {
      txHash: r.txHash,
      firstSeenLedgerCloseUnix: firstSeenLedgerCloseUnix as number,
      ledger: ledger as number,
      amountStroops: BigInt(amountStroops),
      to,
      alarmed: false,
    },
  };
}

export class FileSuspectStore implements SuspectStore {
  private readonly log: FileAppendLog;
  private readonly open = new Map<string, Suspect>();
  readonly warnings: readonly string[];

  constructor(dataDir: string) {
    this.log = new FileAppendLog(dataDir, SUSPECTS_FILE);
    const replayed = this.log.replay();
    this.warnings =
      replayed.recovered === null
        ? []
        : [
            `${SUSPECTS_FILE}: dropped a torn tail — an unfinished record means its page was never checkpointed, ` +
              `so the same outflow is re-examined on the next tick`,
          ];
    for (const payload of replayed.payloads) {
      const rec = decodeSuspect(payload);
      if (rec.t === 'seen') {
        if (!this.open.has(rec.s.txHash)) this.open.set(rec.s.txHash, rec.s);
      } else if (rec.t === 'alarmed') {
        const s = this.open.get(rec.txHash);
        if (s !== undefined) this.open.set(rec.txHash, { ...s, alarmed: true });
      } else {
        this.open.delete(rec.txHash);
      }
    }
  }

  all(): readonly Suspect[] {
    return Object.freeze([...this.open.values()]);
  }

  /** Durable BEFORE the cursor moves past this outflow's page. That ordering is the whole crash contract. */
  record(s: Suspect): void {
    if (this.open.has(s.txHash)) return; // at-least-once: a re-read page must not restart the grace clock
    this.log.append(encodeSuspect({ t: 'seen', s }));
    this.open.set(s.txHash, s);
  }

  markAlarmed(txHash: string): void {
    const s = this.open.get(txHash);
    if (s === undefined || s.alarmed) return;
    this.log.append(encodeSuspect({ t: 'alarmed', txHash }));
    this.open.set(txHash, { ...s, alarmed: true });
  }

  tombstone(txHash: string): void {
    if (!this.open.has(txHash)) return;
    this.log.append(encodeSuspect({ t: 'cleared', txHash }));
    this.open.delete(txHash);
  }
}
