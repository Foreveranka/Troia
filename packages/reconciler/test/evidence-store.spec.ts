import { describe, expect, it } from 'vitest';
import { SettlementEvidenceStore, SettlementEvidenceError } from '../src/evidence-store.js';
import type { EvidenceRecord } from '../src/evidence-store.js';

function rec(order_id: string): EvidenceRecord {
  return {
    order_id,
    tx_hash: 'aa'.repeat(32),
    signed_xdr: 'AAAAopaqueblob==',
    seq: '100',
    ledger_hint: 1000,
    ts: 1_700_000_000_000,
  };
}

describe('settlement_evidence — append-only frozen witness (3.1)', () => {
  it('append then get returns the byte-identical signed_xdr and is frozen', () => {
    const s = new SettlementEvidenceStore();
    const stored = s.append(rec('ord-1'));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(s.get('ord-1')?.signed_xdr).toBe('AAAAopaqueblob==');
    expect(s.toLedgerEvidence('ord-1')).toEqual({
      signed_xdr: 'AAAAopaqueblob==',
      hash: 'aa'.repeat(32),
    });
  });

  it('a duplicate order_id is rejected (append-only, no overwrite)', () => {
    const s = new SettlementEvidenceStore();
    s.append(rec('dup'));
    try {
      s.append(rec('dup'));
      expect.unreachable('duplicate append should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SettlementEvidenceError);
      expect((e as SettlementEvidenceError).code).toBe('DuplicateEvidence');
    }
  });

  it('get returns undefined for an unknown order', () => {
    expect(new SettlementEvidenceStore().get('nope')).toBeUndefined();
  });
});
