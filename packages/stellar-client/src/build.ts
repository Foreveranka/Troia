// PURE, deterministic construction of the unprepared (pre-simulation) TroyPool.pay() invocation.
// This generalizes reconciler/test/fixtures/generate.ts into a production builder, with two differences:
//   1) timebounds are INJECTED as absolute unix seconds (never setTimeout/Date.now) — determinism,
//   2) it neither simulates nor signs — those are separate steps (assemble.ts, the Signer).
// The arg encoding mirrors generate.ts BYTE-FOR-BYTE because the reconciler decodes exactly this shape:
//   arg0 scvBytes(tx_id) · arg1 i128(amount) · arg2 i128(applied_rate) · arg3 Address(merchant) · arg4 scvBytes(memo).
// No key material and no network types cross this file (keyless-boundary guard).

import {
  Account,
  Address,
  Contract,
  nativeToScVal,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';
import type { UnpreparedTx } from './ports.js';
import { BuildError } from './errors.js';

export interface BuildParams {
  /** operator G-address — the tx SOURCE (pay() authorizes via source-account auth). */
  readonly operatorPublic: string;
  /** the operator account's CURRENT stored sequence; the built tx uses seq+1 (TransactionBuilder increments). */
  readonly seq: string;
  /** absolute lower/upper timebounds in unix seconds. maxTime must be finite — never TimeoutInfinite. */
  readonly minTime: number;
  readonly maxTime: number;
  /** classic inclusion fee (stroops, string). The Soroban resource fee is added later at assemble. */
  readonly fee: string;
  readonly passphrase: string;
  /** TroyPool contract C-address. */
  readonly troyPool: string;
  readonly txId32: Uint8Array;
  readonly amount: bigint;
  readonly appliedRate: bigint;
  readonly merchant: string;
  readonly memo32: Uint8Array;
}

/**
 * Build the unsigned, un-simulated pay() transaction. Deterministic: identical params -> byte-identical
 * XDR. A fresh Account is created per call, so the sequence increment never leaks across invocations.
 */
export function buildPayTransaction(p: BuildParams): UnpreparedTx {
  // Enforce the finite-timebound invariant the docstring claims (and that the poll loop + deadness rely on
  // for expiry). maxTime <= 0 is Stellar's TimeoutInfinite convention — an un-expirable tx would make the
  // order un-reconcilable (poll forever, never SAFE_TO_REPLACE). Fail fast instead of silently stuck.
  if (
    !Number.isInteger(p.minTime) ||
    !Number.isInteger(p.maxTime) ||
    p.minTime < 0 ||
    p.maxTime <= 0 ||
    p.maxTime <= p.minTime
  ) {
    throw new BuildError(
      'timebounds must be integers with 0 <= minTime < maxTime (never TimeoutInfinite)',
    );
  }

  // Arg encoding is IDENTICAL to reconciler/test/fixtures/generate.ts — the reconciler decodes exactly
  // this shape, so any deviation (scvString vs scvBytes, wrong i128 width/sign) silently changes the
  // projection. The cross-package gap test pins this by asserting decode(build(...)) equals the inputs.
  const args = [
    xdr.ScVal.scvBytes(Buffer.from(p.txId32)),
    nativeToScVal(p.amount, { type: 'i128' }),
    nativeToScVal(p.appliedRate, { type: 'i128' }),
    new Address(p.merchant).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(p.memo32)),
  ];
  const op = new Contract(p.troyPool).call('pay', ...args);

  return new TransactionBuilder(new Account(p.operatorPublic, p.seq), {
    fee: p.fee,
    networkPassphrase: p.passphrase,
  })
    .addOperation(op)
    .setTimebounds(p.minTime, p.maxTime)
    .build();
}
