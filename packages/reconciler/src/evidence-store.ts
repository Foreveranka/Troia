// 3.1 settlement_evidence — the append-only store written at submit time (docs/ARCHITECTURE §8 ④).
// It records the OPAQUE signed blob we submitted; it never computes signed_xdr from the business intent.
// Append-only, per-order idempotent (a second append for the same order is rejected, not overwritten),
// and every stored record is frozen so the witness cannot be mutated after the fact.

import type { LedgerEvidence } from './types.js';

export interface EvidenceRecord {
  readonly order_id: string; // canonical NFC
  readonly tx_hash: string; // hex Stellar tx hash (== Transaction.hash())
  readonly signed_xdr: string; // base64 envelope — stored verbatim, never recomputed
  readonly seq: string; // operator sequence used (decimal string)
  readonly ledger_hint: number; // ledger seq around submit time
  readonly ts: number; // wall-clock ms at submit (injected; store performs no I/O)
}

export type EvidenceErrorCode = 'DuplicateEvidence';

export class SettlementEvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = 'SettlementEvidenceError';
    this.code = code;
  }
}

export class SettlementEvidenceStore {
  private readonly byOrder = new Map<string, EvidenceRecord>();

  /** Append the frozen witness for an order. A second append for the same order_id fails closed. */
  append(record: EvidenceRecord): EvidenceRecord {
    if (this.byOrder.has(record.order_id)) {
      throw new SettlementEvidenceError(
        'DuplicateEvidence',
        `evidence already recorded for order ${record.order_id}`,
      );
    }
    const frozen = Object.freeze({ ...record });
    this.byOrder.set(record.order_id, frozen);
    return frozen;
  }

  get(orderId: string): EvidenceRecord | undefined {
    return this.byOrder.get(orderId);
  }

  /** Project the stored witness into the (b) ledger_evidence shape the reconciler consumes. */
  toLedgerEvidence(orderId: string): LedgerEvidence | undefined {
    const r = this.byOrder.get(orderId);
    return r ? { signed_xdr: r.signed_xdr, hash: r.tx_hash } : undefined;
  }

  all(): readonly EvidenceRecord[] {
    return [...this.byOrder.values()];
  }
}
