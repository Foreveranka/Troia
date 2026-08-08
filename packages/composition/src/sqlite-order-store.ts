// The durable Store (A-1): the same contract as InMemoryStore, with every row KNOWN_ISSUES §1 called
// deliberately volatile now written through to SQLite before the call returns. The concurrency contract
// carries over unchanged (in-memory-store.ts header): reserve()'s CHECK -> COMMIT runs under the pool mutex,
// and every other mutator is a strictly synchronous read-modify-write — node:sqlite's sync API is what makes
// that possible without splitting the caller's per-order lock.
//
// What is durable here and what deliberately is NOT:
//   durable   — order rows (state + in-flight patch), solvency reservations, retry counters, webhook dedup,
//               loss flags. These are exactly the rows a crash used to erase.
//   volatile  — the pool BALANCE (seeded from the bootstrap chain read every boot: the chain is the solvency
//               source of truth, and a landed mint or payout is already in that read) and the operator
//               sequence (re-read from the chain the same way).
//   unchanged — settlement evidence stays on the append-only evidence.log (file), seeded back in at boot,
//               exactly as before. One durability mechanism per fact; the log already has its crash contract.
//
// RESERVATION LIFECYCLE ACROSS RESTARTS — the one place durability changes the arithmetic. In-process, a
// successful payout keeps its reservation held forever (the base never re-reads, so the hold IS the debit).
// Across a restart the fresh chain read already reflects the payout, so replaying the hold would debit the
// pool twice. appendEvidence therefore marks the order's reservation `settled` (the pay() landed), and boot
// deletes settled rows; unsettled rows are replayed as held — fail-closed: a crashed in-flight order keeps
// its capacity locked until recovery proves its fate, exactly like the in-memory rule.

import { SequenceAllocator } from '@troia/core';
import type { SequenceProvider, State } from '@troia/core';
import { SqliteSequenceStore } from './sqlite-sequence-store.js';
import { Mutex } from '@troia/backend';
import type {
  DurableLog,
  EvidenceRecord,
  EvidenceRow,
  InFlightPatch,
  Lock,
  LossBucket,
  OrderFacts,
  ReleaseReason,
  ReserveOutcome,
  Store,
} from '@troia/backend';
import { encodeEvidenceRow } from '@troia/backend';
import type { OrderDb } from './order-db.js';

interface StoreOrderRow {
  state: State;
  seq?: string;
  paymentId?: string;
  hashHex?: string;
  signedXdr?: string;
  channelPublic?: string;
}

export interface SqliteOrderStoreOptions {
  readonly db: OrderDb;
  /** the pool's live USDC balance at bootstrap (chain read — the solvency source of truth). */
  readonly balanceStroops: bigint;
  /** operator account seq at bootstrap (chain read); the allocator hands out baseSeq+1 first. */
  readonly baseSeq: bigint;
  /** the append-only settlement-evidence sink (file), exactly as with InMemoryStore. */
  readonly evidenceLog?: DurableLog;
  /** rows replayed from that log at boot; also used to sweep reservations whose payout already landed. */
  readonly seedEvidence?: readonly EvidenceRow[];
  readonly poolMutex?: Lock;
  /** CHANNEL MODE (A-5): a channel-pool SequenceProvider overrides the default single-operator allocator.
   *  When omitted, the operator allocator runs over a DURABLE SqliteSequenceStore — so a restarted recovery
   *  can reuseOnDead/confirmBurned seqs the crash left in flight (the missing piece of A-1). */
  readonly sequences?: SequenceProvider;
}

/** What boot recovery found — the composition root logs this so a restart is never silently different. */
export interface StoreBootReport {
  /** settled reservation rows deleted (their payout is already in the fresh chain balance). */
  readonly settledReservationsDropped: number;
  /** unsettled reservations replayed as held (fail-closed: capacity stays locked until recovery resolves). */
  readonly heldReservationsReplayed: number;
}

export class SqliteOrderStore implements Store {
  readonly sequences: SequenceProvider;
  private readonly db: OrderDb;
  private readonly poolMutex: Lock;
  private readonly evidenceLog: DurableLog | undefined;
  private readonly evidence: EvidenceRow[] = [];
  private balanceStroops: bigint;
  private readonly report: StoreBootReport;

