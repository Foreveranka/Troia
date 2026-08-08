// The concrete offline/testnet Store: in-memory persistence + the SPIKE-3 solvency reservation. The reserve
// path is the money-critical one — its CHECK -> (durable-write seam) -> COMMIT runs under a single POOL mutex
// so concurrent reservations can never both pass the check and over-commit the pool. A durable DB-backed
// Store is the mainnet swap; it keeps the SAME shape (the awaited seam becomes a real durable write, and the
// pool mutex becomes SELECT ... FOR UPDATE), so the concurrency contract carries over unchanged.
//
// Single-writer-per-order: persistState / bump*Retries / markWebhookSeen / appendEvidence do a STRICTLY
// synchronous read-modify-write (no await between read and write), so they are atomic on Node's event loop
// without a lock. The caller (4.3c/4.3d worker) additionally wraps each order's processing in withOrderLock
// so the durable variants — which WILL await between read and write — stay single-writer. Mutating methods
// must NOT self-guard with the order KeyedMutex: that reentrant-deadlocks against the caller's outer lock.

import { InMemorySequenceStore, SequenceAllocator } from '@troia/core';
import type { SequenceProvider, State } from '@troia/core';
import type {
  DurableLog,
  EvidenceRecord,
  EvidenceRow,
  OrderFacts,
  InFlightPatch,
  LossBucket,
  ReleaseReason,
  ReserveOutcome,
  Store,
} from '../ports.js';
import { encodeEvidenceRow } from './evidence-codec.js';
import { Mutex } from './mutex.js';
import type { Lock } from './mutex.js';
import { ReservationLedger } from './reservation-ledger.js';

interface OrderRow {
  state: State;
  seq?: string;
  paymentId?: string;
  hashHex?: string;
  signedXdr?: string;
  channelPublic?: string;
}

interface LossRow {
  readonly orderId: string;
  readonly bucket: LossBucket;
  readonly usdcTxHash: string | null;
  readonly atMs: number;
}

export interface InMemoryStoreOptions {
  readonly balanceStroops: bigint;
  /** operator account seq at bootstrap; the SequenceAllocator hands out baseSeq+1 first. */
  readonly baseSeq: bigint;
  /**
   * Durable sink for settlement evidence. Absent offline (pure in-memory, exactly as before); the composition
   * root injects a file-backed log. appendEvidence writes THROUGH it before touching memory, so a restart can
   * still answer "which USDC payouts did I authorize?" — the local half of the rogue-payout check.
   * Deliberately NOT wired to reserve()/the pool: the on-chain balance stays the solvency source of truth.
   */
  readonly evidenceLog?: DurableLog;
  /** Rows replayed from that log at boot. Seeded by copy — never re-appended. */
  readonly seedEvidence?: readonly EvidenceRow[];
  /**
   * The interleaving seam between reserve()'s CHECK and COMMIT. In a durable Store this is the real
   * await-ing durable write; offline it defaults to none (atomic). The SPIKE-3 proof injects a microtask
   * yield here so the pool mutex is genuinely exercised (and a NoOpMutex sibling demonstrably over-commits).
   */
  readonly beforeReserveCommit?: () => Promise<void>;
  /** injectable so a test can prove the lock is load-bearing (NoOpMutex -> over-commit). Default: real Mutex. */
  readonly poolMutex?: Lock;
  readonly nowMs?: number;
}

export class InMemoryStore implements Store {
  readonly sequences: SequenceProvider;
  private readonly ledger: ReservationLedger;
  private readonly poolMutex: Lock;
  private readonly beforeReserveCommit: (() => Promise<void>) | undefined;

