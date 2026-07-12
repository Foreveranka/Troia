import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyReport, decodeSignedPay, signatureValid, type ReconReport } from '../src/index.js';

// A recon-report generated from a REAL testnet pay() transaction (see docs/DEPLOYMENTS.md — the operator-signed
// payout tx 5a3d60cc…). This locks in that the reconciler verifies GENUINE on-chain settlement data offline, not
// just a hand-authored fixture. The report is self-verifying and reset-proof (all evidence is embedded), so this
// test keeps passing even after a testnet reset wipes the chain — exactly the `signed ≠ settled` guarantee.
const REAL_TX_HASH = '5a3d60cc25fc82025560d1c13b74f63b619393e194ada43cc6b8317637d64f13';
const OPERATOR = 'GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S';
const TROY_POOL = 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ';

const report = JSON.parse(
  readFileSync(new URL('./fixtures/recon-report.live.json', import.meta.url), 'utf8'),
) as ReconReport;

describe('reconciler — verifies a REAL on-chain pay() offline (live testnet smoke)', () => {
  it('the whole report re-derives clean: 1 order, MATCHED, no failures', () => {
    const r = verifyReport(report, OPERATOR, TROY_POOL);
    expect(r.ok).toBe(true);
    expect(r.ordersVerified).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.summary).toEqual({ total: 1, matched: 1, mismatch: 0, unsettled: 0 });
  });

  it('the real payout settled through the CANONICAL TroyPool — the deployment record, not the report', () => {
    // The one anchor a signature cannot supply: WHERE the money went. Pinned to the committed deployment record,
    // so a pay() to any other contract could not have produced this report (see verify.spec's look-alike forgery).
    const o = report.orders[0]!;
    const decoded = decodeSignedPay(o.ledger_evidence.signed_xdr, report.network.passphrase);
    expect(decoded.projection.contract_id).toBe(TROY_POOL);
    expect(o.chain_evidence?.horizon_snapshot.contract_id).toBe(TROY_POOL);
  });

  it('the order is MATCHED with a valid operator signature and a chain-bound hash', () => {
    const o = report.orders[0]!;
    expect(o.verdict).toBe('MATCHED');
    expect(o.status).toBe('matched');
    expect(o.signature_valid).toBe(true);
    expect(o.hash_consistent).toBe(true);
    expect(o.chain_bound).toBe(true);
  });

  it('the evidence is a REAL testnet tx: the recomputed hash equals the on-chain tx hash', () => {
    const o = report.orders[0]!;
    const decoded = decodeSignedPay(o.ledger_evidence.signed_xdr, report.network.passphrase);
    // recomputed purely from the embedded signed XDR — matches the real Stellar tx hash and the stored hash.
    expect(decoded.recomputedHash).toBe(REAL_TX_HASH);
    expect(o.ledger_evidence.hash).toBe(REAL_TX_HASH);
    // the pinned operator's signature verifies over the tx hash (unforgeable without the operator key).
    expect(signatureValid(decoded.tx, OPERATOR)).toBe(true);
    // the decoded pay() args match the business intent — a real settlement of the real order.
    expect(decoded.projection.merchant).toBe(o.business_intent.destination);
    expect(decoded.projection.amount_stroops).toBe(o.business_intent.amount_stroops);
    expect(decoded.projection.memo_hex).toBe(o.business_intent.memo_hex);
  });
});
