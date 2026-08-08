// The durable Store's contract (A-1), proven the only way that matters: build a store, do money-relevant work,
// drop every object on the floor, open a SECOND store over the SAME file, and check the second one remembers.
// Every "survives a restart" test here is a row KNOWN_ISSUES §1 listed as deliberately volatile in the PoC.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupeEvidence, decodeEvidenceRow, isDurableLogFailure } from '@troia/backend';
import type { EvidenceRecord, EvidenceRow, OrderFacts } from '@troia/backend';
import { FileAppendLog } from '../src/file-append-log.js';
import { openOrderDb } from '../src/order-db.js';
import type { OrderDb } from '../src/order-db.js';
import { SqliteOrderStore } from '../src/sqlite-order-store.js';

const BALANCE = 1_000n * 10_000_000n; // 1000 USDC in stroops
const TTL_MS = 60_000;
const NOW_MS = 1_700_000_000_000;

const FACTS: OrderFacts = {
  destination: 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000',
  amountStroops: 100n * 10_000_000n,
  memoHex: 'ab'.repeat(32),
  appliedRateStroops: 340_000_000n,
  paidPriceTry: '3400.00',
  spreadKurus: 5_000n,
  feeKurus: 2_000n,
};

const REC: EvidenceRecord = {
  txHash: 'a'.repeat(64),
  signedXdr: 'AAAAAg==',
  seq: '1001',
  witnessedAtUnix: 1_700_000_000,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-orderdb-'));
}

interface Opened {
  db: OrderDb;
  store: SqliteOrderStore;
}

/** One process lifetime over `dir`. Pass seedEvidence to simulate the boot-time evidence replay. */
function open(dir: string, seedEvidence?: readonly EvidenceRow[]): Opened {
  const db = openOrderDb(dir);
  const store = new SqliteOrderStore({
    db,
    balanceStroops: BALANCE,
    baseSeq: 1000n,
    evidenceLog: new FileAppendLog(dir, 'evidence.log'),
    ...(seedEvidence !== undefined ? { seedEvidence } : {}),
  });
  return { db, store };
}

/** The real boot sequence for the evidence half: replay the file log, dedupe, seed the new store. */
function reopenWithEvidenceReplay(dir: string): Opened {
  const replayed = new FileAppendLog(dir, 'evidence.log').replay();
  return open(dir, dedupeEvidence(replayed.payloads.map(decodeEvidenceRow)));
}

describe('SqliteOrderStore — solvency reservations', () => {
  it('reserves, reports available, and fails closed when insufficient', async () => {
    const { store } = open(tmp());
    const r = await store.reserve('o-1', 400n * 10_000_000n, TTL_MS, NOW_MS);
    expect(r).toEqual({ kind: 'reserved', reservationId: 'res-o-1' });
    expect(store.availableStroops()).toBe(600n * 10_000_000n);

    const r2 = await store.reserve('o-2', 700n * 10_000_000n, TTL_MS, NOW_MS);
    expect(r2.kind).toBe('insufficient');
    if (r2.kind === 'insufficient') {
      expect(r2.available).toBe(600n * 10_000_000n);
      expect(r2.requested).toBe(700n * 10_000_000n);
    }
  });

  it('is idempotent per order, and fails closed on an amount mismatch', async () => {
    const { store } = open(tmp());
    await store.reserve('o-1', 100n, TTL_MS, NOW_MS);
    const again = await store.reserve('o-1', 100n, TTL_MS, NOW_MS);
    expect(again.kind).toBe('reserved');
    const mismatched = await store.reserve('o-1', 200n, TTL_MS, NOW_MS);
    expect(mismatched.kind).toBe('insufficient');
    expect(store.availableStroops()).toBe(BALANCE - 100n); // still exactly one hold
  });

  it('a held reservation SURVIVES a restart (fail-closed: capacity stays locked)', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.reserve('o-1', 400n * 10_000_000n, TTL_MS, NOW_MS);
    // no release, no settlement — the process "crashes" here
    const second = open(dir);
    expect(second.store.availableStroops()).toBe(600n * 10_000_000n);
    expect(second.store.bootReport().heldReservationsReplayed).toBe(1);
    // and the replayed hold is still idempotent for its own order
    const again = await second.store.reserve('o-1', 400n * 10_000_000n, TTL_MS, NOW_MS);
    expect(again).toEqual({ kind: 'reserved', reservationId: 'res-o-1' });
  });

  it('an explicit release frees capacity durably', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.reserve('o-1', 100n, TTL_MS, NOW_MS);
    await first.store.releaseReservation('o-1', 'abandoned');
    expect(open(dir).store.availableStroops()).toBe(BALANCE);
  });

  it('a settled reservation is NOT replayed (the fresh chain read already carries the debit)', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.reserve('o-1', 100n * 10_000_000n, TTL_MS, NOW_MS);
    await first.store.appendEvidence('o-1', REC, FACTS); // pay() landed -> hold marked settled
    // in-process the hold keeps counting, exactly like the in-memory rule
    expect(first.store.availableStroops()).toBe(BALANCE - 100n * 10_000_000n);
    // across a restart it must NOT be double-counted
    const second = reopenWithEvidenceReplay(dir);
    expect(second.store.availableStroops()).toBe(BALANCE);
    expect(second.store.bootReport().settledReservationsDropped).toBeGreaterThan(0);
  });

  it('sweeps the reservation even when the crash hit between the evidence append and the settled mark', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.reserve('o-1', 100n, TTL_MS, NOW_MS);
    // simulate the torn window: the evidence row reached the FILE log but the db mark never ran —
    // by seeding the reopened store with the replayed evidence while the reservation row is unsettled.
    new FileAppendLog(dir, 'evidence.log'); // (log exists; row arrives via seed below)
    const second = open(dir, [{ orderId: 'o-1', record: REC, order: FACTS }]);
    expect(second.store.availableStroops()).toBe(BALANCE);
  });

  it('creditPool raises available in-process and is deliberately NOT persisted', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.creditPool(50n);
    expect(first.store.availableStroops()).toBe(BALANCE + 50n);
    // the mint is on chain; the next boot's chain read carries it, so the db must not double it
    expect(open(dir).store.availableStroops()).toBe(BALANCE);
  });
});

