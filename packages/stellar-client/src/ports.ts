// The injectable seam. The pure core depends ONLY on these interfaces — never on a concrete
// @stellar/stellar-sdk Server, never on a Keypair, never on process.env. Concrete implementations
// (rpc-adapter / horizon-adapter / signer) live in their own files and are wired at the composition
// root (the backend, Phase 4.3). This is what keeps the money logic offline-unit-testable with fakes.

import type { Transaction } from '@stellar/stellar-base';
import type {
  AccountSeqRead,
  GetTxOutcome,
  LedgerHead,
  SendOutcome,
  SimResult,
} from './outcomes.js';

/** A built-but-not-yet-simulated pay() tx (inclusion fee only, no Soroban footprint). */
export type UnpreparedTx = Transaction;
/** A simulated, footprint-carrying, submittable pay() tx (still unsigned until the Signer runs). */
export type SubmittableTx = Transaction;

/** A minimal projection of a Horizon account response — what toAccountSnapshot needs, plus the string `balance`
 *  the adapter already carries at runtime (used only by the preflight's fee/liquidity read; ignored by the
 *  trustline mapping). */
export interface HorizonBalanceLine {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance?: string;
}
export interface AccountSnapshotJson {
  readonly balances: readonly HorizonBalanceLine[];
}

/** All Soroban-RPC I/O. network:true, keyless. Every method returns a normalized outcome ADT, never a
 *  raw SDK type — the adapter is where SDK types are quarantined. */
export interface RpcPort {
  simulate(unprepared: UnpreparedTx): Promise<SimResult>;
  send(signedXdrBase64: string): Promise<SendOutcome>;
  getTransaction(hashHex: string): Promise<GetTxOutcome>;
  /** The SPIKE-2 seq-burned read: the operator account's current on-chain stored sequence. */
  readAccountSeq(operatorPublic: string): Promise<AccountSeqRead>;
  latestLedger(): Promise<LedgerHead>;
}

/** Horizon account load for the destination's AccountSnapshot (exists + trustlines). network:true, keyless. */
export interface HorizonPort {
  loadAccountSnapshot(destination: string): Promise<AccountSnapshotJson | null>;
}

/** THE keyed seam — the only place a secret key ever acts. network:false. Signs the submittable tx and
 *  returns the base64 envelope. The pure core never holds a key; it hands a tx in and gets bytes back. */
export interface Signer {
  publicKey(): string;
  sign(submittable: SubmittableTx): string;
}

/** Write-ahead persistence: the exact signed envelope + its hash are written BEFORE any send, so a crash
 *  leaves a byte-exact, resubmittable artifact. Idempotent resend reads these bytes verbatim (never rebuilds). */
export interface WriteAheadJournal {
  persistPreSubmit(
    orderId: string,
    seq: string,
    hashHex: string,
    signedXdrBase64: string,
  ): Promise<void>;
  loadPersisted(orderId: string): Promise<{ hashHex: string; signedXdr: string } | null>;
}

/** Wall-clock — for logging/backoff ONLY. It is NEVER consulted to decide tx liveness/expiry (that comes
 *  from ledger close time), because local clock skew declaring a live tx dead would free its seq = double-pay. */
export interface Clock {
  nowUnix(): number;
}
