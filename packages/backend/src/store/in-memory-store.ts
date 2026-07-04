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
  EvidenceRecord,
  InFlightPatch,
  LossBucket,
  ReleaseReason,
  ReserveOutcome,
  Store,
} from '../ports.js';
import { Mutex } from './mutex.js';
import type { Lock } from './mutex.js';
import { ReservationLedger } from './reservation-ledger.js';

interface OrderRow {
  state: State;
  seq?: string;
  paymentId?: string;
  hashHex?: string;
  signedXdr?: string;
}

interface LossRow {
  readonly orderId: string;
  readonly bucket: LossBucket;
  readonly usdcTxHash: string | null;
  readonly atMs: number;
}
interface EvidenceRow {
  readonly orderId: string;
  readonly record: EvidenceRecord;
}

export interface InMemoryStoreOptions {
  readonly balanceStroops: bigint;
  /** operator account seq at bootstrap; the SequenceAllocator hands out baseSeq+1 first. */
  readonly baseSeq: bigint;
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
  private readonly deadRetries = new Map<string, number>();
  private readonly reversalRetries = new Map<string, number>();

  constructor(opts: InMemoryStoreOptions) {
    this.ledger = new ReservationLedger(opts.balanceStroops);
    this.sequences = new SequenceAllocator(new InMemorySequenceStore(), opts.baseSeq);
    this.poolMutex = opts.poolMutex ?? new Mutex();
    this.beforeReserveCommit = opts.beforeReserveCommit;
  }

  // --- SPIKE-3 solvency (the money-critical path) ---

  reserve(orderId: string, amountStroops: bigint, ttlMs: number, nowMs: number): Promise<ReserveOutcome> {
    return this.poolMutex.run(async () => {
      // Idempotent per order (at-least-once /intent + solvency recheck on replay). A same-order re-reserve
      // for a DIFFERENT amount fails closed (amount is immutable per order today; a mismatch is a bug).
      const existing = this.ledger.reservationFor(orderId);
      if (existing !== undefined) {
        if (existing.amountStroops !== amountStroops) {
          return { kind: 'insufficient', available: this.ledger.available(), requested: amountStroops };
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
    this.orders.set(orderId, row);
  }

  async flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void> {
    this.losses.push({ orderId, bucket, usdcTxHash, atMs: 0 });
  }

  async markWebhookSeen(eventId: string, orderId: string, nowMs: number): Promise<'first' | 'duplicate'> {
    if (this.webhooks.has(eventId)) return 'duplicate';
    this.webhooks.set(eventId, { orderId, seenAtMs: nowMs });
    return 'first';
  }

  async appendEvidence(orderId: string, record: EvidenceRecord): Promise<void> {
    this.evidence.push({ orderId, record });
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
  evidenceRecords(): readonly EvidenceRow[] {
    return this.evidence;
  }
}
