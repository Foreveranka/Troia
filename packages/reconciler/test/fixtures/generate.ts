// TEST-ONLY fixture signer. This is the ONLY place in the reconciler package that BUILDS and SIGNS a
// transaction (TransactionBuilder/.sign/Keypair.fromRawEd25519Seed). It lives under test/ so the
// no-signing-in-src guard keeps src keyless. Everything is deterministic: operator key + amounts derive
// from a seed, TimeoutInfinite avoids Date.now(), so two builds are byte-identical.

import { createHash } from 'node:crypto';
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';

/** Deterministic 32 bytes from a label (for seeds, tx_ids, memos). */
export function bytes32(label: string): Buffer {
  return createHash('sha256').update(label).digest();
}

/** The operator keypair for a run — deterministic from the seed (never Keypair.random()). */
export function operatorKeypair(seed: string): Keypair {
  return Keypair.fromRawEd25519Seed(bytes32(`${seed}|operator`));
}

export interface FixtureInput {
  readonly seed: string;
  readonly troyPoolContractId: string; // C-address
  readonly txId32: Buffer; // 32 bytes
  readonly amountStroops: bigint;
  readonly appliedRate: bigint;
  readonly merchant: string; // G… or C… StrKey
  readonly memo32: Buffer; // 32 bytes
  readonly seq: string; // account sequence (decimal string)
  readonly passphrase: string;
}

export interface BuiltFixture {
  readonly signed_xdr: string; // base64 TransactionEnvelope
  readonly hash: string; // hex tx.hash()
  readonly operatorPublic: string; // G-address of the signer
}

/** Build + sign a real Soroban `TroyPool.pay(...)` invocation. Real, decodable, verifiable — but no
 *  Soroban footprint (that comes from RPC simulation), so NOT network-submittable: real ≠ submittable. */
export function buildSignedPay(input: FixtureInput): BuiltFixture {
  const operator = operatorKeypair(input.seed);
  const args = [
    xdr.ScVal.scvBytes(input.txId32),
    nativeToScVal(input.amountStroops, { type: 'i128' }),
    nativeToScVal(input.appliedRate, { type: 'i128' }),
    new Address(input.merchant).toScVal(),
    xdr.ScVal.scvBytes(input.memo32),
  ];
  const op = new Contract(input.troyPoolContractId).call('pay', ...args);
  const tx = new TransactionBuilder(new Account(operator.publicKey(), input.seq), {
    fee: '100',
    networkPassphrase: input.passphrase,
  })
    .addOperation(op)
    .setTimeout(0) // TimeoutInfinite — the only source of non-determinism, killed
    .build();
  tx.sign(operator);
  return {
    signed_xdr: tx.toEnvelope().toXDR('base64'),
    hash: tx.hash().toString('hex'),
    operatorPublic: operator.publicKey(),
  };
}
