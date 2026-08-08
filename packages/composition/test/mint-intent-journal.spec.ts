// The durable half of A-2: the mint intent must survive the crash it exists to witness. Two journals over
// the same file are two process lives; what one leaves open, the next must refuse to mint.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOrderDb } from '../src/order-db.js';
import { SqliteMintIntentJournal } from '../src/mint-intent-journal.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-mintwal-'));
}

describe('SqliteMintIntentJournal', () => {
  it('an intent opened and never closed BLOCKS the ref in the next life, and is reported at boot', () => {
    const dir = tmp();
    const life1 = new SqliteMintIntentJournal(openOrderDb(dir));
    life1.open('topup:o-1');
    // CRASH between the mint and its booking.
    const life2 = new SqliteMintIntentJournal(openOrderDb(dir));
    expect(life2.unresolvedAtBoot()).toEqual(['topup:o-1']);
    expect(life2.isBlocked('topup:o-1')).toBe(true);
    expect(life2.isBlocked('topup:o-2')).toBe(false);
  });

  it('an intent closed in its own life blocks nothing later (the clean path leaves no residue)', () => {
    const dir = tmp();
    const life1 = new SqliteMintIntentJournal(openOrderDb(dir));
    life1.open('topup:o-1');
    life1.close('topup:o-1');
    const life2 = new SqliteMintIntentJournal(openOrderDb(dir));
    expect(life2.unresolvedAtBoot()).toEqual([]);
    expect(life2.isBlocked('topup:o-1')).toBe(false);
  });

  it('a SAME-life re-open is allowed (clean retry); a blocked ref refuses to be re-opened', () => {
    const dir = tmp();
    const life1 = new SqliteMintIntentJournal(openOrderDb(dir));
    life1.open('topup:o-1');
    expect(() => life1.open('topup:o-1')).not.toThrow(); // same life: the retry path
    const life2 = new SqliteMintIntentJournal(openOrderDb(dir));
    expect(() => life2.open('topup:o-1')).toThrow(/previous life/); // never silently unblock
  });

  it("close() resolves ANY life's intent — the ledger answered, the question is gone", () => {
    const dir = tmp();
    const life1 = new SqliteMintIntentJournal(openOrderDb(dir));
    life1.open('topup:o-1');
    const life2 = new SqliteMintIntentJournal(openOrderDb(dir));
    life2.close('topup:o-1'); // hasRef said "already booked" -> the worker tidies the stale intent
    expect(life2.isBlocked('topup:o-1')).toBe(false);
    const life3 = new SqliteMintIntentJournal(openOrderDb(dir));
    expect(life3.unresolvedAtBoot()).toEqual([]);
  });
});