describe('SqliteOrderStore — order rows, counters, dedup, quarantine', () => {
  it('createIfAbsent is created-once, and the once survives a restart', async () => {
    const dir = tmp();
    const first = open(dir);
    expect(await first.store.createIfAbsent('o-1')).toBe('created');
    expect(await first.store.createIfAbsent('o-1')).toBe('exists');
    // the crash-replayed /intent can no longer double-run the reserve->checkout bootstrap
    expect(await open(dir).store.createIfAbsent('o-1')).toBe('exists');
  });

  it('persistState + in-flight patch survive a restart, and fields never regress to null', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.createIfAbsent('o-1');
    await first.store.persistState('o-1', 'UsdcSubmitted', {
      seq: '1001',
      paymentId: 'pay-1',
      hashHex: 'ff'.repeat(32),
    });
    await first.store.persistState('o-1', 'UsdcSubmitted', {}); // a later persist with no patch
    const row = open(dir).store.orderRow('o-1');
    expect(row).toEqual({
      state: 'UsdcSubmitted',
      seq: '1001',
      paymentId: 'pay-1',
      hashHex: 'ff'.repeat(32),
    });
  });

  it('retry counters keep counting ACROSS a restart (the recovery budget no longer resets)', async () => {
    const dir = tmp();
    const first = open(dir);
    expect(await first.store.bumpDeadRetries('o-1')).toBe(1);
    expect(await first.store.bumpDeadRetries('o-1')).toBe(2);
    expect(await first.store.bumpRevertOtherRetries('o-1')).toBe(1);
    const second = open(dir);
    expect(await second.store.bumpDeadRetries('o-1')).toBe(3);
    expect(await second.store.bumpRevertOtherRetries('o-1')).toBe(2);
    expect(await second.store.bumpReversalRetries('o-1')).toBe(1);
  });

  it('webhook dedup survives a restart', async () => {
    const dir = tmp();
    const first = open(dir);
    expect(await first.store.markWebhookSeen('evt-1', 'o-1', NOW_MS)).toBe('first');
    expect(await first.store.markWebhookSeen('evt-1', 'o-1', NOW_MS)).toBe('duplicate');
    expect(await open(dir).store.markWebhookSeen('evt-1', 'o-1', NOW_MS)).toBe('duplicate');
  });

  it('loss flags are idempotent per (order, bucket), keep the first witness, and survive a restart', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.flagLoss('o-1', 'indeterminateLossReview', 'aa'.repeat(32));
    await first.store.flagLoss('o-1', 'indeterminateLossReview', null); // later, witness-less recovery call
    expect(first.store.isLossFlagged('o-1')).toBe(true);
    const second = open(dir);
    expect(second.store.isLossFlagged('o-1')).toBe(true); // the quarantine latch holds across the restart
    expect(second.store.isLossFlagged('o-2')).toBe(false);
  });

  it('evidence writes through the file log and answers settledEvidence/confirmedOrders after replay', async () => {
    const dir = tmp();
    const first = open(dir);
    await first.store.appendEvidence('o-1', REC, FACTS);
    const second = reopenWithEvidenceReplay(dir);
    expect(second.store.settledEvidence('o-1')?.record.txHash).toBe(REC.txHash);
    expect(second.store.confirmedOrders()).toHaveLength(1);
    expect(second.store.confirmedOrder('o-1')?.order.amountStroops).toBe(FACTS.amountStroops);
  });

  it('a database that refuses a write is poisoned with DurableLogFailure (fail-fast, never spin)', async () => {
    const { db, store } = open(tmp());
    db.close();
    await expect(store.createIfAbsent('o-1')).rejects.toSatisfy((e: unknown) =>
      isDurableLogFailure(e),
    );
  });
});

