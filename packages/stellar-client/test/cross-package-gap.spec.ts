import { describe, expect, it } from 'vitest';
import { assembleFromSimulation } from '../src/assemble.js';
import { buildPayTransaction } from '../src/build.js';
import { LocalKeySigner } from '../src/signer.js';
import { decodeSignedPay } from '../../reconciler/src/decode.js';
import { signatureValid } from '../../reconciler/src/verify-crypto.js';
import { fakeSimResult } from './fixtures/fake-sim-result.js';
import {
  AMOUNT,
  APPLIED_RATE,
  buildParams,
  MEMO,
  MERCHANT,
  OPERATOR_PUBLIC,
  OPERATOR_SECRET,
  PASSPHRASE,
  TROY_POOL,
  TX_ID,
} from './fixtures/vectors.js';

// THE closer for the fixture->real gap. The reconciler was built on footprint-LESS fixture XDR. Here the
// stellar-client produces the REAL submittable envelope (footprint + finite timebounds, signed by the
// operator) and we prove the shipped reconciler decoder + signature check still hold, with ZERO network.

describe('cross-package fixture->real gap closer', () => {
  it('a real submittable pay() envelope decodes to the exact projection and the operator signature verifies', () => {
    const unprepared = buildPayTransaction(buildParams);
    const submittable = assembleFromSimulation(unprepared, fakeSimResult(TROY_POOL, MERCHANT));
    const signedXdr = new LocalKeySigner(OPERATOR_SECRET).sign(submittable);

    const dec = decodeSignedPay(signedXdr, PASSPHRASE);

    expect(dec.projection).toEqual({
      function: 'pay',
      contract_id: TROY_POOL,
      source_account: OPERATOR_PUBLIC,
      tx_id_hex: TX_ID.toString('hex'),
      amount_stroops: AMOUNT.toString(),
      applied_rate_stroops: APPLIED_RATE.toString(),
      merchant: MERCHANT,
      memo_hex: MEMO.toString('hex'),
    });
    expect(signatureValid(dec.tx, OPERATOR_PUBLIC)).toBe(true);
    // the recorded hash is the hash of the assembled (footprint-carrying) tx — the submittable one.
    expect(dec.recomputedHash).toBe(submittable.hash().toString('hex'));
  });
});
