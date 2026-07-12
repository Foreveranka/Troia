// PURE projectors for the two extra StellarPort reads the composition root needs beyond createStellarClient
// (Phase 4.5). SDK-Server-FREE and Keypair-free (enforced by keyless-boundary.spec.ts): they only decode
// already-fetched ScVals via @stellar/stellar-base's xdr, so they are offline-unit-testable. The DIRTY halves
// that actually hit the network (simulate `balance` / getTransaction a reverted tx) live in rpc-adapter.ts and
// are type-checked + live-smoked, calling these to interpret the raw result.
//
// MONEY-SAFETY: scValContractErrorCode / firstContractErrorCode return null unless a contract Error discriminant
// is CERTAIN. A null flows to classifyRevertCause(null)='Indeterminate' -> a BOUNDED fresh-seq re-drive, then
// LossReview on budget exhaustion (never an auto-void): a null could mask a settled AlreadyProcessed, so voiding
// would over-refund. The Processed(tx_id) guard remains the double-pay shield, so a null can never cause a double
// payout. Inventing a wrong code, by contrast, could mis-route (e.g. skip capturing a TRY charge whose USDC already
// landed), so the parsers stay strict: only an exact scvError->sceContract yields a code.
//
// CONTRACT-SCOPING (firstContractErrorCodeFromContract): pay() invokes the USDC SAC's transfer, so a reverted
// tx's diagnostics can carry a SUB-contract's error whose discriminant OVERLAPS TroyPool's enum (SAC code 1 vs
// AlreadyProcessed=1). Reading that as TroyPool AlreadyProcessed would make the backend keep a TRY charge whose
// USDC never moved. So the revert code is scoped to events emitted BY the TroyPool contract only — a structural
// guarantee (independent of host version / SAC taxonomy / which token backs the pool) that ONLY TroyPool's own
// Error enum can ever drive classifyRevertCause.

import { xdr } from '@stellar/stellar-base';

/**
 * Decode an i128 return ScVal (a SAC `balance` result) into a bigint of stroops. i128 = hi·2^64 + lo, where hi
 * is the SIGNED high word and lo the UNSIGNED low word (Int128Parts semantics); balances are non-negative but
 * the math is the general signed one. Fail-closed on a non-i128 ScVal — never a silent 0 that would read an
 * empty pool as solvent.
 */
export function scValI128ToBigInt(val: xdr.ScVal): bigint {
  if (val.switch().name !== 'scvI128') {
    throw new RangeError(`expected an i128 ScVal, got ${val.switch().name}`);
  }
  const parts = val.i128();
  const hi = BigInt(parts.hi().toString()); // signed high 64 bits
  const lo = BigInt(parts.lo().toString()); // unsigned low 64 bits
  return (hi << 64n) + lo;
}

/**
 * If this ScVal is a contract error (scvError whose ScError is sceContract), return its discriminant (a TroyPool
 * Error code 1..5); otherwise null. A host/VM ScError (which carries no contract discriminant) and any non-error
 * ScVal both yield null — the strict, money-safe default.
 */
export function scValContractErrorCode(val: xdr.ScVal): number | null {
  if (val.switch().name !== 'scvError') return null;
  const err = val.error();
  if (err.switch().name !== 'sceContract') return null;
  const code: unknown = err.contractCode();
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/**
 * The first contract Error discriminant across a flat list of ScVals (the topics+data of a reverted tx's
 * diagnostic events, flattened by the adapter). null when none is a contract error — the safe re-drive default.
 */
export function firstContractErrorCode(vals: readonly xdr.ScVal[]): number | null {
  for (const v of vals) {
    const code = scValContractErrorCode(v);
    if (code !== null) return code;
  }
  return null;
}

/** One reverted-tx diagnostic event reduced to (emitting contract C-address, its topics+data ScVals). A
 *  host-level event with no contract carries contractId: null. Produced by the adapter's dirty extraction. */
export interface DiagnosticScVals {
  readonly contractId: string | null;
  readonly vals: readonly xdr.ScVal[];
}

/**
 * The first contract Error discriminant emitted BY `poolContractId` across a reverted tx's diagnostic events.
 * Events from ANY OTHER contract (e.g. the inner USDC SAC) or with no contractId are IGNORED, so a sub-contract's
 * error can NEVER be mistaken for a TroyPool Error code. null when the pool contract itself emitted no contract
 * error — the money-safe re-drive default. This strict scope is the structural guarantee behind the money-safety
 * note above: only TroyPool's own Error enum (1..5) can ever reach classifyRevertCause.
 */
export function firstContractErrorCodeFromContract(
  events: readonly DiagnosticScVals[],
  poolContractId: string,
): number | null {
  for (const e of events) {
    if (e.contractId !== poolContractId) continue; // strict: only the pool's OWN error events count
    const code = firstContractErrorCode(e.vals);
    if (code !== null) return code;
  }
  return null;
}
