import { canonicalizeOrderId } from './derive-ids.js';

// Invariant ② — DOUBLE-PAY SHIELD (USDC). The operator classic account has a single sequence space
// (Stellar tx seqNum = account seq + 1, strictly sequential). This allocator is the DB-authoritative,
// single-writer owner of that space: sequences are handed out monotonically and NEVER read from the
// network (allocation is authoritative; whether a seq actually burned on-chain is a separate, network
// concern handled by the deadness path). See docs/ARCHITECTURE.md §6.
//
// Two on-chain outcomes drive the seq lifecycle, and they are OPPOSITE — the allocator enforces the
// distinction so a state-machine bug cannot mix them:
//   - USDC_DEAD: the tx was submitted but never landed; the seq is STILL UNBURNED → same-seq
//     replacement is valid (reuseOnDead requires an ACTIVE seq).
//   - USDC_REVERTED: the tx landed and reverted; the seq is BURNED forever → same-seq replay would
//     loop on txBAD_SEQ → forbidden; a NEW seq is required (reallocate requires a BURNED seq).
//
// Single-writer: Node is single-threaded, so in-process access is serialized. A Phase-4 DB-backed
// SequenceStore MUST serialize writes (e.g. SELECT ... FOR UPDATE) to preserve this across processes.
// Channel accounts (Phase-2 concurrency) implement the same SequenceProvider seam.

export type SeqStatus = 'active' | 'burned';

export interface SeqRecord {
  readonly seq: bigint;
  readonly orderId: string; // canonical (NFC)
  readonly status: SeqStatus;
}

export interface SequenceSnapshot {
  readonly baseSeq: bigint; // operator account seq observed at bootstrap
  readonly nextSeq: bigint; // next fresh seq to hand out
  readonly freeList: readonly bigint[]; // released, unburned seqs available for reuse (sorted asc)
  readonly records: readonly SeqRecord[];
  // The per-order current-seq pointer MUST be persisted explicitly: with free-list reuse a fresh
  // (reallocated) seq can be LOWER than the order's earlier burned seq, so the pointer is NOT
  // recoverable as "max seq per order". Omitting it corrupts restore into a double-pay (see tests).
  readonly byOrder: readonly (readonly [string, bigint])[];
}

export type SequenceErrorCode =
  | 'UnknownSeq'
  | 'SeqOrderMismatch'
  | 'SeqNotActive' // reuseOnDead/release require an active (unburned) seq
  | 'SeqNotBurned' // reallocate requires the order's current seq to be burned
  | 'NoActiveAllocation';

export class SequenceError extends Error {
  readonly code: SequenceErrorCode;
  constructor(code: SequenceErrorCode, message: string) {
    super(message);
    this.name = 'SequenceError';
    this.code = code;
  }
}

/** Persistence seam. In-memory for Phase 1; a DB-backed store (single-writer) arrives in Phase 4. */
export interface SequenceStore {
  read(): SequenceSnapshot | null;
  write(snapshot: SequenceSnapshot): void;
}

export class InMemorySequenceStore implements SequenceStore {
  private state: SequenceSnapshot | null = null;
  read(): SequenceSnapshot | null {
    return this.state;
  }
  write(snapshot: SequenceSnapshot): void {
    this.state = snapshot;
  }
}

/** The seam channel-account pools will implement in Phase 2 (concurrency). */
export interface SequenceProvider {
  allocate(orderId: string): bigint;
  confirmBurned(seq: bigint): void;
  reuseOnDead(seq: bigint, orderId: string): bigint;
  release(seq: bigint, orderId: string): void;
  reallocate(orderId: string): bigint;
}

function insertSorted(arr: bigint[], value: bigint): void {
  let i = 0;
  while (i < arr.length && (arr[i] as bigint) < value) i++;
  arr.splice(i, 0, value);
}

export class SequenceAllocator implements SequenceProvider {
  private readonly baseSeq: bigint;
  private nextSeq: bigint;
  private readonly freeList: bigint[]; // sorted ascending; lowest reused first (gap-free on-chain)
  private readonly bySeq = new Map<bigint, SeqRecord>();
  // "current seq" pointer per order = the highest seq ever allocated to it that has not been released
  // (invariant maintained by every mutation, and rebuilt as max-seq-per-order on restore).
  private readonly byOrder = new Map<string, bigint>();

  /**
   * @param store persistence seam (state is re-hydrated from it if present)
   * @param baseSeq the operator account's on-chain sequence at bootstrap; used only when the store
   *   is empty. The first allocation returns baseSeq + 1.
   */
  constructor(
    private readonly store: SequenceStore,
    baseSeq: bigint,
  ) {
    const persisted = store.read();
    if (persisted) {
      this.baseSeq = persisted.baseSeq;
      this.nextSeq = persisted.nextSeq;
      this.freeList = [...persisted.freeList];
      for (const rec of persisted.records) this.bySeq.set(rec.seq, rec);
      // Restore the current-seq pointer DIRECTLY from the snapshot — never re-derive it, because
      // free-list reuse can make an order's current seq lower than an earlier burned seq of its own.
      for (const [orderId, seq] of persisted.byOrder) this.byOrder.set(orderId, seq);
    } else {
      this.baseSeq = baseSeq;
      this.nextSeq = baseSeq + 1n;
      this.freeList = [];
      this.persist();
    }
  }

