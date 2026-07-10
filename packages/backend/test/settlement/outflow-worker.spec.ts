import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAIL_STALL_AFTER,
  INITIAL_TAIL_HEALTH,
  judgeOutflows,
  observeTailHealth,
  tailOutflows,
  toidAtLedger,
} from '../../src/settlement/outflow-worker.js';
import type {
  CursorStore,
  OutflowTailDeps,
  Suspect,
  SuspectStore,
} from '../../src/settlement/outflow-worker.js';
import type {
  OutflowEvent,
  PoolActivityPage,
  PoolFetch,
  PoolUpgrade,
  SettlementObservation,
} from '@troia/stellar-client';

// The rogue-payout detector. Two properties decide whether it is worth having:
//
//   it must NEVER accuse a payout we authorized — one false accusation and nobody reads the alarm again;
//   it must NEVER lose a real one to a restart — the durable ordering is what buys that.
//
// The first is not a matter of timing. The write-ahead journal records a pay()'s hash before the transaction is
// broadcast, so a transaction cannot land — and its outflow event cannot exist — unless the hash is already on
// disk. An outflow whose hash is absent was never authorized. These tests pin that, and the crash ordering.

const OURS = 'a'.repeat(64);
const THEIRS = 'b'.repeat(64);
const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const GRACE = 60;

function ev(txHash: string, ledgerCloseUnix: number, amountStroops = 10_000_000n): OutflowEvent {
  return { txHash, ledger: 100, ledgerCloseUnix, to: MERCHANT, amountStroops };
}

const authorized = (set: readonly string[]) => (h: string) => set.includes(h);

describe('judgeOutflows — a payout we authorized is never a suspect', () => {
  it('ignores an outflow whose hash is in the journal, however fresh it is', () => {
    const v = judgeOutflows([ev(OURS, 1000)], [], authorized([OURS]), 1000, GRACE);
    expect(v).toEqual({ rogue: [], newSuspects: [], cleared: [], pending: [] });
  });

  it('opens a case on an unauthorized outflow, but does not accuse inside grace', () => {
    const v = judgeOutflows([ev(THEIRS, 1000)], [], authorized([OURS]), 1000 + GRACE - 1, GRACE);
    expect(v.rogue).toEqual([]);
    expect(v.newSuspects).toHaveLength(1);
    expect(v.newSuspects[0]?.firstSeenLedgerCloseUnix).toBe(1000); // the EVENT's chain time, not "now"
    expect(v.pending).toHaveLength(1);
  });

  it('accuses once grace has passed in LEDGER time, and exactly once', () => {
    const first = judgeOutflows([ev(THEIRS, 1000)], [], authorized([OURS]), 1000 + GRACE, GRACE);
    expect(first.rogue).toHaveLength(1);
    expect(first.rogue[0]?.txHash).toBe(THEIRS);
    expect(first.rogue[0]?.alarmed).toBe(true);

    // the store now carries it as alarmed; a later tick must not page again
    const again = judgeOutflows([], first.rogue, authorized([OURS]), 9_999_999, GRACE);
    expect(again.rogue).toEqual([]);
    expect(again.pending).toHaveLength(1);
  });

  it('a suspect that turns out to be authorized is cleared, not accused', () => {
    const suspect: Suspect = {
      txHash: OURS,
      firstSeenLedgerCloseUnix: 1000,
      ledger: 100,
      amountStroops: 1n,
      to: MERCHANT,
      alarmed: false,
    };
    const v = judgeOutflows([], [suspect], authorized([OURS]), 9_999_999, GRACE);
    expect(v.cleared).toEqual([OURS]);
    expect(v.rogue).toEqual([]);
  });

  it('a re-read page does not restart the grace clock — the original first-seen survives', () => {
    const opened = judgeOutflows([ev(THEIRS, 1000)], [], authorized([]), 1010, GRACE);
    const suspect = opened.newSuspects[0] as Suspect;
    // the same event arrives again (a crash before the cursor was saved), much later in chain time
    const again = judgeOutflows([ev(THEIRS, 1000)], [suspect], authorized([]), 1000 + GRACE, GRACE);
    expect(again.newSuspects).toEqual([]); // not re-opened
    expect(again.rogue).toHaveLength(1); // and it escalates on the ORIGINAL clock
  });

  it('grace is chain time: a tail catching up on old events accuses immediately, not one grace later', () => {
    // the tail was down; it now reads an outflow whose ledger closed an hour ago
    const v = judgeOutflows([ev(THEIRS, 1000)], [], authorized([]), 1000 + 3600, GRACE);
    expect(v.rogue).toHaveLength(1);
  });
});

describe('toidAtLedger', () => {
  it('produces the RPC’s own 19-digit zero-padded TOID form', () => {
    expect(toidAtLedger(3507252)).toBe('0015063536933797887-4294967295');
  });
});

// --- the tick ------------------------------------------------------------------------------------------------

