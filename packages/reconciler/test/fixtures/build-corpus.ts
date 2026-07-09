// Deterministic N=3 acceptance corpus (seed 'troia-demo-0001'). Every order is built from CHAIN-MATCHING
// values and the signed blob is frozen; ord-003's corruption touches ONLY the local DB row (never re-signed).
// All three orders share ONE operator key (the report pins a single operator_public).

import { createHash } from 'node:crypto';
import { Keypair, Networks, StrKey } from '@stellar/stellar-base';
import { buildSignedPay, bytes32, operatorKeypair } from './generate.js';
import { decodeSignedPay } from '../../src/decode.js';
import { buildReconReport, type OrderInput } from '../../src/report.js';
import type { ReconReport, ReportNetwork } from '../../src/types.js';

const SEED = 'troia-demo-0001';
const PASSPHRASE = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(createHash('sha256').update(`${SEED}|troypool`).digest());
const APPLIED_RATE = 411_075_000n;

function merchantFor(label: string): string {
  return Keypair.fromRawEd25519Seed(bytes32(`${SEED}|merchant|${label}`)).publicKey();
}

function order(label: string, seq: number, chainAmount: bigint, localAmount?: bigint): OrderInput {
  const merchant = merchantFor(label);
  const memo = bytes32(`${SEED}|memo|${label}`);
  const built = buildSignedPay({
    seed: SEED,
    troyPoolContractId: CONTRACT,
    txId32: bytes32(`${SEED}|txid|${label}`),
    amountStroops: chainAmount,
    appliedRate: APPLIED_RATE,
    merchant,
    memo32: memo,
    seq: String(seq),
    passphrase: PASSPHRASE,
  });
  const dec = decodeSignedPay(built.signed_xdr, PASSPHRASE);
  return {
    business_intent: {
      order_id: label,
      destination: merchant,
      amount_stroops: (localAmount ?? chainAmount).toString(),
      memo_hex: memo.toString('hex'),
    },
    ledger_evidence: { signed_xdr: built.signed_xdr, hash: built.hash },
    chain_evidence: {
      tx_hash: built.hash,
      fetched_at_ledger: 2_000_000 + seq,
      horizon_snapshot: dec.projection,
    },
  };
}

export function acceptanceNetwork(): ReportNetwork {
  return {
    network: 'testnet',
    passphrase: PASSPHRASE,
    operator_public: operatorKeypair(SEED).publicKey(),
  };
}

export function buildAcceptanceReport(): ReconReport {
  const inputs: OrderInput[] = [
    order('ord-001', 100, 10_000_000n),
    order('ord-002', 101, 25_000_000n),
    order('ord-003', 102, 5_000_000n, 6_000_000n), // ONLY the local DB amount is corrupted
  ];
  return buildReconReport(SEED, acceptanceNetwork(), inputs);
}
