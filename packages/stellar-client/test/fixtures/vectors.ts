// Deterministic shared test vectors. Operator/merchant/contract/tx_id/memo all derive from a fixed seed
// (never Keypair.random), mirroring the reconciler fixture derivation, so every spec builds byte-identical
// transactions and the cross-package gap test can re-derive and verify signatures.

import { createHash } from 'node:crypto';
import { Keypair, Networks, StrKey } from '@stellar/stellar-base';
import type { BuildParams } from '../../src/build.js';

export function bytes32(label: string): Buffer {
  return createHash('sha256').update(label).digest();
}

export const PASSPHRASE = Networks.TESTNET;
export const SEED = 'troia-sc-0001';

const operatorKp = Keypair.fromRawEd25519Seed(bytes32(`${SEED}|operator`));
export const OPERATOR_PUBLIC = operatorKp.publicKey();
export const OPERATOR_SECRET = operatorKp.secret();

export const MERCHANT = Keypair.fromRawEd25519Seed(bytes32(`${SEED}|merchant`)).publicKey();
export const ISSUER = Keypair.fromRawEd25519Seed(bytes32(`${SEED}|issuer`)).publicKey();
export const TROY_POOL = StrKey.encodeContract(bytes32(`${SEED}|troypool`));

export const TX_ID = bytes32(`${SEED}|txid`);
export const MEMO = bytes32(`${SEED}|memo`);
export const AMOUNT = 12_500_000n; // 1.25 USDC in stroops (7 decimals)
export const APPLIED_RATE = 411_075_000n;

/** A finite, pinned upper timebound (unix seconds) so builds are reproducible. */
export const MAX_TIME = 1_893_456_000; // 2030-01-01

export const buildParams: BuildParams = {
  operatorPublic: OPERATOR_PUBLIC,
  seq: '100',
  minTime: 0,
  maxTime: MAX_TIME,
  fee: '1000',
  passphrase: PASSPHRASE,
  troyPool: TROY_POOL,
  txId32: TX_ID,
  amount: AMOUNT,
  appliedRate: APPLIED_RATE,
  merchant: MERCHANT,
  memo32: MEMO,
};
