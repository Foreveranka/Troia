import { describe, expect, it } from 'vitest';
import { buildAcceptanceReport } from './fixtures/build-corpus.js';
import { verifyReport } from '../src/verify.js';

describe('recon-report — buildReconReport (3.3)', () => {
  const report = buildAcceptanceReport();

  it('embeds all three artifacts per order and round-trips through JSON', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    for (const o of report.orders) {
      expect(o.business_intent.order_id).toBeTruthy();
      expect(o.ledger_evidence.signed_xdr.length).toBeGreaterThan(0);
      expect(o.chain_evidence?.tx_hash).toBe(o.ledger_evidence.hash);
    }
  });

  it('summary matches the verdict buckets: {total:3, matched:2, mismatch:1, unsettled:0}', () => {
    expect(report.summary).toEqual({ total: 3, matched: 2, mismatch: 1, unsettled: 0 });
  });

  it('ord-003 is CORRUPT_LOCAL with a valid signature and an amount diff', () => {
    const o = report.orders.find((x) => x.order_id === 'ord-003');
    expect(o?.verdict).toBe('CORRUPT_LOCAL');
    expect(o?.signature_valid).toBe(true);
    expect(o?.field_diff.map((d) => d.field)).toEqual(['amount']);
  });

  it('the built report verifies in-process (recomputation matches every stored field)', () => {
    const r = verifyReport(report);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.summary).toEqual({ total: 3, matched: 2, mismatch: 1, unsettled: 0 });
  });
});
