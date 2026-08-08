// A-5 groundwork: the channel pool's contract. The stakes are the double-pay shield's per-account
// arithmetic: an order must ride ONE channel's sequence space for its whole life (stickiness), overlapping
// seq numbers across channels must never be guessed at (fail-closed disambiguation), and a restart must
// find the same assignments it left (the map store).

import { describe, expect, it } from 'vitest';
import { ChannelPoolProvider, InMemoryChannelMapStore, SequenceError } from '../src/index.js';
import type { ChannelConfig } from '../src/index.js';

const CH_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5A';
const CH_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUOF4';
const CH_C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCEIP4';

/** Channels created in the SAME ledger: identical starting sequences — the ambiguity case is the default. */
function pool(overrides: Partial<ChannelConfig>[] = [], mapStore = new InMemoryChannelMapStore()) {
  const configs: ChannelConfig[] = [
    { publicKey: CH_A, baseSeq: 1000n },
    { publicKey: CH_B, baseSeq: 1000n },
    { publicKey: CH_C, baseSeq: 1000n },
  ].map((c, i) => ({ ...c, ...overrides[i] }));
  return new ChannelPoolProvider(configs, mapStore);
}

describe('ChannelPoolProvider — assignment and stickiness', () => {
  it('spreads NEW orders across channels (least-loaded), so concurrent orders get independent seq spaces', () => {
    const p = pool();
    p.allocate('o1');
    p.allocate('o2');
    p.allocate('o3');
    const used = new Set([p.channelFor('o1'), p.channelFor('o2'), p.channelFor('o3')]);
    expect(used.size).toBe(3); // three orders, three different sequence spaces — the parallelism itself
    expect(p.loads().every((l) => l.active === 1)).toBe(true);
  });

  it('is idempotent per order and STICKY: every seq operation rides the assigned channel', () => {
    const p = pool();
    const seq = p.allocate('o1');
    expect(p.allocate('o1')).toBe(seq); // same order, same seq, no new consumption
    const home = p.channelFor('o1');
    p.confirmBurned(seq, 'o1');
    const fresh = p.reallocate('o1'); // reverted -> new seq, SAME channel
    expect(p.channelFor('o1')).toBe(home);
    expect(fresh).toBe(seq + 1n);
  });

  it('release dissolves the assignment; the next life of the id may land anywhere and reuse is per-channel', () => {
    const p = pool();
    const seq = p.allocate('o1');
    const home = p.channelFor('o1');
    p.release(seq, 'o1');
    expect(p.channelFor('o1')).toBeUndefined();
    // the freed seq is back on ITS channel's free list: whoever is assigned there reuses it
    p.allocate('oX');
    p.allocate('oY');
    p.allocate('oZ'); // three fresh orders fill the three channels; one of them sits on `home`
    const homeOrder = ['oX', 'oY', 'oZ'].find((o) => p.channelFor(o) === home) as string;
    expect(p.allocate(homeOrder)).toBe(seq); // idempotent read-back: it took the freed seq
  });
});

describe('ChannelPoolProvider — bare-seq ambiguity fails closed', () => {
  it('confirmBurned with an orderId routes correctly even when every channel holds the same seq number', () => {
    const p = pool();
    const s1 = p.allocate('o1');
    const s2 = p.allocate('o2');
    expect(s1).toBe(s2); // same-ledger channels: identical numbers, different accounts — the trap itself
    p.confirmBurned(s1, 'o1');
    // o1's seq is burned on ITS channel; o2's identical NUMBER on another channel is still active
    expect(() => p.reuseOnDead(s2, 'o2')).not.toThrow();
  });

  it('confirmBurned WITHOUT an orderId refuses an ambiguous seq and resolves a unique one', () => {
    const p = pool();
    p.allocate('o1');
    p.allocate('o2'); // seq 1001 now live on two channels
    expect(() => p.confirmBurned(1001n)).toThrow(SequenceError);
    expect(() => p.confirmBurned(999_999n)).toThrow(/not tracked/);
    // burn o2's away via its order — then only o1's 1001 is still ACTIVE, so the bare number resolves
    p.confirmBurned(1001n, 'o2');
    expect(() => p.confirmBurned(1001n)).not.toThrow(); // routed to o1's channel (the unique active holder)
    expect(() => p.confirmBurned(1001n)).not.toThrow(); // and burning again is the idempotent no-op
    expect(() => p.reallocate('o1')).not.toThrow(); // o1 really is burned: reallocate is legal
  });

  it('an operation for an order with no assignment fails closed', () => {
    const p = pool();
    expect(() => p.reuseOnDead(1001n, 'ghost')).toThrow(/no channel assignment/);
    expect(() => p.reallocate('ghost')).toThrow(/no channel assignment/);
  });
});

describe('ChannelPoolProvider — the assignment survives a restart', () => {
  it('rebuilds order->channel from the map store, so a retry cannot re-deal onto another channel', () => {
    const mapStore = new InMemoryChannelMapStore();
    const p1 = pool([], mapStore);
    const seq = p1.allocate('o1');
    const home = p1.channelFor('o1');
    // "crash": rebuild over the same map store AND per-channel seq stores... here channels are in-memory, so
    // re-allocate returns a fresh seq — the assertion is about the CHANNEL, which must come back identical.
    const p2 = pool([], mapStore);
    expect(p2.channelFor('o1')).toBe(home);
    expect(p2.allocate('o1')).toBe(seq); // same channel, same baseSeq -> same first seq
  });

  it('refuses to start when a persisted assignment names a channel missing from the config', () => {
    const mapStore = new InMemoryChannelMapStore();
    mapStore.write([['o1', 'GUNKNOWN']]);
    expect(() => pool([], mapStore)).toThrow(/not in this pool's config/);
  });

  it('refuses duplicate channels and an empty pool', () => {
    expect(() => new ChannelPoolProvider([])).toThrow(/at least one/);
    expect(
      () =>
        new ChannelPoolProvider([
          { publicKey: CH_A, baseSeq: 1n },
          { publicKey: CH_A, baseSeq: 2n },
        ]),
    ).toThrow(/duplicate/);
  });
});
