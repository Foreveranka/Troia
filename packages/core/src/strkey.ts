import { StrKey } from '@stellar/stellar-base';

// Address validation delegates to the official StrKey implementation (base32 + CRC16 checksum +
// version byte). We deliberately do NOT re-implement the checksum — boring, correct, battle-tested.

export type AddressType = 'ed25519' | 'contract' | 'invalid';

/**
 * Classify a Stellar StrKey address. Returns 'ed25519' for a valid classic account ("G…"),
 * 'contract' for a valid contract ("C…"), and 'invalid' for anything else (bad checksum, wrong
 * length, wrong version byte, other StrKey kinds). Pure.
 */
export function classifyAddress(address: string): AddressType {
  if (StrKey.isValidEd25519PublicKey(address)) return 'ed25519';
  if (StrKey.isValidContract(address)) return 'contract';
  return 'invalid';
}