  constructor(opts: SqliteOrderStoreOptions) {
    this.db = opts.db;
    this.balanceStroops = opts.balanceStroops;
    // The allocator state is DURABLE (scope 'operator'): a persisted snapshot wins over the chain baseSeq,
    // which is only the first-boot seed — the allocator is the authoritative owner of the seq space and
    // never re-reads the network (ARCHITECTURE §6). This closes the post-restart UnknownSeq hole on the
    // recovery paths that touch an in-flight seq (reuseOnDead / confirmBurned / reallocate).
    this.sequences =
      opts.sequences ??
      new SequenceAllocator(new SqliteSequenceStore(opts.db, 'operator'), opts.baseSeq);
    this.poolMutex = opts.poolMutex ?? new Mutex();
    this.evidenceLog = opts.evidenceLog;
    if (opts.seedEvidence !== undefined) this.evidence.push(...opts.seedEvidence);

    // Boot sweep. A reservation whose payout landed is already inside the fresh chain read; replaying its hold
    // would debit the pool twice, permanently. Two sweeps because the settled mark and the evidence append live
    // in different durability domains: a crash between the evidence append (file) and the settled mark (db)
    // leaves the row unmarked, and the seedEvidence sweep folds that window.
    this.report = this.db.transaction(() => {
      let dropped = this.db.run('DELETE FROM reservations WHERE settled = 1');
      for (const row of opts.seedEvidence ?? []) {
        dropped += this.db.run('DELETE FROM reservations WHERE order_id = ?', row.orderId);
      }
      const held = this.db.get('SELECT COUNT(*) AS n FROM reservations');
      return {
        settledReservationsDropped: dropped,
        heldReservationsReplayed: Number(held?.n ?? 0),
      };
    });
  }

  bootReport(): StoreBootReport {
    return this.report;
  }

  // --- SPIKE-3 solvency (the money-critical path) ---

  reserve(
    orderId: string,
    amountStroops: bigint,
    ttlMs: number,
    nowMs: number,
  ): Promise<ReserveOutcome> {
    // Two locks, two hazards. The pool MUTEX serializes reservations inside THIS process (the SPIKE-3
    // contract). The BEGIN IMMEDIATE transaction serializes the CHECK -> COMMIT against OTHER processes
    // sharing this file: a second instance's check cannot interleave before this commit, it can only wait —
    // which closes KNOWN_ISSUES §3's over-commit for the solvency gate. (Running two instances is STILL
    // unsupported for other reasons — per-order locks and the operator sequence are per-process — but the
    // reservation arithmetic can no longer promise the same coin twice.)
    return this.poolMutex.run(async () =>
      this.db.transaction(() => {
        // Idempotent per order; a same-order re-reserve for a DIFFERENT amount fails closed (amount is
        // immutable per order — a mismatch is a bug, and failing it cannot over-commit).
        const existing = this.db.get(
          'SELECT amount_stroops FROM reservations WHERE order_id = ?',
          orderId,
        );
        if (existing !== undefined) {
          if (BigInt(existing.amount_stroops as string) !== amountStroops) {
            return {
              kind: 'insufficient' as const,
              available: this.availableStroops(),
              requested: amountStroops,
            };
          }
          return { kind: 'reserved' as const, reservationId: `res-${orderId}` };
        }
        const available = this.availableStroops(); // CHECK
        if (available < amountStroops) {
          return { kind: 'insufficient' as const, available, requested: amountStroops };
        }
        // COMMIT — the durable insert IS the commit; when the transaction returns, the hold is on disk.
        this.db.run(
          'INSERT INTO reservations (order_id, amount_stroops, reserved_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)',
          orderId,
          String(amountStroops),
          nowMs,
          nowMs + ttlMs,
        );
        return { kind: 'reserved' as const, reservationId: `res-${orderId}` };
      }),
    );
  }

