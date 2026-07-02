import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, Networks, StrKey } from '@stellar/stellar-base';
import { buildSignedPay, bytes32 } from './fixtures/generate.js';
import { decodeSignedPay } from '../src/decode.js';
import { resolveGroundTruth } from '../src/resolve-ground-truth.js';
import type { BusinessIntent, ChainEvidence, LedgerEvidence } from '../src/types.js';

const PASSPHRASE = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(createHash('sha256').update('troypool-contract').digest());
const MERCHANT = Keypair.fromRawEd25519Seed(bytes32('merchant')).publicKey();
const WRONG_OP = Keypair.fromRawEd25519Seed(bytes32('some-other-key')).publicKey();

/** Build a fully-consistent (chain-matching) fixture, then corruptions are applied to the DB row only. */
function matchedFixture(label: string, amount = 10_000_000n, merchant = MERCHANT) {
  const txId = bytes32(`tx|${label}`);
  const memo = bytes32(`memo|${label}`);
  const built = buildSignedPay({
    seed: `demo|${label}`,
    troyPoolContractId: CONTRACT,
    txId32: txId,
    amountStroops: amount,
    appliedRate: 411_075_000n,
    merchant,
    memo32: memo,
    seq: '100',
    passphrase: PASSPHRASE,
  });
  const dec = decodeSignedPay(built.signed_xdr, PASSPHRASE);
  const ledger: LedgerEvidence = { signed_xdr: built.signed_xdr, hash: built.hash };
  const chain: ChainEvidence = {
    tx_hash: built.hash,
    fetched_at_ledger: 1000,
    horizon_snapshot: dec.projection,
  };
  const intent: BusinessIntent = {
    order_id: `ord-${label}`,
    destination: merchant,
    amount_stroops: amount.toString(),
    memo_hex: memo.toString('hex'),
  };
  return { built, ledger, chain, intent, operatorPublic: built.operatorPublic };
}

describe('resolveGroundTruth — the 5-case truth table', () => {
  it('MATCHED — intact intent equals the crypto-anchored chain', () => {
    const f = matchedFixture('m');
    const r = resolveGroundTruth(f.intent, f.ledger, f.chain, f.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('MATCHED');
    expect(r.status).toBe('matched');
    expect(r.signature_valid).toBe(true);
    expect(r.field_diff).toEqual([]);
  });

  it('CORRUPT_LOCAL — only the local amount is corrupted; signed XDR + chain intact', () => {
    const f = matchedFixture('c');
    const corrupted: BusinessIntent = { ...f.intent, amount_stroops: '99999999' };
    const r = resolveGroundTruth(corrupted, f.ledger, f.chain, f.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('CORRUPT_LOCAL');
    expect(r.status).toBe('mismatch');
    // the ord-003 guarantee: reachable ONLY through a valid signature + consistent hash + bound chain
    expect(r.signature_valid).toBe(true);
    expect(r.hash_consistent).toBe(true);
    expect(r.chain_bound).toBe(true);
    expect(r.field_diff.map((d) => d.field)).toEqual(['amount']);
    // (b) was NOT recomputed from (a): the signed blob is untouched by the corruption
    expect(f.ledger.signed_xdr).toBe(f.built.signed_xdr);
  });

  it('EVIDENCE_TAMPERED — signature does not match the pinned operator', () => {
    const f = matchedFixture('t1');
    const r = resolveGroundTruth(f.intent, f.ledger, f.chain, WRONG_OP, PASSPHRASE);
    expect(r.verdict).toBe('EVIDENCE_TAMPERED');
    expect(r.signature_valid).toBe(false);
  });

  it('EVIDENCE_TAMPERED — recorded hash does not match the frozen blob', () => {
    const f = matchedFixture('t2');
    const badLedger: LedgerEvidence = { ...f.ledger, hash: 'ff'.repeat(32) };
    const r = resolveGroundTruth(f.intent, badLedger, f.chain, f.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('EVIDENCE_TAMPERED');
    expect(r.signature_valid).toBe(true); // sig still valid; the HASH is what's inconsistent
    expect(r.hash_consistent).toBe(false);
  });

  it('CHAIN_DIVERGENCE — a different tx settled (our hash != chain tx_hash)', () => {
    const a = matchedFixture('A', 10_000_000n);
    const b = matchedFixture('B', 20_000_000n);
    // ledger from A, chain from B → hashes cannot bind
    const r = resolveGroundTruth(a.intent, a.ledger, b.chain, a.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('CHAIN_DIVERGENCE');
    expect(r.signature_valid).toBe(true);
    expect(r.hash_consistent).toBe(true);
    expect(r.chain_bound).toBe(false);
  });

  it('CORRUPT_LOCAL — a blanked local amount on a ZERO-amount settlement is not conflated with 0', () => {
    // Regression for the confirmed adversarial finding: BigInt('') === 0n. A real local corruption
    // (amount_stroops blanked) on a legitimately zero-amount settled order must surface, not read MATCHED.
    const f = matchedFixture('z', 0n);
    const corrupted: BusinessIntent = { ...f.intent, amount_stroops: '' };
    const r = resolveGroundTruth(corrupted, f.ledger, f.chain, f.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('CORRUPT_LOCAL');
    expect(r.signature_valid).toBe(true);
    expect(r.field_diff.map((d) => d.field)).toEqual(['amount']);
  });

  it('UNSETTLED — signed proven, but no chain evidence (never landed / testnet reset)', () => {
    const f = matchedFixture('u');
    const r = resolveGroundTruth(f.intent, f.ledger, null, f.operatorPublic, PASSPHRASE);
    expect(r.verdict).toBe('UNSETTLED');
    expect(r.status).toBe('unsettled');
    expect(r.signature_valid).toBe(true);
    expect(r.hash_consistent).toBe(true);
  });
});
