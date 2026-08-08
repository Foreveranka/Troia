// The three offline crypto predicates (docs/ARCHITECTURE §8), recomputed from embedded report data only —
// no network, no DB. Never trusts the source-from-XDR as the anchor; the operator key is PINNED and passed
// in, and the signature is selected BY HINT (any hint-matching sig that verifies passes → multisig seam).

import { hash, Keypair, StrKey, xdr, type Transaction } from '@stellar/stellar-base';

/**
 * P2 — pinned-operator signature. TWO shapes, one trust anchor (the pinned operator key):
 *
 *   Single-operator mode (tx source == operator): at least one decorated ENVELOPE signature whose hint ==
 *   operator pub[28:32] verifies over `tx.hash()` — exactly as before, byte-for-byte.
 *
 *   Channel mode (A-5; tx source is a channel account): the envelope is signed by the CHANNEL, so the
 *   operator's authority lives INSIDE the op — an address-credential SorobanAuthorizationEntry whose address
 *   is the operator and whose signature verifies over the SorobanAuthorization HASH-ID PREIMAGE
 *   (network id ‖ nonce ‖ expiration ‖ invocation). That preimage signature is precisely what the network
 *   itself verified to accept require_auth(operator), so anchoring on it keeps the property this predicate
 *   exists for: the recorded settlement is authentically the OPERATOR's act, whoever paid the fee.
 */
export function signatureValid(tx: Transaction, operatorPublic: string): boolean {
  let opRaw: Buffer;
  try {
    opRaw = Buffer.from(StrKey.decodeEd25519PublicKey(operatorPublic));
  } catch {
    return false; // not a valid operator key → cannot anchor trust
  }
  if (tx.source === operatorPublic) {
    const wantHint = opRaw.subarray(28, 32).toString('hex');
    const kp = Keypair.fromPublicKey(operatorPublic);
    const h = tx.hash();
    return tx.signatures.some(
      (s) => s.hint().toString('hex') === wantHint && kp.verify(h, s.signature()),
    );
  }
  return operatorAuthEntrySigned(tx, operatorPublic, opRaw);
}

/** Channel-mode half of P2: find an address-credential auth entry pinned to the operator and verify its
 *  signature over the SorobanAuthorization preimage. Fail-closed on every malformed shape. */
function operatorAuthEntrySigned(tx: Transaction, operatorPublic: string, opRaw: Buffer): boolean {
  const kp = Keypair.fromPublicKey(operatorPublic);
  const networkId = hash(Buffer.from(tx.networkPassphrase, 'utf8'));
  for (const op of tx.operations) {
    if (op.type !== 'invokeHostFunction') continue;
    for (const entry of op.auth ?? []) {
      try {
        const creds = entry.credentials();
        if (creds.switch().name !== 'sorobanCredentialsAddress') continue;
        const addr = creds.address().address();
        if (addr.switch().name !== 'scAddressTypeAccount') continue;
        if (!Buffer.from(addr.accountId().ed25519()).equals(opRaw)) continue;
        // The exact payload the network verified: SHA-256 of the SorobanAuthorization hash-id preimage.
        const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce: creds.address().nonce(),
            signatureExpirationLedger: creds.address().signatureExpirationLedger(),
            invocation: entry.rootInvocation(),
          }),
        );
        const payload = hash(preimage.toXDR());
        if (anySignatureVerifies(creds.address().signature(), opRaw, kp, payload)) return true;
      } catch {
        continue; // a malformed entry proves nothing; keep looking, default to false
      }
    }
  }
  return false;
}

/** The auth-entry signature ScVal is a vec of {public_key, signature} maps (the shape authorizeEntry and
 *  every SDK wallet produce). Accept the entry only if a pair carries the OPERATOR's key and verifies. */
function anySignatureVerifies(
  sigVal: xdr.ScVal,
  opRaw: Buffer,
  kp: Keypair,
  payload: Buffer,
): boolean {
  if (sigVal.switch().name !== 'scvVec') return false;
  for (const item of sigVal.vec() ?? []) {
    if (item.switch().name !== 'scvMap') continue;
    let publicKey: Buffer | null = null;
    let signature: Buffer | null = null;
    for (const pair of item.map() ?? []) {
      const key = pair.key();
      if (key.switch().name !== 'scvSymbol') continue;
      const name = key.sym().toString();
      const val = pair.val();
      if (val.switch().name !== 'scvBytes') continue;
      if (name === 'public_key') publicKey = Buffer.from(val.bytes());
      if (name === 'signature') signature = Buffer.from(val.bytes());
    }
    if (publicKey !== null && signature !== null && publicKey.equals(opRaw)) {
      if (kp.verify(payload, signature)) return true;
    }
  }
  return false;
}

/** P1 — (b) self-consistency: the hash recomputed from the blob equals the recorded hash. */
export function hashConsistent(recomputedHash: string, recordedHash: string): boolean {
  return recomputedHash.toLowerCase() === recordedHash.toLowerCase();
}

/** P3 (identity half) — (b)↔(c) binding: recorded hash equals the chain tx_hash, bitwise (hex). */
export function chainBound(recordedHash: string, txHash: string | undefined): boolean {
  return txHash !== undefined && recordedHash.toLowerCase() === txHash.toLowerCase();
}