// Two OrderDb handles over the SAME file are two SQLite connections — exactly what two backend PROCESSES
// look like to the locking layer. These tests pin the §3 fix: the reserve CHECK -> COMMIT is one IMMEDIATE
// transaction, so a second instance can only wait its turn or fail fast — never interleave into over-commit.
describe('SqliteOrderStore — two instances over one file (KNOWN_ISSUES §3)', () => {
  function instance(dir: string, busyTimeoutMs?: number): SqliteOrderStore {
    return new SqliteOrderStore({
      db: openOrderDb(dir, busyTimeoutMs === undefined ? undefined : { busyTimeoutMs }),
      balanceStroops: BALANCE,
      baseSeq: 1000n,
    });
  }

  it("instance B's CHECK reads instance A's committed hold — the same last coin cannot be promised twice", async () => {
    const dir = tmp();
    const a = instance(dir);
    const b = instance(dir);
    expect((await a.reserve('o-a', 600n * 10_000_000n, TTL_MS, NOW_MS)).kind).toBe('reserved');
    const r = await b.reserve('o-b', 600n * 10_000_000n, TTL_MS, NOW_MS);
    expect(r.kind).toBe('insufficient');
    if (r.kind === 'insufficient') expect(r.available).toBe(400n * 10_000_000n);
    // and B can still take what genuinely remains
    expect((await b.reserve('o-c', 400n * 10_000_000n, TTL_MS, NOW_MS)).kind).toBe('reserved');
  });

  it('a competing writer HOLDS OUT instance B until it commits — B waits or fails fast, never interleaves', async () => {
    const dir = tmp();
    instance(dir); // create the schema first
    const b = instance(dir, 100); // 100ms patience, so the test stays fast
    // A raw second connection playing "instance A mid-reserve": BEGIN IMMEDIATE takes the write lock.
    const { DatabaseSync } = await import('node:sqlite');
    const rawA = new DatabaseSync(join(dir, 'orders.db'));
    rawA.exec('BEGIN IMMEDIATE;');
    // B cannot begin its own CHECK -> COMMIT while A holds the lock: it times out into the poisoned fail-fast.
    await expect(b.reserve('o-b', 100n, TTL_MS, NOW_MS)).rejects.toSatisfy((e: unknown) =>
      isDurableLogFailure(e),
    );
    // A releases; B's next attempt goes through.
    rawA.exec('ROLLBACK;');
    rawA.close();
    expect((await b.reserve('o-b', 100n, TTL_MS, NOW_MS)).kind).toBe('reserved');
  });

  it('a transaction that throws rolls back whole — nothing half-written survives', () => {
    const dir = tmp();
    const db = openOrderDb(dir);
    expect(() =>
      db.transaction(() => {
        db.run(
          'INSERT INTO reservations (order_id, amount_stroops, reserved_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)',
          'o-x',
          '100',
          NOW_MS,
          NOW_MS + TTL_MS,
        );
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.get('SELECT 1 AS x FROM reservations WHERE order_id = ?', 'o-x')).toBeUndefined();
  });
});
