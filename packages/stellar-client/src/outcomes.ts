// Normalized outcome ADTs. Every raw @stellar/stellar-sdk response type is mapped into one of these by
// the adapter (rpc-adapter.ts) so the pure core NEVER sees an SDK type. This is the reducer's input
// alphabet — the exhaustive set of RPC outcomes the submit-poll state machine branches on.

/** Result of RpcPort.send (submit). Mirrors SendTransactionStatus PENDING|DUPLICATE|TRY_AGAIN_LATER|ERROR,
 *  with txBadSeq lifted out of ERROR because it drives a different (deadness) path than other admission errors. */
export type SendOutcome =
  | { readonly kind: 'PENDING'; readonly hashHex: string }
  | { readonly kind: 'DUPLICATE'; readonly hashHex: string }
  | { readonly kind: 'TRY_AGAIN' }
  | { readonly kind: 'BAD_SEQ' }
  | { readonly kind: 'ERROR'; readonly code: string };

/** Result of RpcPort.getTransaction (poll). Mirrors GetTransactionStatus SUCCESS|NOT_FOUND|FAILED.
 *  NOT_FOUND carries the ledger close time so the (pure) reducer can compare it to the tx maxTime
 *  WITHOUT doing any I/O of its own — expiry is decided from ledger time, never a local clock. */
export type GetTxOutcome =
  | { readonly kind: 'SUCCESS'; readonly ledger: number }
  | { readonly kind: 'NOT_FOUND'; readonly latestLedgerCloseTimeUnix: number }
  | { readonly kind: 'FAILED'; readonly badSeq: boolean };

/** A network read that itself did not return (HTTP timeout / transport error) — distinct from a
 *  definitive NOT_FOUND. Routed to deadness (observe-only), never treated as "did not land". */
export interface TimeoutOutcome {
  readonly kind: 'TIMEOUT';
}

export type PollOutcome = SendOutcome | GetTxOutcome | TimeoutOutcome;

/** The essential product of Soroban simulation. `sorobanDataXdr` carries the footprint AND the resource
 *  fee; `minResourceFee` is the same value as a decimal string (asserted equal at assemble time).
 *  `authXdr` carries the base64 SorobanAuthorizationEntry list simulation returned. For pay() the operator
 *  == tx source, so entries use SOURCE-ACCOUNT credentials (no nonce) and are injected into the op verbatim;
 *  a nonce-bearing ADDRESS credential means a non-source authorizer and is rejected at assemble time. */
export interface SimResult {
  readonly sorobanDataXdr: string;
  readonly minResourceFee: string;
  readonly authXdr: readonly string[];
}

export interface LedgerHead {
  readonly sequence: number;
  readonly closeTimeUnix: number;
}

/** The operator account's on-chain stored sequence. Decimal string, compared as BigInt (never JS number
 *  — Int64 overflows 2^53). `exists:false` means the account/key was not found. */
export interface AccountSeqRead {
  readonly exists: boolean;
  readonly seq: string;
}

/** The deadness verdict — the single fail-closed decision oracle for "may we reuse this sequence?". */
export type Deadness = 'CONFIRMED' | 'SAFE_TO_REPLACE' | 'WAIT' | 'LOSS_REVIEW';

/** The on-chain fate of a submitted tx, as observed by the submit-poll loop. Maps to core events. */
export type PollVerdict =
  | 'LANDED_SUCCESS'
  | 'LANDED_REVERTED'
  | 'STILL_PENDING'
  | 'DEAD_REPLACEABLE'
  | 'INDETERMINATE_LOSS_REVIEW';
