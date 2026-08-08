// CHANNEL MODE (A-5): the reconciler's P2 predicate must recognize a channel-sourced settlement as an
// authentic OPERATOR act — the operator's signature lives in the address-credential auth entry (over the
// SorobanAuthorization preimage), not on the envelope. Found live: the first two channel payouts on testnet
// (2026-08-08) flagged EVIDENCE_TAMPERED because P2 only knew the envelope shape. Pinned here both ways:
// a genuine channel witness passes, a forged one (auth entry signed by anyone but the operator) still fails.

import { describe, expect, it } from 'vitest';
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-base';
import { signatureValid } from '../src/verify-crypto.js';
import { assembleWithSignedAuth, buildPayTransaction } from '../../stellar-client/src/index.js';
import { LocalKeySigner } from '../../stellar-client/src/signer.js';
import {
  addressAuthXdr,
  fakeSimResult,
} from '../../stellar-client/test/fixtures/fake-sim-result.js';
import {
  buildParams,
  bytes32,
  MERCHANT,
  OPERATOR_PUBLIC,
  OPERATOR_SECRET,
  TROY_POOL,
} from '../../stellar-client/test/fixtures/vectors.js';

const channelKp = Keypair.fromRawEd25519Seed(bytes32('recon|channel-1'));

/** A channel-mode signed envelope, exactly as client.submitPay produces it. `authSigner` lets a test forge
 *  the auth entry with the wrong key. */
async function channelWitness(authSigner: LocalKeySigner): Promise<Transaction> {
  const unprepared = buildPayTransaction({
    ...buildParams,
    sourcePublic: channelKp.publicKey(),
    seq: '500',
  });
  const sim = {
    ...fakeSimResult(TROY_POOL, MERCHANT),
    authXdr: [addressAuthXdr(TROY_POOL, OPERATOR_PUBLIC)],
  };
  const signed = await Promise.all(
    sim.authXdr.map((b64) => authSigner.signAuthEntry(b64, 2_000, buildParams.passphrase)),
  );
  const submittable = assembleWithSignedAuth(unprepared, sim, signed, OPERATOR_PUBLIC);
  const envelope = new LocalKeySigner(channelKp.secret()).sign(submittable);
  return TransactionBuilder.fromXDR(envelope, buildParams.passphrase) as Transaction;
}

describe('signatureValid — channel-mode witnesses (P2)', () => {
  it('accepts a channel-sourced tx whose auth entry the OPERATOR really signed', async () => {
    const tx = await channelWitness(new LocalKeySigner(OPERATOR_SECRET));
    expect(signatureValid(tx, OPERATOR_PUBLIC)).toBe(true);
  });

  it('REJECTS a forged witness: the auth entry signed by a non-operator key', async () => {
    // the channel signs its own "operator" entry — the address says operator, the signature does not
    const tx = await channelWitness(new LocalKeySigner(channelKp.secret()));
    expect(signatureValid(tx, OPERATOR_PUBLIC)).toBe(false);
  });

  it('still rejects a channel tx with NO operator entry at all (nothing to anchor on)', async () => {
    const unprepared = buildPayTransaction({
      ...buildParams,
      sourcePublic: channelKp.publicKey(),
      seq: '500',
    });
    const envelope = new LocalKeySigner(channelKp.secret()).sign(unprepared);
    const tx = TransactionBuilder.fromXDR(envelope, buildParams.passphrase) as Transaction;
    expect(signatureValid(tx, OPERATOR_PUBLIC)).toBe(false);
  });
});