  private readonly orders = new Map<string, OrderRow>();
  private readonly webhooks = new Map<string, { orderId: string; seenAtMs: number }>();
  private readonly evidence: EvidenceRow[] = [];
  private readonly losses: LossRow[] = [];
  /** The buckets already recorded per order — the (orderId, bucket) dedup key, and the quarantine latch the
   *  poll worker reads. Nested rather than a flattened string key, so an orderId (canonical Unicode, not a
   *  restricted charset) can never collide with a separator. */
  private readonly lossBuckets = new Map<string, Set<LossBucket>>();
  private readonly deadRetries = new Map<string, number>();
  private readonly reversalRetries = new Map<string, number>();
  private readonly revertOtherRetries = new Map<string, number>();

  private readonly evidenceLog: DurableLog | undefined;

  constructor(opts: InMemoryStoreOptions) {
    this.ledger = new ReservationLedger(opts.balanceStroops);
    this.sequences = new SequenceAllocator(new InMemorySequenceStore(), opts.baseSeq);
    this.poolMutex = opts.poolMutex ?? new Mutex();
    this.beforeReserveCommit = opts.beforeReserveCommit;
    this.evidenceLog = opts.evidenceLog;
    // Hydration is a plain copy: replayed rows are already durable, so re-appending them would grow the log
    // without bound and, worse, make every restart look like a fresh batch of payouts.
    if (opts.seedEvidence !== undefined) this.evidence.push(...opts.seedEvidence);
  }

  // --- SPIKE-3 solvency (the money-critical path) ---

  reserve(
    orderId: string,
    amountStroops: bigint,
    ttlMs: number,
    nowMs: number,
  ): Promise<ReserveOutcome> {
    return this.poolMutex.run(async () => {
      // Idempotent per order (at-least-once /intent + solvency recheck on replay). A same-order re-reserve
      // for a DIFFERENT amount fails closed (amount is immutable per order today; a mismatch is a bug).
      const existing = this.ledger.reservationFor(orderId);
      if (existing !== undefined) {
        if (existing.amountStroops !== amountStroops) {
          return {
            kind: 'insufficient',
            available: this.ledger.available(),
            requested: amountStroops,
          };
        }
        return { kind: 'reserved', reservationId: existing.reservationId };
      }
      const available = this.ledger.available(); // CHECK
      if (this.beforeReserveCommit !== undefined) await this.beforeReserveCommit(); // durable-write seam / test yield
      if (available < amountStroops) {
        return { kind: 'insufficient', available, requested: amountStroops };
      }
      return this.ledger.commit(orderId, amountStroops, nowMs, ttlMs); // COMMIT (trusts the CHECK under the lock)
    });
  }

  releaseReservation(orderId: string, _reason: ReleaseReason): Promise<void> {
    return this.poolMutex.run(async () => {
      this.ledger.release(orderId);
    });
  }

  /** Raise the pool base by a landed rebalance top-up, under the pool mutex so a mint credit can never
   *  interleave with reserve()'s CHECK→COMMIT and transiently mis-report headroom. */
  creditPool(stroops: bigint): Promise<void> {
    return this.poolMutex.run(async () => {
      this.ledger.credit(stroops);
    });
  }

  // --- per-order / per-event state (strictly synchronous RMW; see the header) ---

  async createIfAbsent(orderId: string): Promise<'created' | 'exists'> {
    if (this.orders.has(orderId)) return 'exists';
    this.orders.set(orderId, { state: 'Reserved' });
    return 'created';
  }

  async persistState(orderId: string, next: State, patch: InFlightPatch): Promise<void> {
    const prev = this.orders.get(orderId);
    const row: OrderRow = prev !== undefined ? { ...prev, state: next } : { state: next };
    if (patch.seq !== undefined) row.seq = patch.seq;
    if (patch.paymentId !== undefined) row.paymentId = patch.paymentId;
    if (patch.hashHex !== undefined) row.hashHex = patch.hashHex;
    if (patch.signedXdr !== undefined) row.signedXdr = patch.signedXdr;
    if (patch.channelPublic !== undefined) row.channelPublic = patch.channelPublic;
    this.orders.set(orderId, row);
  }

