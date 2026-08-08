// The durable registry (A-1), tested for the two things it exists for: (1) a restarted poll worker finds its
// in-flight work-list on disk — the customer-charged-merchant-unpaid crash of KNOWN_ISSUES §1 becomes a
// re-driven order instead of a forgotten one; (2) after a crash the effective-state rule resumes every order
// from the money-safe state, never behind an allocated sequence and never before a landed payout.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord, OrderCtx, OrderFacts } from '@troia/backend';
import { decodeOrderCtx, encodeOrderCtx, OrderCtxCodecError } from '../src/order-ctx-codec.js';
import { openOrderDb } from '../src/order-db.js';
import { SqliteOrderRegistry } from '../src/sqlite-order-registry.js';
import { SqliteOrderStore } from '../src/sqlite-order-store.js';

const BALANCE = 1_000n * 10_000_000n;
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

/** A full OrderCtx as it looks right after the hosted form was issued (the SolvencyReserved wait). */
function ctxOf(orderId: string, overrides: Partial<OrderCtx> = {}): OrderCtx {
  return {
    orderId,
    conversationId: `conv-${orderId}`,
    destination: FACTS.destination,
    amountStroops: FACTS.amountStroops,
    appliedRateStroops: FACTS.appliedRateStroops,
    memoHex: FACTS.memoHex,
    paymentId: null,
    token: 'form-token-1',
    paymentPageUrl: 'https://sandbox.iyzico/form/1',
    paidPriceTry: '3400.00',
    spreadKurus: FACTS.spreadKurus,
    feeKurus: FACTS.feeKurus,
    currency: 'TRY',
    ip: '203.0.113.7',
    activeSeq: null,
    hashHex: null,
    signedXdr: null,
    payMaxTimeUnix: null,
    deadRetries: 0,
    reversalRetries: 0,
    ...overrides,
  };
}

interface Opened {
  store: SqliteOrderStore;
  registry: SqliteOrderRegistry;
}

function open(dir: string): Opened {
  const db = openOrderDb(dir);
  const store = new SqliteOrderStore({ db, balanceStroops: BALANCE, baseSeq: 1000n });
  return { store, registry: new SqliteOrderRegistry(db, store) };
}

describe('order ctx codec', () => {
  it('round-trips a ctx with every nullable in both shapes', () => {
    const full = ctxOf('o-1', {
      paymentId: 'pay-1',
      activeSeq: '1001',
      hashHex: 'ff'.repeat(32),
      signedXdr: 'AAAA',
      payMaxTimeUnix: 1_700_000_100,
      deadRetries: 2,
      reversalRetries: 1,
    });
    expect(decodeOrderCtx(encodeOrderCtx(full))).toEqual(full);
    const bare = ctxOf('o-2', { token: null, paymentPageUrl: null });
    expect(decodeOrderCtx(encodeOrderCtx(bare))).toEqual(bare);
  });

  it('fails closed on malformed input, wrong version, and non-canonical amounts', () => {
    expect(() => decodeOrderCtx('not json')).toThrow(OrderCtxCodecError);
    expect(() => decodeOrderCtx('{"v":99}')).toThrow(/unsupported version/);
    const tampered = encodeOrderCtx(ctxOf('o-1')).replace('"1000000000"', '"1e9"');
    expect(() => decodeOrderCtx(tampered)).toThrow(/non-canonical/);
  });
});

describe('SqliteOrderRegistry — the live contract', () => {
  it('puts and gets by orderId and conversationId, exactly like the in-memory registry', () => {
    const { registry } = open(mkdtempSync(join(tmpdir(), 'troia-reg-')));
    const ctx = ctxOf('o-1');
    registry.put(ctx, 'SolvencyReserved');
    expect(registry.getByOrderId('o-1')?.state).toBe('SolvencyReserved');
    expect(registry.getByOrderId('o-1')?.ctx).toEqual(ctx);
    expect(registry.getByConversationId('conv-o-1')?.ctx.orderId).toBe('o-1');
    expect(registry.getByOrderId('missing')).toBeUndefined();
  });

  it('ordersInStates filters and re-put moves an order between lists', () => {
    const { registry } = open(mkdtempSync(join(tmpdir(), 'troia-reg-')));
    registry.put(ctxOf('o-1'), 'SolvencyReserved');
    registry.put(ctxOf('o-2'), 'FailedClean');
    expect(registry.ordersInStates(['SolvencyReserved']).map((r) => r.ctx.orderId)).toEqual([
      'o-1',
    ]);
    registry.put(ctxOf('o-1'), 'FailedClean');
    expect(registry.ordersInStates(['SolvencyReserved'])).toHaveLength(0);
  });
});

