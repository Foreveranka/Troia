import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, Networks, StrKey } from '@stellar/stellar-base';
import { buildSignedPay, bytes32, operatorKeypair } from './fixtures/generate.js';
import { decodeSignedPay } from '../src/decode.js';

// Networks.TESTNET is the imported constant, not a source literal (no-network-literal stays green).
const PASSPHRASE = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(createHash('sha256').update('troypool-contract').digest());
const MERCHANT = Keypair.fromRawEd25519Seed(bytes32('merchant')).publicKey();

function build() {
  return buildSignedPay({
    seed: 'demo|1',
    troyPoolContractId: CONTRACT,
    txId32: bytes32('tx|1'),
    amountStroops: 10_000_000n,
    appliedRate: 411_075_000n,
    merchant: MERCHANT,
    memo32: bytes32('memo|1'),
    seq: '100',
    passphrase: PASSPHRASE,
  });
}

describe('reconciler — stellar-base build/sign/hash/decode roundtrip (foundation)', () => {
  it('decodes pay() args, recomputes the tx hash, and the operator signature verifies over tx.hash()', () => {
    const built = build();
    const dec = decodeSignedPay(built.signed_xdr, PASSPHRASE);

    // hash recomputed from the blob matches the recorded hash
    expect(dec.recomputedHash).toBe(built.hash);

    // the doc shorthand is WRONG: sha256(envelope bytes) is NOT the tx hash
    const blobSha = createHash('sha256').update(Buffer.from(built.signed_xdr, 'base64')).digest('hex');
    expect(blobSha).not.toBe(built.hash);

    // pay() args decode cleanly and with the expected native types
    expect(dec.projection.function).toBe('pay');
    expect(dec.projection.contract_id).toBe(CONTRACT);
    expect(dec.projection.merchant).toBe(MERCHANT);
    expect(dec.projection.amount_stroops).toBe('10000000');
    expect(dec.projection.applied_rate_stroops).toBe('411075000');
    expect(dec.projection.tx_id_hex).toBe(bytes32('tx|1').toString('hex'));
    expect(dec.projection.memo_hex).toBe(bytes32('memo|1').toString('hex'));
  });

  it('the signature verifies over tx.hash() by the pinned operator key, selected by hint', () => {
    const built = build();
    const dec = decodeSignedPay(built.signed_xdr, PASSPHRASE);
    const op = operatorKeypair('demo|1');
    expect(built.operatorPublic).toBe(op.publicKey());
    expect(dec.tx.source).toBe(op.publicKey());

    const opRaw = StrKey.decodeEd25519PublicKey(op.publicKey());
    const wantHint = Buffer.from(opRaw).subarray(28, 32).toString('hex');
    const kp = Keypair.fromPublicKey(op.publicKey());
    const ok = dec.tx.signatures.some(
      (s) => s.hint().toString('hex') === wantHint && kp.verify(dec.tx.hash(), s.signature()),
    );
    expect(ok).toBe(true);
  });

  it('the build is byte-reproducible (deterministic key + fixed fee/seq + TimeoutInfinite)', () => {
    expect(build().signed_xdr).toBe(build().signed_xdr);
  });

  it('a non-pay / malformed envelope is rejected as EvidenceError', () => {
    expect(() => decodeSignedPay('not-base64-xdr!!', PASSPHRASE)).toThrowError(/parse/);
  });
});
