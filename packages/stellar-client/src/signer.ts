// The ONE keyed file in the repo. It is the concrete Signer: it holds the operator secret and produces a
// signed envelope. It is constructed from an injected secret at the composition root (the backend), NEVER
// from NetworkConfig (which is secret-free by design). sign() is functional — it signs a COPY parsed from
// XDR and returns bytes, so the caller's tx object is never mutated.

import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-base';
import type { Signer, SubmittableTx } from './ports.js';

export class LocalKeySigner implements Signer {
  private readonly keypair: Keypair;

  /** @param operatorSecret an S-address secret seed. Provided from env at the composition root only. */
  constructor(operatorSecret: string) {
    this.keypair = Keypair.fromSecret(operatorSecret);
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  sign(submittable: SubmittableTx): string {
    const copy = TransactionBuilder.fromXDR(
      submittable.toEnvelope().toXDR('base64'),
      submittable.networkPassphrase,
    );
    // pay() is always a plain v1 Transaction; a fee-bump envelope here is a construction bug (and the
    // reconciler would reject it), so fail closed rather than sign the wrong shape.
    if (!(copy instanceof Transaction)) {
      throw new Error('refusing to sign a non-Transaction (fee-bump) envelope');
    }
    copy.sign(this.keypair);
    return copy.toEnvelope().toXDR('base64');
  }
}
