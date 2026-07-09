// The durable write-ahead journal, and the reason the rogue-payout alarm can be trusted.
//
// `StellarClient.submitPay` awaits `persistPreSubmit(...)` and only then calls `send(...)`. That ordering already
// existed — for crash recovery, so a resend replays byte-identical bytes rather than rebuilding a transaction on a
// live sequence. Making the write DURABLE gives it a second, sharper property:
//
//     a pay() transaction cannot land on chain unless its hash reached stable storage first.
//
// From which: an outflow from the pool whose transaction hash is absent from this journal was never authorized by
// us. Not "not yet witnessed", not "still settling" — never authorized. That is what lets the detector accuse
// without a grace period and without an in-memory allowlist that a restart would erase.
//
// Two indexes over the same append-only log:
//   byOrder — the LATEST envelope per order, which is what a recovery resend must replay.
//   hashes  — EVERY hash ever submitted, because a same-sequence replacement mints a new hash and either it or
//             its predecessor may be the one that lands. Dropping the superseded hash would accuse ourselves.

import type { WriteAheadJournal } from '@troia/stellar-client';
import { FileAppendLog } from './file-append-log.js';

const RECORD_VERSION = 1;
const JOURNAL_FILE = 'authorized.log';

export class AuthorizedJournalCodecError extends Error {
  constructor(what: string) {
    super(`authorized-journal record is not decodable: ${what}`);
    this.name = 'AuthorizedJournalCodecError';
  }
}

export interface AuthorizedRecord {
  readonly orderId: string;
  readonly seq: string;
  readonly hashHex: string;
  readonly signedXdr: string;
}

export function encodeAuthorizedRecord(r: AuthorizedRecord): string {
  return JSON.stringify({
    v: RECORD_VERSION,
    orderId: r.orderId,
    seq: r.seq,
    hashHex: r.hashHex,
    signedXdr: r.signedXdr,
  });
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new AuthorizedJournalCodecError(`bad ${field}`);
  return v;
}

/** Fail-CLOSED. A record whose bytes are intact but whose shape is wrong means format drift or tampering — and
 *  this journal decides who gets accused of theft, so it is the last place to guess. */
export function decodeAuthorizedRecord(payload: string): AuthorizedRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new AuthorizedJournalCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null)
    throw new AuthorizedJournalCodecError('not an object');
  const { v, orderId, seq, hashHex, signedXdr } = raw as Record<string, unknown>;
  if (v !== RECORD_VERSION)
    throw new AuthorizedJournalCodecError(`unsupported version ${String(v)}`);
  return {
    orderId: str(orderId, 'orderId'),
    seq: str(seq, 'seq'),
    hashHex: str(hashHex, 'hashHex'),
    signedXdr: str(signedXdr, 'signedXdr'),
  };
}

export class FileWriteAheadJournal implements WriteAheadJournal {
  private readonly log: FileAppendLog;
  private readonly byOrder = new Map<string, { hashHex: string; signedXdr: string }>();
  private readonly hashes = new Set<string>();
  /** A torn tail that was healed. Surfaced by the caller — a silent data loss is not a recovery. */
  readonly warnings: readonly string[];

  constructor(dataDir: string) {
    this.log = new FileAppendLog(dataDir, JOURNAL_FILE);
    const replayed = this.log.replay();
    this.warnings =
      replayed.recovered === null
        ? []
        : [
            `${JOURNAL_FILE}: dropped a torn tail of ${replayed.recovered.droppedBytes} bytes at offset ` +
              `${replayed.recovered.atOffset} — a pay() was mid-write when the process died, so it was never sent`,
          ];
    for (const payload of replayed.payloads) {
      const rec = decodeAuthorizedRecord(payload);
      this.byOrder.set(rec.orderId, { hashHex: rec.hashHex, signedXdr: rec.signedXdr });
      this.hashes.add(rec.hashHex);
    }
  }

  /** Durable BEFORE the caller may broadcast. A throw means the transaction is never sent, so the hash we did not
   *  record is a hash that cannot appear on chain. Book-or-neither, in the strongest sense the system has. */
  async persistPreSubmit(
    orderId: string,
    seq: string,
    hashHex: string,
    signedXdrBase64: string,
  ): Promise<void> {
    this.log.append(encodeAuthorizedRecord({ orderId, seq, hashHex, signedXdr: signedXdrBase64 }));
    this.byOrder.set(orderId, { hashHex, signedXdr: signedXdrBase64 });
    this.hashes.add(hashHex);
  }

  async loadPersisted(orderId: string): Promise<{ hashHex: string; signedXdr: string } | null> {
    return this.byOrder.get(orderId) ?? null;
  }

  /** Every pay() hash this operator ever put on the wire. The detector's whole notion of "authorized". */
  authorizedTxHashes(): ReadonlySet<string> {
    return this.hashes;
  }
}