class FakeCursor implements CursorStore {
  constructor(public value: string | null = null) {}
  readonly saves: string[] = [];
  load(): string | null {
    return this.value;
  }
  save(cursor: string): void {
    this.saves.push(cursor);
    this.value = cursor;
  }
}

class FakeSuspects implements SuspectStore {
  private readonly open = new Map<string, Suspect>();
  readonly ops: string[] = [];
  constructor(seed: readonly Suspect[] = []) {
    for (const s of seed) this.open.set(s.txHash, s);
  }
  all(): readonly Suspect[] {
    return [...this.open.values()];
  }
  record(s: Suspect): void {
    this.ops.push(`record:${s.txHash.slice(0, 4)}`);
    this.open.set(s.txHash, s);
  }
  markAlarmed(h: string): void {
    this.ops.push(`alarm:${h.slice(0, 4)}`);
    const s = this.open.get(h);
    if (s) this.open.set(h, { ...s, alarmed: true });
  }
  tombstone(h: string): void {
    this.ops.push(`clear:${h.slice(0, 4)}`);
    this.open.delete(h);
  }
}

function page(events: readonly OutflowEvent[], closeUnix = 2000, cursor = 'C1'): PoolActivityPage {
  return {
    kind: 'PAGE',
    outflows: events,
    settlements: [],
    upgrades: [],
    cursor,
    latestLedger: 500,
    latestLedgerCloseUnix: closeUnix,
    oldestLedger: 1,
  };
}

/** The tail persists what it sees; these tests are about the verdict, so the store is inert — except for the
 *  coverage floor, which the tail itself writes and which the tests below assert on. */
function noopObservations(): OutflowTailDeps['observations'] {
  let coverage: number | null = null;
  return {
    recordOutflow: () => {},
    recordSettlement: () => {},
    recordUpgrade: () => {},
    settlementByTxId: (): SettlementObservation | undefined => undefined,
    outflowStroopsByTx: (): bigint => 0n,
    upgrades: (): readonly PoolUpgrade[] => [],
    recordCoverageStart: (u: number) => {
      if (coverage === null || u > coverage) coverage = u;
    },
    coverageStartUnix: (): number | null => coverage,
  };
}

function deps(over: Partial<OutflowTailDeps> & { page?: PoolActivityPage }): OutflowTailDeps {
  const cursor = over.cursor ?? new FakeCursor('C0');
  return {
    tail: over.tail ?? {
      fetchPoolActivity: async (_req: PoolFetch): Promise<PoolActivityPage> =>
        over.page ?? page([]),
      latestLedger: async (): Promise<number> => 500,
    },
    observations: over.observations ?? noopObservations(),
    cursor,
    suspects: over.suspects ?? new FakeSuspects(),
    authorized: over.authorized ?? { has: (h: string) => h === OURS },
    graceSecs: over.graceSecs ?? GRACE,
    coldStartMarginLedgers: over.coldStartMarginLedgers ?? 60,
    nowUnix: over.nowUnix ?? ((): number => 9_000),
  };
}

describe('tailOutflows — coverage says where our knowledge begins', () => {
  it('records the coverage floor on a cold start, before it acts on anything it read', async () => {
    const observations = noopObservations();
    const d = deps({ observations, cursor: new FakeCursor(null), nowUnix: () => 12_345 });
    expect(observations.coverageStartUnix()).toBeNull();
    await tailOutflows(d);
    expect(observations.coverageStartUnix()).toBe(12_345);
  });

  it('does not re-record coverage once a cursor exists — a warm start already knows where it began', async () => {
    const observations = noopObservations();
    await tailOutflows(deps({ observations, cursor: new FakeCursor(null), nowUnix: () => 100 }));
    await tailOutflows(deps({ observations, cursor: new FakeCursor('C0'), nowUnix: () => 900 }));
    expect(observations.coverageStartUnix()).toBe(100);
  });

  it('moves the floor forward when the retention window scrolls past the cursor', async () => {
    // Events between the old cursor and the new floor are gone for everyone. No order witnessed before now may be
    // accused of having no settlement, so coverage must restart here.
    const observations = noopObservations();
    await tailOutflows(deps({ observations, cursor: new FakeCursor(null), nowUnix: () => 100 }));
    const d = deps({
      observations,
      cursor: new FakeCursor('C0'),
      nowUnix: () => 5_000,
      page: {
        kind: 'CURSOR_BELOW_RETENTION',
        cursorLedger: 10,
        oldestLedger: 400,
        latestLedger: 500,
      },
    });
    const r = await tailOutflows(d);
    expect(r.kind).toBe('blindSpot');
    expect(observations.coverageStartUnix()).toBe(5_000);
  });
});

