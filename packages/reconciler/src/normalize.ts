// Semantic comparators — ONE source, shared by the (a)↔(c) field-diff AND the decode==snapshot check, so
// the two can never disagree by format. All comparisons are TOTAL: a corrupted local value yields `false`
// (a mismatch), never a throw. amount→bigint, address→canonical StrKey, memo/tx_id→lowercase hex.

import { Address, StrKey } from '@stellar/stellar-base';
import type { ChainSnapshotProjection } from './types.js';

// A canonical non-negative decimal. This guard is load-bearing: BigInt('') === 0n and BigInt(' 10 ')
// === 10n in JS, so without it a blanked/whitespace/hex local amount would be conflated with a numeric
// value and a genuinely corrupted row (e.g. '' vs a zero-amount settlement) would read as MATCHED. Any
// non-canonical string fails SAFE to not-equal, surfacing the corruption as CORRUPT_LOCAL. Leading zeros
// ('010' vs '10') stay equal — same value, not a corruption.
const CANONICAL_DECIMAL = /^[0-9]+$/;

export function amountEqual(local: string, chain: string): boolean {
  if (!CANONICAL_DECIMAL.test(local) || !CANONICAL_DECIMAL.test(chain)) return false;
  return BigInt(local) === BigInt(chain);
}

function canonicalAddress(s: string): string | null {
  if (!StrKey.isValidEd25519PublicKey(s) && !StrKey.isValidContract(s)) return null;
  try {
    return Address.fromString(s).toString();
  } catch {
    return null;
  }
}

export function addressEqual(local: string, chain: string): boolean {
  const a = canonicalAddress(local);
  const b = canonicalAddress(chain);
  return a !== null && b !== null && a === b;
}

export function hexEqual(local: string, chain: string): boolean {
  return local.toLowerCase() === chain.toLowerCase();
}

/** decode(signed_xdr) ≡ chain snapshot (the (b)↔(c) divergence check). Field-by-field, semantic. */
export function semanticEqualProjection(
  x: ChainSnapshotProjection,
  y: ChainSnapshotProjection,
): boolean {
  return (
    x.function === y.function &&
    addressEqual(x.contract_id, y.contract_id) &&
    addressEqual(x.source_account, y.source_account) &&
    hexEqual(x.tx_id_hex, y.tx_id_hex) &&
    amountEqual(x.amount_stroops, y.amount_stroops) &&
    amountEqual(x.applied_rate_stroops, y.applied_rate_stroops) &&
    addressEqual(x.merchant, y.merchant) &&
    hexEqual(x.memo_hex, y.memo_hex)
  );
}
