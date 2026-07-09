import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDurableLogFailure } from '@troia/backend';
import { FileWriteAheadJournal } from '../src/file-journal.js';
import { FileAppendLog } from '../src/file-append-log.js';

// The write-ahead journal is what makes the rogue-payout alarm trustworthy.
//
// `client.submitPay` awaits persistPreSubmit STRICTLY BEFORE it broadcasts the transaction. Make that write
// durable and the following becomes a fact of physics rather than a matter of timing: a pay() transaction cannot
// land on chain unless its hash reached stable storage first. So an outflow whose transaction hash is missing
// from this journal was never authorized by us — no grace period, no in-flight allowlist, no restart window.
//
// The set therefore has to contain EVERY hash ever submitted for an order, not just the latest: a same-sequence
// replacement produces a new hash, and either the old or the new one may be the one that lands.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-wal-'));
}

const XDR = 'AAAAAgAAAAA=';

describe('FileWriteAheadJournal', () => {
  it('records a submitted hash before returning, and answers the authorization question', async () => {
    const dir = tmp();
    const j = new FileWriteAheadJournal(dir);
    await j.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);

    expect(j.authorizedTxHashes().has('aa'.repeat(32))).toBe(true);
    expect(j.authorizedTxHashes().has('bb'.repeat(32))).toBe(false);
    expect(await j.loadPersisted('o1')).toEqual({ hashHex: 'aa'.repeat(32), signedXdr: XDR });
    expect(await j.loadPersisted('nope')).toBeNull();
  });

  it('survives a restart: the authorized set is rebuilt from disk', async () => {
    const dir = tmp();
    const first = new FileWriteAheadJournal(dir);
    await first.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);
    await first.persistPreSubmit('o2', '1002', 'bb'.repeat(32), XDR);

    // --- the process dies, having broadcast neither, one, or both. The journal does not care. ---
    const revived = new FileWriteAheadJournal(dir);
    expect([...revived.authorizedTxHashes()].sort()).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    expect(await revived.loadPersisted('o2')).toEqual({ hashHex: 'bb'.repeat(32), signedXdr: XDR });
  });

  it('keeps EVERY hash an order ever submitted — a replacement does not retract its predecessor', async () => {
    const dir = tmp();
    const j = new FileWriteAheadJournal(dir);
    await j.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);
    // a same-seq replacement with fresh timebounds: a new hash, and EITHER may be the one that lands
    await j.persistPreSubmit('o1', '1001', 'cc'.repeat(32), 'AAAAAgAAAAB=');

    const hashes = new FileWriteAheadJournal(dir).authorizedTxHashes();
    expect(hashes.has('aa'.repeat(32))).toBe(true); // the superseded attempt is still authorized by us
    expect(hashes.has('cc'.repeat(32))).toBe(true);
    // but a resend replays the LATEST envelope, never the stale one
    expect(await j.loadPersisted('o1')).toEqual({
      hashHex: 'cc'.repeat(32),
      signedXdr: 'AAAAAgAAAAB=',
    });
  });

  it('the durable write happens BEFORE the hash is visible in memory — nothing is authorized that is not on disk', async () => {
    const dir = tmp();
    const seen: boolean[] = [];
    const j = new FileWriteAheadJournal(dir);
    // intercept the log to observe the in-memory set at the moment of the write
    const log = (j as unknown as { log: FileAppendLog }).log;
    const realAppend = log.append.bind(log);
    log.append = (p: string): void => {
      seen.push(j.authorizedTxHashes().has('aa'.repeat(32)));
      realAppend(p);
    };
    await j.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);
    expect(seen).toEqual([false]); // not yet authorized when the bytes were written
    expect(j.authorizedTxHashes().has('aa'.repeat(32))).toBe(true);
  });

  it('a failing disk means the hash is NOT authorized and the caller must not broadcast', async () => {
    const dir = tmp();
    const j = new FileWriteAheadJournal(dir);
    const log = (j as unknown as { log: FileAppendLog }).log;
    log.append = (): never => {
      throw Object.assign(new Error('ENOSPC'), { code: 'DurableLogFailure' });
    };

    const err = await j
      .persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR)
      .catch((e: unknown) => e);
    expect(isDurableLogFailure(err)).toBe(true);
    expect(j.authorizedTxHashes().size).toBe(0);
    expect(await j.loadPersisted('o1')).toBeNull();
  });

  it('a torn tail is dropped and REPORTED — an unfinished write never broadcast anything', async () => {
    const dir = tmp();
    const first = new FileWriteAheadJournal(dir);
    await first.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);

    // A crash mid-append. Dropping it is not data loss: persistPreSubmit had not returned, so submitPay never
    // reached `send`, so that transaction was never broadcast and can never appear on chain.
    appendFileSync(join(dir, 'authorized.log'), 'L60,deadbeef|{"v":1,"orderId":"o2"');

    const revived = new FileWriteAheadJournal(dir);
    expect([...revived.authorizedTxHashes()]).toEqual(['aa'.repeat(32)]);
    expect(revived.warnings).toHaveLength(1);
    expect(revived.warnings[0]).toContain('never sent');
  });

  it('a corrupt record refuses to start — this journal decides who is accused of theft', async () => {
    const dir = tmp();
    const j = new FileWriteAheadJournal(dir);
    await j.persistPreSubmit('o1', '1001', 'aa'.repeat(32), XDR);

    const path = join(dir, 'authorized.log');
    const buf = readFileSync(path);
    const at = buf.indexOf(Buffer.from('aaaa'));
    buf[at] = 'b'.charCodeAt(0); // a terminated record whose payload no longer verifies
    writeFileSync(path, buf);

    expect(() => new FileWriteAheadJournal(dir)).toThrow(/corrupt record/i);
  });
});
