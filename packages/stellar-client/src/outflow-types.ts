// The normalized shape of what the chain did to the pool, and of every way the question can fail to be answered.
//
// SDK-free on purpose: @troia/backend judges these and must not learn what an ScVal is, exactly as it never learns
// what a Buffer is. The adapter decodes, classifies and normalizes; the pure workers only decide.
//
// One page carries THREE things, because one scan of the token contract and the pool answers three questions:
//
//   outflows    — USDC left the pool. Whoever moved it, however they moved it. The rogue-payout detector's input.
//   settlements — the pool ANNOUNCED a settlement (`payment_made`), indexed by the tx_id we derived from the
//                 order. This is the reconciler's independent chain read: it finds a settlement by the order's
//                 identifier, not by the transaction hash we happen to have recorded — which is the only way a
//                 DIFFERENT transaction settling our order can ever be noticed.
//   upgrades    — the pool's code was replaced. After that, `payment_made` means whatever the new code says it
//                 means, and every settlement claim it makes is unverified. This is not a detail; it is the one
//                 event that invalidates the reconciler's entire premise, so it is carried and it is alarmed.
//
// WHY A THREE-WAY OUTCOME. A tail that cannot see must never look like a tail that saw nothing:
//
//   PAGE                   — we looked, and here is what was there.
//   CURSOR_BELOW_RETENTION — the RPC's event window scrolled past our checkpoint while we were away. Those events
//                            can NEVER be fetched again, by anyone. A permanent blind spot, said out loud rather
//                            than resumed quietly at head as if coverage were unbroken.
//   RPC_UNAVAILABLE        — we could not look. Not a blind spot (the events are still there), not a clean scan.
//                            Do not advance, do not accuse, and do not go quiet if it persists.

/** One USDC transfer OUT of the pool, whoever moved it. */
export interface OutflowEvent {
  /** The enclosing transaction's hash — the join key against the write-ahead journal of what we authorized. */
  readonly txHash: string;
  readonly ledger: number;
  /** Ledger CLOSE time, not wall clock. Grace is measured on chain time so local skew can never accuse anyone. */
  readonly ledgerCloseUnix: number;
  /** Where the USDC went. Attribution only — never part of the authorization verdict. */
  readonly to: string;
  readonly amountStroops: bigint;
}

/**
 * The pool's own announcement that it settled an order, decoded from `payment_made`.
 *
 * Every field the reconciler's chain snapshot needs is here. Seven come from the event; `sourceAccount` comes
 * from the enclosing transaction's envelope, because the event does not carry it. An observation is only ever
 * emitted COMPLETE — a half-decoded one would compare unequal against our signed transaction and manufacture a
 * divergence alarm on a perfectly good payout.
 */
export interface SettlementObservation {
  /** The contract's indexed topic: deriveIds(orderId).txIdHex. How an ORDER finds its settlement on chain. */
  readonly txIdHex: string;
  readonly txHash: string;
  readonly ledger: number;
  readonly ledgerCloseUnix: number;
  readonly contractId: string;
  readonly sourceAccount: string;
  readonly merchant: string;
  readonly amountStroops: bigint;
  readonly appliedRateStroops: bigint;
  readonly memoHex: string;
}

/** The pool's code was replaced. Everything it says about itself afterwards is a claim, not a proof. */
export interface PoolUpgrade {
  readonly txHash: string;
  readonly ledger: number;
  readonly ledgerCloseUnix: number;
}

/** Resume from a checkpoint, or anchor a cold start at a ledger. The RPC rejects both together. */
export type PoolFetch = { readonly cursor: string } | { readonly startLedger: number };

export type PoolActivityPage =
  | {
      readonly kind: 'PAGE';
      readonly outflows: readonly OutflowEvent[];
      readonly settlements: readonly SettlementObservation[];
      readonly upgrades: readonly PoolUpgrade[];
      /** Advances even across ledgers with no events, so a quiet chain still makes durable forward progress. */
      readonly cursor: string;
      readonly latestLedger: number;
      readonly latestLedgerCloseUnix: number;
      /** The retention floor, read from the response — never a hardcoded window, never a parsed error string. */
      readonly oldestLedger: number;
    }
  | {
      readonly kind: 'CURSOR_BELOW_RETENTION';
      readonly cursorLedger: number;
      readonly oldestLedger: number;
      readonly latestLedger: number;
    }
  | { readonly kind: 'RPC_UNAVAILABLE'; readonly reason: string };

/** Injected into the pure workers. One method: ask the chain what happened to the pool since `req`. */
export interface PoolTailPort {
  fetchPoolActivity(req: PoolFetch): Promise<PoolActivityPage>;
  latestLedger(): Promise<number>;
}

/** Is this transaction still on chain, successful, at the ledger we remember? The reconciler's freshness check:
 *  a durable local observation outlives the chain it describes, and a testnet reset must not read as MATCHED. */
export type TxLiveness =
  | { readonly kind: 'SUCCESS'; readonly ledger: number }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'UNKNOWN'; readonly reason: string };

/** A cursor is a TOID: `<ledger << 32 | txIndex << 12 | opIndex>-<n>`. Only the ledger half is ever needed, and
 *  it is read structurally rather than parsed out of an error message. */
export function cursorLedger(cursor: string): number {
  const toid = cursor.split('-')[0];
  if (toid === undefined || !/^[0-9]+$/.test(toid)) {
    throw new RangeError(`not a TOID cursor: ${cursor}`);
  }
  return Number(BigInt(toid) >> 32n);
}