  /**
   * Record the quarantine, once. The flag is a MARKER a human (and the poll worker's latch) reads, not an event
   * stream: the escalate path can be reached on every recovery tick for the same order, and an unconditional push
   * would grow one row per tick and bury the single row that matters. Keyed on (orderId, bucket) — the two buckets
   * are different facts about the same order and must both survive. The FIRST witness wins: a later call may carry
   * a null hash (the crash-recovery path has no witness), and forgetting a hash we already hold would be a
   * regression, never a correction.
   */
  async flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void> {
    const buckets = this.lossBuckets.get(orderId) ?? new Set<LossBucket>();
    if (buckets.has(bucket)) return;
    buckets.add(bucket);
    this.lossBuckets.set(orderId, buckets);
    this.losses.push({ orderId, bucket, usdcTxHash, atMs: 0 });
  }

  /** Has this order been quarantined, in any bucket? The poll worker's work-list skips it if so — an escalated
   *  order has no core event to transition on, so it keeps its in-flight state and would otherwise be re-driven
   *  (and re-escalated) forever. This is where the driver's "recovery must not re-drive a loss-flagged order" is
   *  enforced. */
  isLossFlagged(orderId: string): boolean {
    return this.lossBuckets.has(orderId);
  }

  async markWebhookSeen(
    eventId: string,
    orderId: string,
    nowMs: number,
  ): Promise<'first' | 'duplicate'> {
    if (this.webhooks.has(eventId)) return 'duplicate';
    this.webhooks.set(eventId, { orderId, seenAtMs: nowMs });
    return 'first';
  }

  /** DURABLE FIRST, memory second. A log throw leaves the row unrecorded, so the caller's effect retries whole.
   *  Still a strictly-synchronous read-modify-write (the sink's write is sync), so it stays atomic on the event
   *  loop and must NOT self-take the caller's per-order lock. At-least-once by design: a crash between the
   *  append and the push replays the row on the next drive, and replay dedupes it. */
  async appendEvidence(orderId: string, record: EvidenceRecord, order: OrderFacts): Promise<void> {
    const row: EvidenceRow = { orderId, record, order };
    this.evidenceLog?.append(encodeEvidenceRow(row));
    this.evidence.push(row);
  }

  async bumpDeadRetries(orderId: string): Promise<number> {
    const n = (this.deadRetries.get(orderId) ?? 0) + 1;
    this.deadRetries.set(orderId, n);
    return n;
  }
  async bumpReversalRetries(orderId: string): Promise<number> {
    const n = (this.reversalRetries.get(orderId) ?? 0) + 1;
    this.reversalRetries.set(orderId, n);
    return n;
  }
  async bumpRevertOtherRetries(orderId: string): Promise<number> {
    const n = (this.revertOtherRetries.get(orderId) ?? 0) + 1;
    this.revertOtherRetries.set(orderId, n);
    return n;
  }

  // availableStroops satisfies the Store interface (money-first circuit-breaker read); the rest are read-side
  // helpers for the composition root / tests only.

  availableStroops(): bigint {
    return this.ledger.available();
  }
  poolBalanceStroops(): bigint {
    return this.ledger.balance();
  }
  orderRow(orderId: string): Readonly<OrderRow> | undefined {
    return this.orders.get(orderId);
  }
  lossRecords(): readonly LossRow[] {
    return this.losses;
  }
  /** A frozen snapshot copy — the append-only log can never be spliced through this accessor. */
  evidenceRecords(): readonly EvidenceRow[] {
    return Object.freeze([...this.evidence]);
  }

  /**
   * The durable roll of money-good payouts, which is exactly the evidence log read as a work-list.
   *
   * A row is written the instant the pay() is witnessed on chain, and UsdcConfirmed is forward-only — so a row is
   * the durable proof that this order settled and still owes its accounting. The settlement worker reads THIS,
   * not the in-memory registry, so a crash a second after confirmation no longer strands the order's booking and
   * its pool refill. Deduped, because the log is at-least-once: a crash between the durable append and the
   * in-memory push replays the row on the next drive.
   */
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
