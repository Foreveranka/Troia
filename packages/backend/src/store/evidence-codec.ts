// The wire format of the durable evidence log: one JSON object per record, carrying its own version so a
// truncated file can never orphan a header. Pure — no `node:fs`, no clock. Decoding FAILS CLOSED: a record whose
// bytes are intact but whose shape or version is wrong means format drift or tampering, never something to skip.
//
// A row is more than a witness. It also carries the ORDER's frozen facts, because a restarted process has no
// other memory of them: the registry is in-memory and dies with the process. With them on disk, the settlement
// worker can rediscover a payout that confirmed just before a crash, book its outflow, and refill the pool —
// rather than leaving the ledger permanently short and the solvency alarm permanently, uselessly ringing.
//
// bigints go out as base-10 strings: JSON.stringify THROWS on a raw bigint, and a JSON number silently rounds
// past 2^53. A `Number()` hop is forbidden outright — it produces "1e+21", which BigInt() then refuses.

import type { EvidenceRow, OrderFacts } from '../ports.js';

const RECORD_VERSION = 2;
/** Canonical non-negative decimal: no sign, no exponent, no leading zeros, no whitespace. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export class EvidenceCodecError extends Error {
  constructor(what: string) {
    super(`evidence record is not decodable: ${what}`);
    this.name = 'EvidenceCodecError';
  }
}

/** Fixed key order, so a row's bytes are a pure function of its value. */
export function encodeEvidenceRow(row: EvidenceRow): string {
  return JSON.stringify({
    v: RECORD_VERSION,
    orderId: row.orderId,
    record: {
      txHash: row.record.txHash,
      signedXdr: row.record.signedXdr,
      seq: row.record.seq,
      witnessedAtUnix: row.record.witnessedAtUnix,
    },
    order: {
      destination: row.order.destination,
      amountStroops: String(row.order.amountStroops),
      memoHex: row.order.memoHex,
      appliedRateStroops: String(row.order.appliedRateStroops),
      paidPriceTry: row.order.paidPriceTry,
      spreadKurus: String(row.order.spreadKurus),
      feeKurus: String(row.order.feeKurus),
    },
  });
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new EvidenceCodecError(`bad ${field}`);
  return value;
}

function amount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new EvidenceCodecError(`non-canonical ${field}`);
  }
  return BigInt(value);
}

function decodeOrderFacts(raw: unknown): OrderFacts {
  if (typeof raw !== 'object' || raw === null) throw new EvidenceCodecError('bad order facts');
  const o = raw as Record<string, unknown>;
  return {
    destination: str(o.destination, 'destination'),
    amountStroops: amount(o.amountStroops, 'amountStroops'),
    memoHex: str(o.memoHex, 'memoHex'),
    appliedRateStroops: amount(o.appliedRateStroops, 'appliedRateStroops'),
    paidPriceTry: str(o.paidPriceTry, 'paidPriceTry'),
    spreadKurus: amount(o.spreadKurus, 'spreadKurus'),
    feeKurus: amount(o.feeKurus, 'feeKurus'),
  };
}

export function decodeEvidenceRow(payload: string): EvidenceRow {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new EvidenceCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new EvidenceCodecError('not an object');
  const { v, orderId, record, order } = raw as Record<string, unknown>;
  if (v !== RECORD_VERSION) throw new EvidenceCodecError(`unsupported version ${String(v)}`);
  if (typeof record !== 'object' || record === null) throw new EvidenceCodecError('bad record');
  const { txHash, signedXdr, seq, witnessedAtUnix } = record as Record<string, unknown>;
  if (!Number.isSafeInteger(witnessedAtUnix)) throw new EvidenceCodecError('bad witnessedAtUnix');
  return {
    orderId: str(orderId, 'orderId'),
    record: {
      txHash: str(txHash, 'txHash'),
      signedXdr: str(signedXdr, 'signedXdr'),
      seq: str(seq, 'seq'),
      witnessedAtUnix: witnessedAtUnix as number,
    },
    order: decodeOrderFacts(order),
  };
}

/** Replay-side dedupe. The evidence log is deliberately AT-LEAST-ONCE: a crash between the durable append and
 *  the in-memory push leaves the row on disk, and the recovery worker re-drives the same order and appends it
 *  again. That is a known, benign artifact — the consumers are a "was this tx hash authorized?" membership query
 *  and a per-order work-list — so replay must fold duplicates rather than fail closed the way the ledger does. */
export function dedupeEvidence(rows: readonly EvidenceRow[]): readonly EvidenceRow[] {
  const seen = new Set<string>();
  const out: EvidenceRow[] = [];
  for (const r of rows) {
    const key = `${r.orderId} ${r.record.txHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