describe('tailOutflows — the durable ordering IS the crash contract', () => {
  it('records a suspect BEFORE the cursor advances past its page', async () => {
    const cursor = new FakeCursor('C0');
    const suspects = new FakeSuspects();
    const d = deps({ cursor, suspects, page: page([ev(THEIRS, 1000)], 1010) });

    const r = await tailOutflows(d);
    expect(r.kind).toBe('scanned');
    expect(suspects.ops).toEqual([`record:${THEIRS.slice(0, 4)}`]);
    expect(cursor.saves).toEqual(['C1']);
    // the suspect exists on the durable side even though the cursor moved on
    expect(suspects.all()).toHaveLength(1);
  });

  it('an authorized outflow leaves no trace and still advances the checkpoint', async () => {
    const cursor = new FakeCursor('C0');
    const suspects = new FakeSuspects();
    const r = await tailOutflows(deps({ cursor, suspects, page: page([ev(OURS, 1000)]) }));
    expect(r).toMatchObject({ kind: 'scanned', outflows: 1, newSuspects: 0, rogue: [] });
    expect(suspects.ops).toEqual([]);
    expect(cursor.saves).toEqual(['C1']);
  });

  it('a stall advances nothing and accuses nobody', async () => {
    const cursor = new FakeCursor('C0');
    const suspects = new FakeSuspects();
    const d = deps({
      cursor,
      suspects,
      tail: {
        fetchPoolActivity: async (): Promise<PoolActivityPage> => ({
          kind: 'RPC_UNAVAILABLE',
          reason: 'ECONNRESET',
        }),
        latestLedger: async (): Promise<number> => 500,
      },
    });
    const r = await tailOutflows(d);
    expect(r).toEqual({ kind: 'stalled', reason: 'ECONNRESET' });
    expect(cursor.saves).toEqual([]);
    expect(suspects.ops).toEqual([]);
  });

  it('a checkpoint below retention re-anchors at head and reports a permanent blind spot', async () => {
    const cursor = new FakeCursor('C0');
    const d = deps({
      cursor,
      tail: {
        fetchPoolActivity: async (): Promise<PoolActivityPage> => ({
          kind: 'CURSOR_BELOW_RETENTION',
          cursorLedger: 100,
          oldestLedger: 3_400_000,
          latestLedger: 3_500_000,
        }),
        latestLedger: async (): Promise<number> => 3_500_000,
      },
    });
    const r = await tailOutflows(d);
    expect(r).toEqual({
      kind: 'blindSpot',
      fromLedger: 100,
      toLedger: 3_400_000,
      latestLedger: 3_500_000,
    });
    // re-anchored one ledger before head, because a cursor resumes strictly AFTER its ledger
    expect(cursor.saves).toEqual([toidAtLedger(3_499_999)]);
  });

  it('a cold start anchors near head and says so — nothing earlier was ever examined', async () => {
    const cursor = new FakeCursor(null);
    let asked: PoolFetch | null = null;
    const d = deps({
      cursor,
      coldStartMarginLedgers: 60,
      tail: {
        fetchPoolActivity: async (req: PoolFetch): Promise<PoolActivityPage> => {
          asked = req;
          return page([]);
        },
        latestLedger: async (): Promise<number> => 1000,
      },
    });
    const r = await tailOutflows(d);
    expect(asked).toEqual({ startLedger: 940 });
    expect(r).toMatchObject({ kind: 'scanned', coldStartFromLedger: 940 });
  });

  it('a restart re-reads the page and neither re-opens nor re-accuses a suspect it already carries', async () => {
    const escalated: Suspect = {
      txHash: THEIRS,
      firstSeenLedgerCloseUnix: 1000,
      ledger: 100,
      amountStroops: 1n,
      to: MERCHANT,
      alarmed: true,
    };
    const suspects = new FakeSuspects([escalated]);
    const r = await tailOutflows(
      deps({ suspects, page: page([ev(THEIRS, 1000)], 9_999_999) }), // same event, long past grace
    );
    expect(r).toMatchObject({ kind: 'scanned', rogue: [], newSuspects: 0, pending: 1 });
    expect(suspects.ops).toEqual([]); // nothing re-recorded, nothing re-paged
  });
});

describe('observeTailHealth — a tail that cannot see must not look like a tail that saw nothing', () => {
  it('pages once after N consecutive stalls, and stays quiet after', () => {
    let s = INITIAL_TAIL_HEALTH;
    let fired = 0;
    for (let i = 0; i < 10; i += 1) {
      const o = observeTailHealth(s, true);
      if (o.alarm) fired += 1;
      s = o.state;
    }
    expect(fired).toBe(1);
    expect(s.consecutiveStalls).toBe(10);
  });

  it('a recovery resets the episode and is reported', () => {
    let s = INITIAL_TAIL_HEALTH;
    for (let i = 0; i < DEFAULT_TAIL_STALL_AFTER; i += 1) s = observeTailHealth(s, true).state;
    const back = observeTailHealth(s, false);
    expect(back.recovered).toBe(true);
    expect(back.state).toEqual(INITIAL_TAIL_HEALTH);
  });
});