  releaseReservation(orderId: string, _reason: ReleaseReason): Promise<void> {
    return this.poolMutex.run(async () => {
      this.db.run('DELETE FROM reservations WHERE order_id = ?', orderId);
    });
  }

  /** Raise the pool base by a landed rebalance top-up, under the pool mutex (serialized with reserve()).
   *  Memory-only on purpose: the mint is on chain, so the next boot's chain read carries it. */
  creditPool(stroops: bigint): Promise<void> {
    return this.poolMutex.run(async () => {
      if (stroops <= 0n) throw new RangeError('credit amount must be > 0');
      this.balanceStroops += stroops;
    });
  }

  /** balance − Σ EVERY held reservation. Fail-closed: no TTL arithmetic, time never frees capacity
   *  (reservation-ledger.ts states the rule; this is the same sum read from the durable rows). */
  availableStroops(): bigint {
    let sum = 0n;
    for (const row of this.db.all('SELECT amount_stroops FROM reservations')) {
      sum += BigInt(row.amount_stroops as string);
    }
    return this.balanceStroops - sum;
  }

  poolBalanceStroops(): bigint {
    return this.balanceStroops;
  }

  // --- per-order / per-event state (synchronous writes; single-writer under the caller's order lock) ---

  async createIfAbsent(orderId: string): Promise<'created' | 'exists'> {
    const changes = this.db.run(
      "INSERT INTO store_orders (order_id, state) VALUES (?, 'Reserved') ON CONFLICT (order_id) DO NOTHING",
      orderId,
    );
    return changes > 0 ? 'created' : 'exists';
  }

  async persistState(orderId: string, next: State, patch: InFlightPatch): Promise<void> {
    this.db.run(
      `INSERT INTO store_orders (order_id, state, seq, payment_id, hash_hex, signed_xdr, channel_public)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_id) DO UPDATE SET
         state          = excluded.state,
         seq            = COALESCE(excluded.seq, seq),
         payment_id     = COALESCE(excluded.payment_id, payment_id),
         hash_hex       = COALESCE(excluded.hash_hex, hash_hex),
         signed_xdr     = COALESCE(excluded.signed_xdr, signed_xdr),
         channel_public = COALESCE(excluded.channel_public, channel_public)`,
      orderId,
      next,
      patch.seq ?? null,
      patch.paymentId ?? null,
      patch.hashHex ?? null,
      patch.signedXdr ?? null,
      patch.channelPublic ?? null,
    );
  }

  /** Record the quarantine, once per (orderId, bucket). The FIRST witness wins: a later call may carry a null
   *  hash (crash recovery has no witness), and forgetting a hash we already hold would be a regression. */
  async flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void> {
    this.db.run(
      'INSERT INTO losses (order_id, bucket, usdc_tx_hash, at_ms) VALUES (?, ?, ?, 0) ON CONFLICT (order_id, bucket) DO NOTHING',
      orderId,
      bucket,
      usdcTxHash,
    );
  }

  /** The quarantine latch the poll worker reads before driving an order. Synchronous (sqlite sync read), so it
   *  does not split the caller's lock — the same property the in-memory Set gave. */
  isLossFlagged(orderId: string): boolean {
    return (
      this.db.get('SELECT 1 AS x FROM losses WHERE order_id = ? LIMIT 1', orderId) !== undefined
    );
  }

  async markWebhookSeen(
    eventId: string,
    orderId: string,
    nowMs: number,
  ): Promise<'first' | 'duplicate'> {
    const changes = this.db.run(
      'INSERT INTO webhooks (event_id, order_id, seen_at_ms) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING',
      eventId,
      orderId,
      nowMs,
    );
    return changes > 0 ? 'first' : 'duplicate';
  }

  /** DURABLE FIRST, memory second — same discipline as InMemoryStore. Additionally marks the order's
   *  reservation settled: the pay() is now on chain, so the NEXT boot's chain read carries the debit and the
   *  hold must not be replayed (see the header). In-process the hold keeps counting, exactly as before. */
  async appendEvidence(orderId: string, record: EvidenceRecord, order: OrderFacts): Promise<void> {
    const row: EvidenceRow = { orderId, record, order };
    this.evidenceLog?.append(encodeEvidenceRow(row));
    this.db.run('UPDATE reservations SET settled = 1 WHERE order_id = ?', orderId);
    this.evidence.push(row);
  }

