// A-5 groundwork: the channel-account sequence pool — the SequenceProvider the parallel-payout design
// (docs/CHANNEL_ACCOUNTS_DESIGN.md) plugs into the engine's existing seam. One SequenceAllocator per channel
// account, a STICKY per-order channel assignment on top, and fail-closed disambiguation everywhere a bare
// sequence number stops being unique.
//
// WHY STICKINESS IS MONEY-CRITICAL. The double-pay shield (invariant ②) is per ACCOUNT: "at most one tx per
// sequence" only protects an order if every retry of that order rides the SAME account's sequence space. A
// same-seq replacement submitted through a different channel would be a fresh, independent transaction — the
// exact double-pay the shield exists to prevent. So an order is assigned a channel once, every seq operation
// routes through that channel, and the assignment is part of the persisted state (a restart must not re-deal).
//
// WHY BARE SEQ NUMBERS AMBIGUATE. A Stellar account's starting sequence is derived from the ledger that
// created it — channels created in the SAME ledger start at the SAME number, so "seq 12345" can be live on
// several channels at once. Every routing here therefore prefers the orderId; the orderId-less confirmBurned
// path resolves a bare seq only when it is unique across channels and THROWS when it is not (fail-closed:
// guessing which channel burned would corrupt the shield's bookkeeping).
//
// NOT YET WIRED. The engine still runs the single-operator allocator; this pool goes live only with the rest
// of the channel design (channel tx sources + signed operator auth entries + per-channel deadness reads).

import { canonicalizeOrderId } from './derive-ids.js';
import { InMemorySequenceStore, SequenceAllocator, SequenceError } from './sequence-allocator.js';
import type { SequenceProvider, SequenceStore } from './sequence-allocator.js';

/** One channel account: its G-address and its on-chain sequence at bootstrap (a fresh chain read, exactly
 *  like the operator's today), plus an optional persistence seam for its allocator state. */
export interface ChannelConfig {
  readonly publicKey: string;
  readonly baseSeq: bigint;
  readonly store?: SequenceStore;
}

/** Persistence seam for the order -> channel assignment. As money-critical as the seq snapshots themselves:
 *  losing it across a restart would let a retry re-deal an in-flight order onto a different channel. */
export interface ChannelMapStore {
  read(): readonly (readonly [string, string])[] | null;
  write(entries: readonly (readonly [string, string])[]): void;
}

export class InMemoryChannelMapStore implements ChannelMapStore {
  private state: readonly (readonly [string, string])[] | null = null;
  read(): readonly (readonly [string, string])[] | null {
    return this.state;
  }
  write(entries: readonly (readonly [string, string])[]): void {
    this.state = entries;
  }
}

interface Channel {
  readonly publicKey: string;
  readonly allocator: SequenceAllocator;
}

export class ChannelPoolProvider implements SequenceProvider {
  private readonly channels: readonly Channel[];
  private readonly byPublicKey = new Map<string, Channel>();
  /** canonical orderId -> channel publicKey. STICKY for the life of the allocation (see the header). */
  private readonly orderChannel = new Map<string, string>();
  private readonly mapStore: ChannelMapStore;

  constructor(configs: readonly ChannelConfig[], mapStore?: ChannelMapStore) {
    if (configs.length === 0) throw new RangeError('channel pool needs at least one channel');
    const seen = new Set<string>();
    for (const c of configs) {
      if (seen.has(c.publicKey)) throw new RangeError(`duplicate channel ${c.publicKey}`);
      seen.add(c.publicKey);
    }
    this.channels = configs.map((c) => ({
      publicKey: c.publicKey,
      allocator: new SequenceAllocator(c.store ?? new InMemorySequenceStore(), c.baseSeq),
    }));
    for (const ch of this.channels) this.byPublicKey.set(ch.publicKey, ch);
    this.mapStore = mapStore ?? new InMemoryChannelMapStore();
    for (const [orderId, publicKey] of this.mapStore.read() ?? []) {
      if (!this.byPublicKey.has(publicKey)) {
        // A persisted assignment onto a channel this boot does not know is a config regression — refusing to
        // start beats silently re-dealing an in-flight order onto a different sequence space.
        throw new SequenceError(
          'UnknownSeq',
          `order ${orderId} is assigned to channel ${publicKey}, which is not in this pool's config`,
        );
      }
      this.orderChannel.set(orderId, publicKey);
    }
  }