  /** Idempotent per-order: the same order always maps to the same seq and never consumes a new one. */
  allocate(orderIdRaw: string): bigint {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const existing = this.byOrder.get(orderId);
    if (existing !== undefined) return existing;
    const seq = this.takeSeq();
    this.bySeq.set(seq, { seq, orderId, status: 'active' });
    this.byOrder.set(orderId, seq);
    this.persist();
    return seq;
  }

  /** Mark a seq as consumed on-chain (the tx landed — confirmed or reverted). Idempotent. */
  confirmBurned(seq: bigint): void {
    const rec = this.bySeq.get(seq);
    if (!rec) throw new SequenceError('UnknownSeq', `seq ${seq} is not tracked`);
    if (rec.status === 'burned') return;
    this.bySeq.set(seq, { ...rec, status: 'burned' });
    this.persist();
  }

  /**
   * USDC_DEAD path: pin an unburned seq to the SAME order for a same-seq replacement, without a
   * round-trip through the free pool (no collision window). Requires the seq to still be ACTIVE —
   * a burned seq here is a REVERTED case and must use reallocate instead.
   */
  reuseOnDead(seq: bigint, orderIdRaw: string): bigint {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const rec = this.requireOwned(seq, orderId);
    if (rec.status !== 'active') {
      throw new SequenceError('SeqNotActive', `seq ${seq} is burned; a dead seq must be unburned`);
    }
    return seq;
  }

  /**
   * True-abandonment: return an unburned seq to the pool for reuse by the next order. Precondition
   * (the CALLER's responsibility): the seq is provably unburned and can never land — either it was
   * never submitted, or it was proven dead by the deadness criterion (ledger closeTime > maxTime and
   * network seq < S and no evidence hash SUCCESS). The allocator enforces only that the seq is not
   * BURNED; the on-chain sequence shield (invariant ②, txBAD_SEQ) backstops any caller misuse. No
   * bump_sequence — this is purely local re-allocation.
   */
  release(seq: bigint, orderIdRaw: string): void {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const rec = this.requireOwned(seq, orderId);
    if (rec.status !== 'active') {
      throw new SequenceError('SeqNotActive', `seq ${seq} is burned and cannot be released`);
    }
    this.bySeq.delete(seq);
    this.byOrder.delete(orderId);
    insertSorted(this.freeList, seq);
    this.persist();
  }

  /**
   * USDC_REVERTED ("other" branch): the order's current seq burned on-chain, so a same-seq replay is
   * impossible (txBAD_SEQ). Abandon the burned seq and hand the order a fresh one. Requires the
   * current seq to be BURNED (an active seq here is a DEAD case → use reuseOnDead).
   */
  reallocate(orderIdRaw: string): bigint {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const currentSeq = this.byOrder.get(orderId);
    if (currentSeq === undefined) {
      throw new SequenceError('NoActiveAllocation', `order has no allocation`);
    }
    const current = this.bySeq.get(currentSeq);
    if (!current || current.status !== 'burned') {
      throw new SequenceError('SeqNotBurned', `seq ${currentSeq} is not burned; use reuseOnDead`);
    }
    const seq = this.takeSeq();
    this.bySeq.set(seq, { seq, orderId, status: 'active' });
    this.byOrder.set(orderId, seq);
    this.persist();
    return seq;
  }

  /** Current active seq for an order, or undefined if none / already burned / released. */
  activeSeqFor(orderIdRaw: string): bigint | undefined {
    const seq = this.byOrder.get(canonicalizeOrderId(orderIdRaw));
    if (seq === undefined) return undefined;
    return this.bySeq.get(seq)?.status === 'active' ? seq : undefined;
  }

  statusOf(seq: bigint): SeqStatus | undefined {
    return this.bySeq.get(seq)?.status;
  }

  snapshot(): SequenceSnapshot {
    return {
      baseSeq: this.baseSeq,
      nextSeq: this.nextSeq,
      freeList: [...this.freeList],
      records: [...this.bySeq.values()],
      byOrder: [...this.byOrder.entries()],
    };
  }

  private takeSeq(): bigint {
    const reused = this.freeList.shift();
    if (reused !== undefined) return reused;
    const seq = this.nextSeq;
    this.nextSeq = this.nextSeq + 1n;
    return seq;
  }

  private requireOwned(seq: bigint, orderId: string): SeqRecord {
    const rec = this.bySeq.get(seq);
    if (!rec) throw new SequenceError('UnknownSeq', `seq ${seq} is not tracked`);
    if (rec.orderId !== orderId) {
      throw new SequenceError('SeqOrderMismatch', `seq ${seq} belongs to a different order`);
    }
    return rec;
  }

  private persist(): void {
    this.store.write(this.snapshot());
  }
}
