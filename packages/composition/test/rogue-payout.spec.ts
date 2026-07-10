import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailOutflows, toidAtLedger } from '@troia/backend';
import type { OutflowTickReport } from '@troia/backend';
import type { OutflowEvent, PoolActivityPage, PoolFetch } from '@troia/stellar-client';
import { FileWriteAheadJournal } from '../src/file-journal.js';
import { FileCursorStore, FileSuspectStore } from '../src/outflow-stores.js';
import { FileChainObservationStore } from '../src/chain-observations.js';
import { FileAppendLog } from '../src/file-append-log.js';

// The whole point of step 3, end to end, over real files.
//
// The hole every proposed design fell into: USDC leaves the pool the moment pay() closes a ledger, but the
// evidence row that says "we did that" is only written later, when the poll worker observes the landing. Crash in
// between and, after a restart, a real customer payout looks exactly like a theft — the order registry was in
// memory and died with the process.
//
// The fix is not a grace period. It is that the write-ahead journal records the transaction hash BEFORE the
// transaction is broadcast, and does so durably. A transaction cannot land unless its hash is already on disk.
// So the question "did we authorize this outflow?" has an answer that no crash can erase.

const OURS = '1'.repeat(64);
const THIEF = '9'.repeat(64);
const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const GRACE = 60;
const XDR = 'AAAAAgAAAAA=';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-rogue-'));
}

function outflow(txHash: string, closeUnix: number): OutflowEvent {
  return {
    txHash,
    ledger: 3_507_252,
    ledgerCloseUnix: closeUnix,
    to: MERCHANT,
    amountStroops: 74_0000000n,
  };
}

/** A tail that serves one scripted page, then nothing. */
function scriptedTail(events: readonly OutflowEvent[], latestCloseUnix: number) {
  let served = false;
  return {
    fetchPoolActivity: async (_req: PoolFetch): Promise<PoolActivityPage> => {
      const page: PoolActivityPage = {
        kind: 'PAGE',
        outflows: served ? [] : events,
        settlements: [],
        upgrades: [],
        cursor: toidAtLedger(3_507_260),
        latestLedger: 3_507_261,
        latestLedgerCloseUnix: latestCloseUnix,
        oldestLedger: 3_400_000,
      };
      served = true;
      return page;
    },
    latestLedger: async (): Promise<number> => 3_507_261,
  };
}

/** Everything the tick needs, rebuilt from `dir` the way a process restart would rebuild it. */
function boot(dir: string, events: readonly OutflowEvent[], nowCloseUnix: number) {
  const journal = new FileWriteAheadJournal(dir);
  return {
    journal,
    deps: {
      tail: scriptedTail(events, nowCloseUnix),
      cursor: new FileCursorStore(dir),
      suspects: new FileSuspectStore(dir),
      observations: new FileChainObservationStore(dir),
      authorized: journal.authorizedTxHashes(),
      graceSecs: GRACE,
      coldStartMarginLedgers: 60,
      nowUnix: (): number => nowCloseUnix,
    },
  };
}

