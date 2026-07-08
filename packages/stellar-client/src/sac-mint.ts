// PURE, deterministic construction of the unprepared (pre-simulation) USDC SAC `mint(to, amount)` invocation —
// the programmatic form of `just fund` step 5 (`stellar contract invoke $SAC --source-account issuer -- mint
// --to $POOL --amount N`). The tx SOURCE is the ISSUER (the SAC admin), so the mint authorizes via
// source-account auth exactly like the CLI. Mirrors build.ts (buildPayTransaction): timebounds are INJECTED as
// absolute unix seconds (determinism), and it neither simulates nor signs. On testnet this mints self-issued
// USDC; on mainnet the SAME rebalance seam drives a real CEX buy instead (the mint disappears with the issuer).

import { Account, Address, Contract, nativeToScVal, TransactionBuilder } from '@stellar/stellar-base';
import type { UnpreparedTx } from './ports.js';
import { BuildError } from './errors.js';

export interface SacMintParams {
  /** the asset ISSUER (SAC admin) G-address — the tx SOURCE (mint authorizes via source-account auth). */
  readonly issuerPublic: string;
  /** the issuer account's CURRENT stored sequence; the built tx uses seq+1 (TransactionBuilder increments). */
  readonly seq: string;
  /** absolute lower/upper timebounds in unix seconds. maxTime must be finite — never TimeoutInfinite. */
  readonly minTime: number;
  readonly maxTime: number;
  /** classic inclusion fee (stroops, string). The Soroban resource fee is added later at assemble. */
  readonly fee: string;
  readonly passphrase: string;
  /** the USDC Stellar Asset Contract C-address. */
  readonly sacContractId: string;
  /** the mint destination — the pool contract C-address. */
  readonly to: string;
  /** USDC to mint, in stroops (7 decimals, > 0). */
  readonly amount: bigint;
}

/** Build the unsigned, un-simulated SAC mint(to, amount) transaction. Deterministic: identical params ->
 *  byte-identical XDR. A fresh Account per call, so the sequence increment never leaks across invocations. */
export function buildSacMintTransaction(p: SacMintParams): UnpreparedTx {
  if (
    !Number.isInteger(p.minTime) ||
    !Number.isInteger(p.maxTime) ||
    p.minTime < 0 ||
    p.maxTime <= 0 ||
    p.maxTime <= p.minTime
  ) {
    throw new BuildError('timebounds must be integers with 0 <= minTime < maxTime (never TimeoutInfinite)');
  }
  if (p.amount <= 0n) throw new BuildError('mint amount must be > 0');

  // SAC `mint(to: Address, amount: i128)`. `to` is the pool CONTRACT (a C-address); Address() accepts both G
  // and C strkeys. i128 mirrors the amount encoding used across the pay() path.
  const args = [new Address(p.to).toScVal(), nativeToScVal(p.amount, { type: 'i128' })];
  const op = new Contract(p.sacContractId).call('mint', ...args);

  return new TransactionBuilder(new Account(p.issuerPublic, p.seq), {
    fee: p.fee,
    networkPassphrase: p.passphrase,
  })
    .addOperation(op)
    .setTimebounds(p.minTime, p.maxTime)
    .build();
}
