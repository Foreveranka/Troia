// Decode a signed pay() envelope back to its projection + recomputed Stellar tx hash. Used by BOTH the
// reconciler and offline `verify`, from `signed_xdr` ONLY. Imports @stellar/stellar-base for decode/verify
// exclusively — no builder, no signer (keyless by construction). See docs/ARCHITECTURE.md §8.

import { Address, scValToNative, Transaction, TransactionBuilder } from '@stellar/stellar-base';
import type { ChainSnapshotProjection } from './types.js';

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export interface DecodedPay {
  readonly tx: Transaction; // the parsed inner tx (for hash + signature verification)
  readonly recomputedHash: string; // hex of tx.hash() — the real Stellar tx hash
  readonly projection: ChainSnapshotProjection; // normalized pay() args
}

/**
 * Parse + narrow + project. Throws EvidenceError for anything that is not a well-formed, single-op
 * `TroyPool.pay(tx_id, amount, applied_rate, merchant, memo)` invocation. The caller maps that throw to
 * `EVIDENCE_TAMPERED` (the witness is unreadable / the wrong shape).
 */
export function decodeSignedPay(signedXdr: string, passphrase: string): DecodedPay {
  let parsed: Transaction | ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new EvidenceError('signed_xdr failed to parse');
  }
  if (!(parsed instanceof Transaction)) {
    throw new EvidenceError('not a Transaction (fee-bump envelopes are rejected)');
  }
  const tx = parsed;

  const op = tx.operations[0];
  if (!op || tx.operations.length !== 1) throw new EvidenceError('expected exactly one operation');
  if (op.type !== 'invokeHostFunction')
    throw new EvidenceError(`op is ${op.type}, not invokeHostFunction`);

  const func = op.func;
  if (func.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new EvidenceError('host function is not invokeContract');
  }
  const ic = func.invokeContract();
  const fnName = ic.functionName().toString();
  if (fnName !== 'pay') throw new EvidenceError(`invoked ${fnName}, not pay`);

  const a = ic.args();
  if (a.length !== 5) throw new EvidenceError(`pay expects 5 args, got ${a.length}`);

  const projection: ChainSnapshotProjection = {
    function: 'pay',
    contract_id: Address.fromScAddress(ic.contractAddress()).toString(),
    source_account: tx.source,
    tx_id_hex: Buffer.from(scValToNative(a[0]!) as Uint8Array).toString('hex'),
    amount_stroops: (scValToNative(a[1]!) as bigint).toString(),
    applied_rate_stroops: (scValToNative(a[2]!) as bigint).toString(),
    merchant: scValToNative(a[3]!) as string,
    memo_hex: Buffer.from(scValToNative(a[4]!) as Uint8Array).toString('hex'),
  };

  return { tx, recomputedHash: tx.hash().toString('hex'), projection };
}
