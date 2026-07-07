// Unit tests for the PURE projectors behind the two extra StellarPort reads (Phase 4.5 composition):
//   - scValI128ToBigInt      : an i128 return ScVal (SAC balance) -> bigint stroops
//   - scValContractErrorCode : one ScVal -> a TroyPool contract Error discriminant (1..5) or null
//   - firstContractErrorCode : the first contract error across a flat ScVal list (the reverted-tx diagnostics)
// The DIRTY halves (simulate / getTransaction over rpc.Server) live in rpc-adapter.ts and are live-smoked, not
// unit-tested. These parsers are the money-safety-critical part: a null revert code is the SAFE default
// (classifyRevertCause(null)='Other' -> re-drive; the contract's Processed(tx_id) guard is the real double-pay
// shield), so the parser must NEVER invent a code it is not certain of.

import { describe, expect, it } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-base';
import {
  firstContractErrorCode,
  firstContractErrorCodeFromContract,
  scValContractErrorCode,
  scValI128ToBigInt,
} from '../src/soroban-reads.js';
import type { DiagnosticScVals } from '../src/soroban-reads.js';

const UNIT = 10_000_000n; // 1 USDC @ 7 decimals

describe('scValI128ToBigInt — SAC balance i128 -> bigint stroops', () => {
  const cases: readonly bigint[] = [
    0n,
    1n,
    10n * UNIT, // 10 USDC
    99_994n * UNIT, // a realistic pool balance
    (1n << 64n) - 1n, // max low word (unsigned) — the hi/lo boundary
    1n << 64n, // hi=1, lo=0
    (1n << 80n) + 5n, // well above 2^64
  ];
  for (const v of cases) {
    it(`round-trips ${v.toString()}`, () => {
      const scv = nativeToScVal(v, { type: 'i128' });
      expect(scValI128ToBigInt(scv)).toBe(v);
    });
  }

  it('rejects a non-i128 ScVal (fail-closed, never a silent 0)', () => {
    expect(() => scValI128ToBigInt(xdr.ScVal.scvU32(5))).toThrow(RangeError);
  });
});

describe('scValContractErrorCode — one ScVal -> contract Error discriminant or null', () => {
  // The full TroyPool Error enum (contracts/troy_pool/src/lib.rs): 1..5.
  for (const code of [1, 2, 3, 4, 5]) {
    it(`extracts a contract error code ${code}`, () => {
      const scv = xdr.ScVal.scvError(xdr.ScError.sceContract(code));
      expect(scValContractErrorCode(scv)).toBe(code);
    });
  }

  it('returns null for a NON-contract ScError (e.g. a host/VM error carries no contract discriminant)', () => {
    const scv = xdr.ScVal.scvError(xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInvalidInput()));
    expect(scValContractErrorCode(scv)).toBeNull();
  });

  it('returns null for a non-error ScVal (a u32, a bool, void)', () => {
    expect(scValContractErrorCode(xdr.ScVal.scvU32(2))).toBeNull();
    expect(scValContractErrorCode(xdr.ScVal.scvBool(true))).toBeNull();
    expect(scValContractErrorCode(xdr.ScVal.scvVoid())).toBeNull();
  });
});

describe('firstContractErrorCode — first contract error across a flat ScVal list', () => {
  const err = (code: number): xdr.ScVal => xdr.ScVal.scvError(xdr.ScError.sceContract(code));

  it('finds the code when it is the only entry', () => {
    expect(firstContractErrorCode([err(1)])).toBe(1);
  });

  it('skips non-error ScVals and returns the first contract error', () => {
    expect(firstContractErrorCode([xdr.ScVal.scvU32(9), xdr.ScVal.scvString('boom'), err(2)])).toBe(2);
  });

  it('returns the FIRST contract error when several are present', () => {
    expect(firstContractErrorCode([err(4), err(1)])).toBe(4);
  });

  it('returns null on an empty list (no diagnostics -> safe re-drive default)', () => {
    expect(firstContractErrorCode([])).toBeNull();
  });

  it('returns null when no ScVal is a contract error', () => {
    const vm = xdr.ScVal.scvError(xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInvalidInput()));
    expect(firstContractErrorCode([xdr.ScVal.scvU32(1), vm])).toBeNull();
  });
});

describe('firstContractErrorCodeFromContract — scope the revert code to the TroyPool contract only', () => {
  const POOL = 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ'; // TroyPool
  const SAC = 'CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB'; // inner USDC SAC
  const err = (code: number): xdr.ScVal => xdr.ScVal.scvError(xdr.ScError.sceContract(code));
  const ev = (contractId: string | null, ...vals: xdr.ScVal[]): DiagnosticScVals => ({ contractId, vals });

  it('reads the code from a TroyPool-emitted error event', () => {
    expect(firstContractErrorCodeFromContract([ev(POOL, err(2))], POOL)).toBe(2);
  });

  it('MONEY-SAFETY: a SAC sub-contract error with an OVERLAPPING discriminant (1) is IGNORED, not read as AlreadyProcessed', () => {
    // A failed inner transfer: the SAC emits its own code 1 BEFORE any TroyPool code. Unscoped this would be
    // classifyRevertCause(1)='AlreadyProcessed' -> keep the TRY charge though no USDC moved. Scoped -> null.
    expect(firstContractErrorCodeFromContract([ev(SAC, err(1))], POOL)).toBeNull();
  });

  it('picks the TroyPool code even when a SAC error event precedes it', () => {
    expect(firstContractErrorCodeFromContract([ev(SAC, err(1)), ev(POOL, err(2))], POOL)).toBe(2);
  });

  it('ignores a host-level (null contractId) error event', () => {
    expect(firstContractErrorCodeFromContract([ev(null, err(1))], POOL)).toBeNull();
  });

  it('ignores an error from an unrelated contract address', () => {
    expect(firstContractErrorCodeFromContract([ev(SAC, err(3))], POOL)).toBeNull();
  });

  it('returns the first TroyPool error across its own multiple events', () => {
    expect(firstContractErrorCodeFromContract([ev(POOL, xdr.ScVal.scvU32(9)), ev(POOL, err(4)), ev(POOL, err(1))], POOL)).toBe(4);
  });

  it('returns null on no events (empty diagnostics -> safe re-drive default)', () => {
    expect(firstContractErrorCodeFromContract([], POOL)).toBeNull();
  });
});