describe('SqliteOrderRegistry — crash recovery (the A-1 headline)', () => {
  it('an order awaiting its charge outcome SURVIVES a restart and lands on the poll work-list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    await first.store.createIfAbsent('o-1');
    await first.store.reserve('o-1', FACTS.amountStroops, 60_000, NOW_MS);
    first.registry.put(ctxOf('o-1'), 'SolvencyReserved');
    // CRASH. The customer may already be paying on the hosted form this state opened.
    const second = open(dir);
    const boot = second.registry.recoverAtBoot();
    expect(boot.recovered).toEqual([{ orderId: 'o-1', state: 'SolvencyReserved' }]);
    const work = second.registry.ordersInStates([
      'SolvencyReserved',
      'UsdcSubmitted',
      'UsdcPending',
    ]);
    expect(work).toHaveLength(1);
    // the recovered ctx carries the persisted form token — exactly what poll path (A) re-retrieves by
    expect(work[0]?.ctx.token).toBe('form-token-1');
    expect(work[0]?.ctx.amountStroops).toBe(FACTS.amountStroops);
  });

  it('rule 3: never resumes behind an allocated sequence (store row wins over a stale registry row)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    await first.store.createIfAbsent('o-1');
    first.registry.put(ctxOf('o-1'), 'SolvencyReserved');
    // the webhook drive persisted the submit-side row, then crashed BEFORE its registry put:
    await first.store.persistState('o-1', 'UsdcSubmitted', { seq: '1001', paymentId: 'pay-1' });
    const second = open(dir);
    const rec = second.registry.getByOrderId('o-1');
    expect(rec?.state).toBe('UsdcSubmitted'); // resuming from SolvencyReserved would allocate a SECOND seq
    expect(rec?.ctx.activeSeq).toBe('1001'); // overlaid from the store row
    expect(rec?.ctx.paymentId).toBe('pay-1');
  });

  it('rule 2: a landed payout pins the state to UsdcConfirmed across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    first.registry.put(ctxOf('o-1', { hashHex: REC.txHash }), 'UsdcPending');
    await first.store.appendEvidence('o-1', REC, FACTS);
    // evidence is seeded back at boot by the composition root; simulate that seed here
    const db = openOrderDb(dir);
    const store = new SqliteOrderStore({
      db,
      balanceStroops: BALANCE,
      baseSeq: 1000n,
      seedEvidence: [{ orderId: 'o-1', record: REC, order: FACTS }],
    });
    const registry = new SqliteOrderRegistry(db, store);
    expect(registry.getByOrderId('o-1')?.state).toBe('UsdcConfirmed'); // never re-driven, never re-paid
  });

  it('rule 1: a reconciled order stays terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    first.registry.put(ctxOf('o-1'), 'Reconciled');
    expect(open(dir).registry.getByOrderId('o-1')?.state).toBe('Reconciled');
  });

  it('overlays the persisted retry counters, so the recovery budget survives with the order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    first.registry.put(ctxOf('o-1'), 'UsdcPending'); // ctx snapshot says 0 retries
    await first.store.bumpDeadRetries('o-1');
    await first.store.bumpDeadRetries('o-1');
    const rec = open(dir).registry.getByOrderId('o-1');
    expect(rec?.ctx.deadRetries).toBe(2);
    expect(rec?.ctx.reversalRetries).toBe(0);
  });

  it('purges pre-charge leftovers at boot and returns their reserved capacity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    // an /intent that died right after reserving: no form URL ever reached a customer
    first.registry.put(ctxOf('o-1', { token: null, paymentPageUrl: null }), 'Reserved');
    await first.store.createIfAbsent('o-1');
    await first.store.reserve('o-1', FACTS.amountStroops, 60_000, NOW_MS);
    const second = open(dir);
    const boot = second.registry.recoverAtBoot();
    expect(boot.purgedReserved).toEqual(['o-1']);
    expect(second.registry.getByOrderId('o-1')).toBeUndefined();
    expect(second.store.availableStroops()).toBe(BALANCE); // the hold came back
    // and a retried /intent can now recreate the order from scratch
    expect(await second.store.createIfAbsent('o-1')).toBe('created');
  });

  it('does NOT purge an in-flight order at boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-reg-'));
    const first = open(dir);
    first.registry.put(ctxOf('o-1'), 'SolvencyReserved');
    await first.store.createIfAbsent('o-1');
    const second = open(dir);
    const boot = second.registry.recoverAtBoot();
    expect(boot.purgedReserved).toEqual([]);
    expect(second.registry.getByOrderId('o-1')?.state).toBe('SolvencyReserved');
  });
});
