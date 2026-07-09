import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore, encodeEvidenceRow } from '@troia/backend';
import type { EvidenceRecord, OrderFacts } from '@troia/backend';
import { LedgerError } from '@troia/ledger';
import { buildDurableBundle } from '../src/durable-bundle.js';
import { FileAppendLog } from '../src/file-append-log.js';

const FACTS: OrderFacts = {
  destination: 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000',
  amountStroops: 1_000_000_000n,
  memoHex: 'ab'.repeat(32),
  appliedRateStroops: 340_000_000n,
  paidPriceTry: '3400.00',
  spreadKurus: 5_000n,
  feeKurus: 2_000n,
};

// A restart, simulated: build the bundle, book money and witness a payout, drop every object on the floor, then
// build a second bundle over the SAME directory. What must come back is the ledger's expected pool balance (the
// baseline the drift alarm compares against the chain) and the set of payouts we authorized.

const STROOP = 10_000_000n;
const REC: EvidenceRecord = {
  txHash: 'a'.repeat(64),
  signedXdr: 'AAAAAg==',
  seq: '1001',
  witnessedAtUnix: 1_700_000_000,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-bundle-'));
}

/** One process lifetime: book a genesis top-up, settle an order, witness its payout. */
async function livePass(dir: string): Promise<{ expectedPool: bigint }> {
  const b = buildDurableBundle(dir);
  b.ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 4_050_000n });
  b.ledger.recordSettlement({
    orderId: 'o1',
    usdcStroops: 10n * STROOP,
    userTryKurus: 405_000n,
    spreadKurus: 5_000n,
  });
  const store = new InMemoryStore({
    balanceStroops: 1000n * STROOP,
    baseSeq: 1000n,
    evidenceLog: b.evidenceLog,
    seedEvidence: b.seedEvidence,
  });
  await store.appendEvidence('o1', REC, FACTS);
  return { expectedPool: b.ledger.nativeBalance('USDC_POOL') };
}

describe('buildDurableBundle — the state that survives a restart', () => {
  it('restores the drift baseline and the authorized-payout set after a simulated restart', async () => {
    const dir = tmp();
    const { expectedPool } = await livePass(dir);
    expect(expectedPool).toBe(990n * STROOP); // 1000 in, 10 out

    // --- process dies here; nothing in memory survives ---

    const revived = buildDurableBundle(dir);
    expect(revived.warnings).toEqual([]);
    expect(revived.ledger.nativeBalance('USDC_POOL')).toBe(expectedPool);
    expect(revived.ledger.detectDrift(expectedPool).inSync).toBe(true);
    // and a real shortfall on chain is still seen, which is the whole point of persisting the baseline
    expect(revived.ledger.detectDrift(expectedPool - STROOP).driftStroops).toBe(-STROOP);

    expect(revived.seedEvidence).toEqual([{ orderId: 'o1', record: REC, order: FACTS }]);

    // the revived ledger keeps numbering where the file left off, and still refuses a replayed ref
    expect(revived.ledger.all().map((e) => e.seq)).toEqual([0, 1]);
    expect(() =>
      revived.ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1n, valueKurus: 1n }),
    ).toThrow(expect.objectContaining({ code: 'DuplicateRef' }));
  });

  it('the second process appends to the same journal rather than starting a new one', async () => {
    const dir = tmp();
    await livePass(dir);
    const revived = buildDurableBundle(dir);
    revived.ledger.recordTopUp({
      ref: 'topup:o1',
      usdcStroops: 10n * STROOP,
      valueKurus: 405_000n,
    });

    const third = buildDurableBundle(dir);
    expect(third.ledger.all()).toHaveLength(3);
    expect(third.ledger.nativeBalance('USDC_POOL')).toBe(1000n * STROOP);
  });

  it('a duplicated evidence row — the crash-between-append-and-push artifact — folds instead of failing closed', async () => {
    const dir = tmp();
    await livePass(dir);
    // the recovery worker re-drove the order and appended the identical witness a second time
    const log = new FileAppendLog(dir, 'evidence.log');
    log.append(encodeEvidenceRow({ orderId: 'o1', record: REC, order: FACTS }));
    log.close();

    const revived = buildDurableBundle(dir);
    expect(revived.seedEvidence).toEqual([{ orderId: 'o1', record: REC, order: FACTS }]); // folded to one
    expect(revived.warnings).toEqual([]);
  });

  it('a torn tail in the journal is healed and REPORTED, never silently swallowed', async () => {
    const dir = tmp();
    await livePass(dir);
    appendFileSync(join(dir, 'ledger-journal.log'), 'L40,deadbeef|{"v":1,"seq":2'); // crashed mid-append

    const revived = buildDurableBundle(dir);
    expect(revived.warnings).toHaveLength(1);
    expect(revived.warnings[0]).toContain('ledger-journal.log');
    expect(revived.warnings[0]).toContain('torn tail');
    expect(revived.ledger.all()).toHaveLength(2); // the unbooked entry is simply not there
  });

  it('a corrupt journal aborts the boot — a renumbered ledger is worse than no ledger', async () => {
    const dir = tmp();
    await livePass(dir);
    const path = join(dir, 'ledger-journal.log');
    const buf = readFileSync(path);
    const at = buf.indexOf(Buffer.from('genesis'));
    buf[at] = 'G'.charCodeAt(0); // a terminated record that no longer verifies
    writeFileSync(path, buf);

    expect(() => buildDurableBundle(dir)).toThrow(/corrupt record/i);
  });

  it('a journal record that breaks the double-entry laws aborts the boot', () => {
    const dir = tmp();
    const log = new FileAppendLog(dir, 'ledger-journal.log');
    log.append(
      JSON.stringify({
        v: 1,
        seq: 0,
        ref: 'forged',
        kind: 'TOPUP',
        debits: [{ account: 'USDC_POOL', native: '100', kurus: '100' }],
        credits: [{ account: 'EXTERNAL_FUNDING', native: '1', kurus: '1' }], // unbalanced
      }),
    );
    log.close();
    expect(() => buildDurableBundle(dir)).toThrow(LedgerError);
  });
});