  private bump(orderId: string, kind: 'dead' | 'reversal' | 'revertOther'): number {
    const row = this.db.get(
      `INSERT INTO retry_counters (order_id, kind, n) VALUES (?, ?, 1)
       ON CONFLICT (order_id, kind) DO UPDATE SET n = n + 1
       RETURNING n`,
      orderId,
      kind,
    );
    return Number(row?.n ?? 0);
  }

  async bumpDeadRetries(orderId: string): Promise<number> {
    return this.bump(orderId, 'dead');
  }
  async bumpReversalRetries(orderId: string): Promise<number> {
    return this.bump(orderId, 'reversal');
  }
  async bumpRevertOtherRetries(orderId: string): Promise<number> {
    return this.bump(orderId, 'revertOther');
  }

  /** Persisted retry counters for an order — the registry overlays these onto a recovered ctx, so recovery
   *  replays the same branch a live process would have taken (the budget survives the restart). */
  retryCounts(orderId: string): { dead: number; reversal: number } {
    const rows = this.db.all(
      "SELECT kind, n FROM retry_counters WHERE order_id = ? AND kind IN ('dead', 'reversal')",
      orderId,
    );
    let dead = 0;
    let reversal = 0;
    for (const r of rows) {
      if (r.kind === 'dead') dead = Number(r.n);
      else reversal = Number(r.n);
    }
    return { dead, reversal };
  }

  // --- read-side helpers (composition root / registry / tests) ---

  orderRow(orderId: string): Readonly<StoreOrderRow> | undefined {
    const r = this.db.get(
      'SELECT state, seq, payment_id, hash_hex, signed_xdr, channel_public FROM store_orders WHERE order_id = ?',
      orderId,
    );
    if (r === undefined) return undefined;
    return {
      state: r.state as State,
      ...(r.seq !== null ? { seq: r.seq as string } : {}),
      ...(r.payment_id !== null ? { paymentId: r.payment_id as string } : {}),
      ...(r.hash_hex !== null ? { hashHex: r.hash_hex as string } : {}),
      ...(r.signed_xdr !== null ? { signedXdr: r.signed_xdr as string } : {}),
      ...(r.channel_public !== null ? { channelPublic: r.channel_public as string } : {}),
    };
  }

  /** The open quarantines, for the ops surface (the D-17 review gauge + the admin panel to come). */
  lossRecords(): readonly {
    orderId: string;
    bucket: LossBucket;
    usdcTxHash: string | null;
    atMs: number;
  }[] {
    return this.db.all('SELECT order_id, bucket, usdc_tx_hash, at_ms FROM losses').map((r) => ({
      orderId: r.order_id as string,
      bucket: r.bucket as LossBucket,
      usdcTxHash: r.usdc_tx_hash as string | null,
      atMs: Number(r.at_ms),
    }));
  }

  /** A frozen snapshot copy — the append-only log can never be spliced through this accessor. */
  evidenceRecords(): readonly EvidenceRow[] {
    return Object.freeze([...this.evidence]);
  }

  /** @see InMemoryStore.confirmedOrders — the evidence log read as the settlement work-list, deduped. */
  confirmedOrders(): readonly { orderId: string; order: OrderFacts }[] {
    const byOrder = new Map<string, { orderId: string; order: OrderFacts }>();
    for (const row of this.evidence) {
      if (!byOrder.has(row.orderId))
        byOrder.set(row.orderId, { orderId: row.orderId, order: row.order });
    }
    return [...byOrder.values()];
  }

  /** @see Store.settledEvidence — the row's existence pins the state to UsdcConfirmed | Reconciled. */
  settledEvidence(orderId: string): EvidenceRow | undefined {
    return this.evidence.find((r) => r.orderId === orderId);
  }

  confirmedOrder(orderId: string): { orderId: string; order: OrderFacts } | undefined {
    return this.settledEvidence(orderId);
  }
}