describe('the rogue-payout alarm, end to end', () => {
  it('NEVER accuses a payout we authorized — not even one that landed while the process was dead', async () => {
    const dir = tmp();

    // --- life 1: we record the hash, broadcast, and die before the poll worker ever witnesses the landing ---
    const first = new FileWriteAheadJournal(dir);
    await first.persistPreSubmit('order-1', '1001', OURS, XDR);
    // (no evidence row is ever written; the order registry was in memory and is gone)

    // --- life 2: a restart. The chain shows the outflow; the journal remembers authorizing it. ---
    const { deps } = boot(dir, [outflow(OURS, 1000)], 1000 + GRACE * 100); // long past any grace
    const r = (await tailOutflows(deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;

    expect(r.kind).toBe('scanned');
    expect(r.rogue).toEqual([]);
    expect(r.newSuspects).toBe(0);
    expect(new FileSuspectStore(dir).all()).toEqual([]); // nobody was ever suspected
  });

  it('accuses an outflow whose hash was never written before broadcast — and names it', async () => {
    const dir = tmp();
    const journal = new FileWriteAheadJournal(dir);
    await journal.persistPreSubmit('order-1', '1001', OURS, XDR); // one legitimate payout

    // the thief's transaction is on chain, alongside ours, and was never journaled
    const { deps } = boot(dir, [outflow(OURS, 1000), outflow(THIEF, 1000)], 1000 + GRACE);
    const r = (await tailOutflows(deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;

    expect(r.outflows).toBe(2);
    expect(r.rogue).toHaveLength(1);
    expect(r.rogue[0]?.txHash).toBe(THIEF);
    expect(r.rogue[0]?.to).toBe(MERCHANT);
    expect(r.rogue[0]?.amountStroops).toBe(74_0000000n);
  });

  it('a theft is not forgotten by a restart, and is not paged twice', async () => {
    const dir = tmp();

    // life 1: the outflow is seen inside grace, so it is only recorded — and the checkpoint moves past its page
    const one = boot(dir, [outflow(THIEF, 1000)], 1000 + GRACE - 1);
    const r1 = (await tailOutflows(one.deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;
    expect(r1.rogue).toEqual([]);
    expect(r1.newSuspects).toBe(1);
    const checkpoint = new FileCursorStore(dir).load();
    expect(checkpoint).not.toBeNull(); // the cursor advanced past the ledger that carried the theft

    // --- crash. The event is now behind the cursor and can never be fetched again. ---

    // life 2: the tail sees nothing new, but the suspect is on disk with its original chain-time clock
    const two = boot(dir, [], 1000 + GRACE);
    const r2 = (await tailOutflows(two.deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;
    expect(r2.outflows).toBe(0);
    expect(r2.rogue).toHaveLength(1); // escalated on the clock it kept
    expect(r2.rogue[0]?.txHash).toBe(THIEF);

    // life 3: still standing, still unauthorized — and never paged again
    const three = boot(dir, [], 9_999_999);
    const r3 = (await tailOutflows(three.deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;
    expect(r3.rogue).toEqual([]);
    expect(r3.pending).toBe(1);
  });

  it('a suspect opened before we recognised our own transaction is cleared, not accused', async () => {
    const dir = tmp();

    // an outflow arrives that the journal (somehow) does not yet know about
    const one = boot(dir, [outflow(OURS, 1000)], 1000);
    await tailOutflows(one.deps);
    expect(new FileSuspectStore(dir).all()).toHaveLength(1);

    // the journal now vouches for it — the journal is the authority, not our earlier reading
    const j = new FileWriteAheadJournal(dir);
    await j.persistPreSubmit('order-1', '1001', OURS, XDR);

    const two = boot(dir, [], 9_999_999);
    const r = (await tailOutflows(two.deps)) as Extract<OutflowTickReport, { kind: 'scanned' }>;
    expect(r.rogue).toEqual([]);
    expect(r.cleared).toBe(1);
    expect(new FileSuspectStore(dir).all()).toEqual([]);
  });
});

describe('the coverage floor, over real files', () => {
  it('survives a restart, so a fresh process does not re-declare its knowledge older than it is', () => {
    const dir = tmp();
    new FileChainObservationStore(dir).recordCoverageStart(1_700_000_000);
    expect(new FileChainObservationStore(dir).coverageStartUnix()).toBe(1_700_000_000);
  });

  it('replays to the LATEST floor even from a log whose records are out of order', () => {
    // The correctness guard is the max fold, so prove it where a max is the only thing that can save you: a log
    // that already contains an older record AFTER a newer one. Written straight to the file, past the writer.
    const dir = tmp();
    const raw = new FileAppendLog(dir, 'chain-observations.log');
    raw.append(JSON.stringify({ v: 1, t: 'cov', unix: 1_700_000_000 }));
    raw.append(JSON.stringify({ v: 1, t: 'cov', unix: 1_600_000_000 }));
    expect(new FileChainObservationStore(dir).coverageStartUnix()).toBe(1_700_000_000);
  });

  it('does not append a floor it already knows — an equal or older claim writes nothing', () => {
    const dir = tmp();
    const s = new FileChainObservationStore(dir);
    s.recordCoverageStart(1_700_000_000);
    const after = () => readFileSync(join(dir, 'chain-observations.log')).length;
    const bytes = after();
    s.recordCoverageStart(1_700_000_000); // equal
    s.recordCoverageStart(1_600_000_000); // older
    expect(after()).toBe(bytes);
    expect(s.coverageStartUnix()).toBe(1_700_000_000);
  });

  it('moves forward, and the forward move is what a retention re-anchor persists', () => {
    const dir = tmp();
    const s = new FileChainObservationStore(dir);
    s.recordCoverageStart(1_700_000_000);
    s.recordCoverageStart(1_800_000_000);
    expect(new FileChainObservationStore(dir).coverageStartUnix()).toBe(1_800_000_000);
  });

  it('a cold-started tail leaves its floor on disk, next to the observations it made', async () => {
    const dir = tmp();
    const { deps } = boot(dir, [], 1_000);
    await tailOutflows(deps);
    expect(deps.observations.coverageStartUnix()).toBe(1_000);
    expect(new FileChainObservationStore(dir).coverageStartUnix()).toBe(1_000);
  });
});
