// The durable mint write-ahead journal (A-2 / KNOWN_ISSUES §2), over the same SQLite file as the order rows.
// One row per unresolved question: "I was about to mint <ref> — did it land?". The settlement worker writes it
// BEFORE `topUp` and clears it after `recordTopUp`, so the crash window between the mint landing and its
// booking is no longer invisible: the next life finds the open row and refuses to mint that ref again.
//
// The boot_id column is what separates "a clean same-life retry" from "an unresolved previous life". Within
// one process the rebalance provider's per-ref idempotency makes a retry safe, so a same-life open row does
// not block. A row stamped by ANOTHER life blocks: nobody in this process can know whether that mint landed,
// and guessing is exactly the double-spend the journal exists to prevent.

import { randomUUID } from 'node:crypto';
import type { MintIntentJournal } from '@troia/backend';
import type { OrderDb } from './order-db.js';

export class SqliteMintIntentJournal implements MintIntentJournal {
  private readonly bootId = randomUUID();

  constructor(private readonly db: OrderDb) {}

  /** Refs left open by previous lives — the composition root logs these at boot so an operator knows a mint
   *  needs reconciling BEFORE the settle tick starts refusing it. */
  unresolvedAtBoot(): readonly string[] {
    return this.db
      .all('SELECT ref FROM mint_intents WHERE boot_id != ?', this.bootId)
      .map((r) => r.ref as string);
  }

  isBlocked(ref: string): boolean {
    const row = this.db.get('SELECT boot_id FROM mint_intents WHERE ref = ?', ref);
    return row !== undefined && row.boot_id !== this.bootId;
  }

  /** Durable write-ahead. Refuses to overwrite ANOTHER life's open intent — that would silently unblock a
   *  possibly-minted ref; the worker must resolve it via isBlocked/close, never by re-opening. */
  open(ref: string): void {
    const changes = this.db.run(
      `INSERT INTO mint_intents (ref, boot_id, opened_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (ref) DO UPDATE SET opened_at_ms = excluded.opened_at_ms
       WHERE mint_intents.boot_id = excluded.boot_id`,
      ref,
      this.bootId,
      Date.now(),
    );
    if (changes === 0) {
      throw new Error(
        `mint intent for ${ref} is open from a previous life — refusing to overwrite an unresolved mint`,
      );
    }
  }

  /** The booking landed (or was found already booked): the question is answered. Idempotent, and deliberately
   *  allowed to clear ANY life's row — resolution comes from the durable ledger's hasRef, not from us. */
  close(ref: string): void {
    this.db.run('DELETE FROM mint_intents WHERE ref = ?', ref);
  }
}
