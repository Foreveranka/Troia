// Boot-time assembly of everything that must survive a restart. Two append-only files, two replays, and the
// asymmetry between them — which is the interesting part:
//
//   ledger-journal.log  is the accounting truth. It replays FAIL-CLOSED: a seq gap, a reorder, a duplicate ref
//                       or a record that breaks the double-entry laws aborts the boot. A synchronous single
//                       writer cannot legitimately produce any of those, so their presence means corruption.
//                       Skipping a record would renumber every later entry into a silently different ledger —
//                       and that ledger is the baseline `detectDrift` weighs against the on-chain pool balance.
//
//   evidence.log        is a membership set: "did I authorize this payout?" It replays TOLERANTLY. A crash
//                       between the durable append and the in-memory push leaves the row on disk and the
//                       recovery worker re-drives the order and appends it again. That duplicate is a known,
//                       benign artifact of at-least-once delivery, so replay folds it rather than refusing to
//                       start. Failing closed here would turn a harmless retry into an outage.
//
// Neither log seeds the pool balance or the reservation ledger: the on-chain read stays the solvency source of
// truth, and reserve() is not touched by any of this.

import { Ledger, decodeJournalEntry } from '@troia/ledger';
import { dedupeEvidence, decodeEvidenceRow } from '@troia/backend';
import type { DurableLog, EvidenceRow } from '@troia/backend';
import { FileAppendLog, assertWritableDir } from './file-append-log.js';

const JOURNAL_FILE = 'ledger-journal.log';
const EVIDENCE_FILE = 'evidence.log';

export interface DurableBundle {
  /** Hydrated from the journal and wired to write through it on every future post(). */
  readonly ledger: Ledger;
  /** Injected into the Store so appendEvidence writes through it. */
  readonly evidenceLog: DurableLog;
  /** Rows recovered from the evidence log, deduped. Seeded into the Store by copy, never re-appended. */
  readonly seedEvidence: readonly EvidenceRow[];
  /** Torn tails that were healed. The caller MUST surface these — a silent data loss is not a recovery. */
  readonly warnings: readonly string[];
}

/** Throws (and so fails the boot) on an unusable data dir or a corrupt journal. That is the point: the
 *  alternative is discovering a read-only disk inside the effect that runs AFTER the USDC has left the pool. */
export function buildDurableBundle(dataDir: string): DurableBundle {
  assertWritableDir(dataDir);
  const warnings: string[] = [];

  const journalFile = new FileAppendLog(dataDir, JOURNAL_FILE);
  const journal = journalFile.replay();
  if (journal.recovered !== null) {
    warnings.push(
      `${JOURNAL_FILE}: dropped a torn tail of ${journal.recovered.droppedBytes} bytes at offset ` +
        `${journal.recovered.atOffset} — an entry was mid-append when the process died and was never booked`,
    );
  }

  const evidenceFile = new FileAppendLog(dataDir, EVIDENCE_FILE);
  const evidence = evidenceFile.replay();
  if (evidence.recovered !== null) {
    warnings.push(
      `${EVIDENCE_FILE}: dropped a torn tail of ${evidence.recovered.droppedBytes} bytes at offset ` +
        `${evidence.recovered.atOffset} — a payout witness was mid-append when the process died`,
    );
  }

  const ledger = new Ledger(journalFile);
  ledger.hydrate(journal.payloads.map(decodeJournalEntry));

  return {
    ledger,
    evidenceLog: evidenceFile,
    seedEvidence: dedupeEvidence(evidence.payloads.map(decodeEvidenceRow)),
    warnings,
  };
}
