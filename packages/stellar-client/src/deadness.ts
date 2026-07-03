// PURE deadness truth table — the single fail-closed oracle for "may we reuse this sequence?". It never
// does I/O: it consumes already-fetched authoritative reads (on-chain account seq, ledger-derived expiry,
// hash lookup) and returns a verdict. Semantics follow the @troia/core SequenceAllocator, NOT the informal
// "expired AND burned" phrasing: a SAFE_TO_REPLACE requires the seq to be UNBURNED. A burned seq whose tx
// is not a proven success is LOSS_REVIEW — never replaced, because the burn may have moved money.

import type { Deadness, PollVerdict } from './outcomes.js';

export interface DeadnessInputs {
  /** the operator account's on-chain stored sequence (authoritative). Only meaningful when seqKnown. */
  readonly accountSeq: bigint;
  /** OUR tx's sequence number (the value the tx was built with). */
  readonly ourSeq: bigint;
  /** derived from ledger close time vs the tx maxTime — NEVER from a local clock. */
  readonly timeboundsExpired: boolean;
  /** the on-chain fate of OUR hash: a proven SUCCESS dominates everything. */
  readonly hashLookup: 'SUCCESS' | 'NOT_FOUND';
  /** false when the operator account sequence could NOT be read authoritatively (e.g. an anomalous empty
   *  RPC response). An unprovable seq can never be certified UNBURNED, so it must fail closed. */
  readonly seqKnown: boolean;
}

/**
 * The truth table (with dominance rules). Fail-CLOSED: an unresolvable seq read never yields a reuse.
 *   - hashLookup SUCCESS                      -> CONFIRMED       (our tx landed; dominates seq/expiry)
 *   - !seqKnown (unresolvable read), !SUCCESS -> LOSS_REVIEW     (cannot certify unburned — never reuse)
 *   - burned (accountSeq >= ourSeq), !SUCCESS -> LOSS_REVIEW     (a tx consumed our slot; may have paid — never reuse)
 *   - unburned & timeboundsExpired            -> SAFE_TO_REPLACE (provably can never be included; same-seq new-tb ok)
 *   - unburned & !timeboundsExpired           -> WAIT            (could still land; observe, never advance)
 */
export function resolveDeadness(i: DeadnessInputs): Deadness {
  if (i.hashLookup === 'SUCCESS') return 'CONFIRMED';
  if (!i.seqKnown) return 'LOSS_REVIEW';
  const burned = i.accountSeq >= i.ourSeq;
  if (burned) return 'LOSS_REVIEW';
  if (i.timeboundsExpired) return 'SAFE_TO_REPLACE';
  return 'WAIT';
}

/** Map a deadness verdict onto the on-chain fate vocabulary the submit loop reports upward. */
export function deadnessToVerdict(d: Deadness): PollVerdict {
  switch (d) {
    case 'CONFIRMED':
      return 'LANDED_SUCCESS';
    case 'SAFE_TO_REPLACE':
      return 'DEAD_REPLACEABLE';
    case 'WAIT':
      return 'STILL_PENDING';
    case 'LOSS_REVIEW':
      return 'INDETERMINATE_LOSS_REVIEW';
  }
}
