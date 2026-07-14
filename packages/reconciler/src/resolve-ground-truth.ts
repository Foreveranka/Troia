// resolveGroundTruth — the total, ordered, role-split decision procedure (docs/ARCHITECTURE §8 §5).
// (b) the signed XDR is the cryptographic tiebreaker between the mutable local row (a) and the observed
// chain (c). The ordering is load-bearing: tamper (HB) is split from divergence (BC) so CHAIN_DIVERGENCE
// stays reachable, and CORRUPT_LOCAL is reached ONLY after S∧HB∧BC∧DC — so it always carries a valid
// signature (the ord-003 acceptance guarantee).

import { decodeSignedPay } from './decode.js';
import { computeDiffs, differing, intentEqualsChain } from './field-diff.js';
import { semanticEqualProjection } from './normalize.js';
import { chainBound, hashConsistent, signatureValid } from './verify-crypto.js';
import {
  verdictToStatus,
  type BusinessIntent,
  type ChainEvidence,
  type FieldDiff,
  type GroundTruth,
  type LedgerEvidence,
  type Verdict,
} from './types.js';

function gt(
  verdict: Verdict,
  signature_valid: boolean,
  hash_consistent: boolean,
  chain_bound: boolean,
  field_diff: readonly FieldDiff[],
): GroundTruth {
  return {
    verdict,
    status: verdictToStatus(verdict),
    signature_valid,
    hash_consistent,
    chain_bound,
    field_diff,
  };
}

export function resolveGroundTruth(
  intent: BusinessIntent,
  ledger: LedgerEvidence,
  chain: ChainEvidence | null,
  operatorPublic: string,
  passphrase: string,
): GroundTruth {
  // Step 1 — decode (b). Unreadable / wrong shape → the witness itself is forged.
  let decoded;
  try {
    decoded = decodeSignedPay(ledger.signed_xdr, passphrase);
  } catch {
    return gt('EVIDENCE_TAMPERED', false, false, false, []);
  }

  const sig = signatureValid(decoded.tx, operatorPublic);
  const hb = hashConsistent(decoded.recomputedHash, ledger.hash);
  const bc = chainBound(ledger.hash, chain?.tx_hash);

  // Step 2 — pinned-operator signature.
  if (!sig) return gt('EVIDENCE_TAMPERED', false, hb, bc, []);
  // Step 3 — hash self-consistency (blob ↮ recorded hash).
  if (!hb) return gt('EVIDENCE_TAMPERED', true, false, bc, []);
  // ── (b) is now an authentic, self-consistent operator witness ──

  // Step 4 — chain presence (testnet reset / never landed).
  if (chain === null) return gt('UNSETTLED', true, true, false, []);

  // Step 5 — divergence: a DIFFERENT tx settled (hash unbound OR decode ≠ snapshot).
  const diffs = computeDiffs(intent, chain.horizon_snapshot);
  const dc = semanticEqualProjection(decoded.projection, chain.horizon_snapshot);
  if (!bc || !dc) return gt('CHAIN_DIVERGENCE', true, true, bc, differing(diffs));

  // Steps 6/7 — the local row vs the (crypto-anchored) chain.
  if (intentEqualsChain(diffs)) return gt('MATCHED', true, true, true, []);
  return gt('CORRUPT_LOCAL', true, true, true, differing(diffs));
}
