// The three offline crypto predicates (docs/ARCHITECTURE §8), recomputed from embedded report data only —
// no network, no DB. Never trusts the source-from-XDR as the anchor; the operator key is PINNED and passed
// in, and the signature is selected BY HINT (any hint-matching sig that verifies passes → multisig seam).

import { Keypair, StrKey, type Transaction } from '@stellar/stellar-base';

/**
 * P2 — pinned-operator signature over the tx HASH. Requires the tx source to be the pinned operator AND at
 * least one decorated signature whose hint == operator pub[28:32] verifies over `tx.hash()`. Ed25519 is
 * signed over the 32-byte hash, NOT over the envelope or the signature base.
 */
export function signatureValid(tx: Transaction, operatorPublic: string): boolean {
  let opRaw: Buffer;
  try {
    opRaw = Buffer.from(StrKey.decodeEd25519PublicKey(operatorPublic));
  } catch {
    return false; // not a valid operator key → cannot anchor trust
  }
  if (tx.source !== operatorPublic) return false;
  const wantHint = opRaw.subarray(28, 32).toString('hex');
  const kp = Keypair.fromPublicKey(operatorPublic);
  const h = tx.hash();
  return tx.signatures.some(
    (s) => s.hint().toString('hex') === wantHint && kp.verify(h, s.signature()),
  );
}

/** P1 — (b) self-consistency: the hash recomputed from the blob equals the recorded hash. */
export function hashConsistent(recomputedHash: string, recordedHash: string): boolean {
  return recomputedHash.toLowerCase() === recordedHash.toLowerCase();
}

/** P3 (identity half) — (b)↔(c) binding: recorded hash equals the chain tx_hash, bitwise (hex). */
export function chainBound(recordedHash: string, txHash: string | undefined): boolean {
  return txHash !== undefined && recordedHash.toLowerCase() === txHash.toLowerCase();
}