  /** The tx SOURCE for this order's pay() — the channel its sequences come from. Undefined before the first
   *  allocate (nothing assigned yet). */
  channelFor(orderIdRaw: string): string | undefined {
    return this.orderChannel.get(canonicalizeOrderId(orderIdRaw));
  }

  /** Idempotent per order (delegates to the sticky channel's allocator). A NEW order gets the least-loaded
   *  channel — fewest live allocations — so concurrent orders spread across sequence spaces, which is the
   *  entire point of the pool. */
  allocate(orderIdRaw: string): bigint {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const channel = this.channelOf(orderId) ?? this.assign(orderId);
    return channel.allocator.allocate(orderId);
  }

  confirmBurned(seq: bigint, orderIdRaw?: string): void {
    if (orderIdRaw !== undefined) {
      this.requireChannel(orderIdRaw).allocator.confirmBurned(seq);
      return;
    }
    // Bare-seq fallback: resolvable only while the ACTIVE holder is unique. Channels created in the same
    // ledger share starting sequences, so ambiguity is REAL — refuse rather than guess (see the header).
    // An already-burned record is not a candidate: burning it again is the allocator's idempotent no-op.
    const active = this.channels.filter((c) => c.allocator.statusOf(seq) === 'active');
    if (active.length === 1) {
      (active[0] as Channel).allocator.confirmBurned(seq);
      return;
    }
    if (active.length === 0) {
      if (this.channels.some((c) => c.allocator.statusOf(seq) === 'burned')) return; // idempotent
      throw new SequenceError('UnknownSeq', `seq ${seq} is not tracked by any channel`);
    }
    throw new SequenceError(
      'SeqOrderMismatch',
      `seq ${seq} is active on ${active.length} channels — pass the orderId to disambiguate`,
    );
  }

  reuseOnDead(seq: bigint, orderIdRaw: string): bigint {
    return this.requireChannel(orderIdRaw).allocator.reuseOnDead(seq, orderIdRaw);
  }

  /** Terminal abandonment: the seq returns to ITS channel's free list and the sticky assignment dissolves —
   *  a future order under the same id starts fresh and may land on any channel. */
  release(seq: bigint, orderIdRaw: string): void {
    const orderId = canonicalizeOrderId(orderIdRaw);
    this.requireChannel(orderId).allocator.release(seq, orderId);
    this.orderChannel.delete(orderId);
    this.persistMap();
  }

  /** USDC_REVERTED: a fresh seq FROM THE SAME CHANNEL — the burned seq's bookkeeping lives there, and the
   *  shield's per-account arithmetic must stay in one sequence space per order. */
  reallocate(orderIdRaw: string): bigint {
    return this.requireChannel(orderIdRaw).allocator.reallocate(orderIdRaw);
  }

  /** Live allocations per channel — the observability read (and the least-loaded policy's input). */
  loads(): readonly { publicKey: string; active: number }[] {
    return this.channels.map((c) => ({
      publicKey: c.publicKey,
      active: c.allocator.snapshot().byOrder.length,
    }));
  }

  private channelOf(orderId: string): Channel | undefined {
    const publicKey = this.orderChannel.get(orderId);
    return publicKey === undefined ? undefined : this.byPublicKey.get(publicKey);
  }

  private requireChannel(orderIdRaw: string): Channel {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const channel = this.channelOf(orderId);
    if (channel === undefined) {
      throw new SequenceError('NoActiveAllocation', `order has no channel assignment`);
    }
    return channel;
  }

  private assign(orderId: string): Channel {
    let best: Channel = this.channels[0] as Channel;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const c of this.channels) {
      const load = c.allocator.snapshot().byOrder.length;
      if (load < bestLoad) {
        best = c;
        bestLoad = load;
      }
    }
    this.orderChannel.set(orderId, best.publicKey);
    this.persistMap();
    return best;
  }

  private persistMap(): void {
    this.mapStore.write([...this.orderChannel.entries()]);
  }
}
