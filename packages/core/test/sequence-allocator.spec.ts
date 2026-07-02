import { describe, expect, it } from 'vitest';
import { InMemorySequenceStore, SequenceAllocator, SequenceError } from '../src/index.js';

const BASE = 1000n;

function fresh(): SequenceAllocator {
  return new SequenceAllocator(new InMemorySequenceStore(), BASE);
}

function expectSeqError(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable('should have thrown SequenceError');
  } catch (e) {
    expect(e).toBeInstanceOf(SequenceError);
    expect((e as SequenceError).code).toBe(code);
  }
}

describe('SequenceAllocator — allocate', () => {
  it('hands out monotonically increasing seqs starting at baseSeq + 1', () => {
    const a = fresh();
    expect(a.allocate('ord-1')).toBe(1001n);
    expect(a.allocate('ord-2')).toBe(1002n);
    expect(a.allocate('ord-3')).toBe(1003n);
  });

  it('is idempotent per order (same order → same seq, no new consumption)', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    expect(a.allocate('ord-1')).toBe(s);
    expect(a.allocate('ord-1')).toBe(s);
    // a different order still gets the next fresh seq, proving no seq was wasted
    expect(a.allocate('ord-2')).toBe(s + 1n);
  });

  it('canonicalizes order_id: NFD and NFC forms map to the same seq', () => {
    const a = fresh();
    const nfd = 'cafe\u0301'; // decomposed: 'cafe' + U+0301 combining acute accent
    const nfc = 'caf\u00e9'; // precomposed: 'caf' + U+00E9 (NFC)
    expect(nfd).not.toBe(nfc);
    const s = a.allocate(nfd);
    expect(a.allocate(nfc)).toBe(s);
  });
});

describe('SequenceAllocator — confirmBurned', () => {
  it('marks a seq burned and is idempotent', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    expect(a.statusOf(s)).toBe('active');
    a.confirmBurned(s);
    expect(a.statusOf(s)).toBe('burned');
    a.confirmBurned(s); // idempotent, no throw
    expect(a.statusOf(s)).toBe('burned');
  });

  it('throws UnknownSeq for an untracked seq', () => {
    const a = fresh();
    expectSeqError(() => a.confirmBurned(999999n), 'UnknownSeq');
  });

  it('a burned seq is no longer the active allocation for its order', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    a.confirmBurned(s);
    expect(a.activeSeqFor('ord-1')).toBeUndefined();
  });
});

describe('SequenceAllocator — reuseOnDead (DEAD: seq still unburned)', () => {
  it('pins an active seq to the same order and returns it', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    expect(a.reuseOnDead(s, 'ord-1')).toBe(s);
    // still the active allocation, no new seq consumed
    expect(a.activeSeqFor('ord-1')).toBe(s);
    expect(a.allocate('ord-2')).toBe(s + 1n);
  });

  it('rejects reusing a BURNED seq (that is a REVERTED case → reallocate)', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    a.confirmBurned(s);
    expectSeqError(() => a.reuseOnDead(s, 'ord-1'), 'SeqNotActive');
  });

  it('rejects a seq owned by a different order', () => {
    const a = fresh();
    const s1 = a.allocate('ord-1');
    a.allocate('ord-2');
    expectSeqError(() => a.reuseOnDead(s1, 'ord-2'), 'SeqOrderMismatch');
  });

  it('rejects an unknown seq', () => {
    const a = fresh();
    expectSeqError(() => a.reuseOnDead(42n, 'ord-1'), 'UnknownSeq');
  });
});

describe('SequenceAllocator — release (true-abandonment, gap-free reuse)', () => {
  it('returns an unburned seq to the pool; the next order reuses the lowest free seq', () => {
    const a = fresh();
    const s1 = a.allocate('ord-1'); // 1001
    const s2 = a.allocate('ord-2'); // 1002
    a.release(s2, 'ord-2');
    // next allocation reuses the released seq (gap-free), not 1003
    expect(a.allocate('ord-3')).toBe(s2);
    expect(a.activeSeqFor('ord-1')).toBe(s1);
  });

  it('reuses the LOWEST released seq first', () => {
    const a = fresh();
    const s1 = a.allocate('ord-1'); // 1001
    const s2 = a.allocate('ord-2'); // 1002
    const s3 = a.allocate('ord-3'); // 1003
    a.release(s3, 'ord-3');
    a.release(s1, 'ord-1');
    expect(a.allocate('ord-4')).toBe(s1); // 1001, the lowest free
    expect(a.allocate('ord-5')).toBe(s3); // 1003, next lowest
    expect(a.allocate('ord-6')).toBe(s2 + 2n); // 1004, fresh
  });

  it('rejects releasing a burned seq', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    a.confirmBurned(s);
    expectSeqError(() => a.release(s, 'ord-1'), 'SeqNotActive');
  });

  it('rejects releasing a seq owned by another order', () => {
    const a = fresh();
    const s1 = a.allocate('ord-1');
    a.allocate('ord-2');
    expectSeqError(() => a.release(s1, 'ord-2'), 'SeqOrderMismatch');
  });
});

describe('SequenceAllocator — reallocate (REVERTED: seq burned, need a new one)', () => {
  it('hands the order a fresh seq after its current seq is burned', () => {
    const a = fresh();
    const s = a.allocate('ord-1'); // 1001
    a.confirmBurned(s);
    const s2 = a.reallocate('ord-1'); // fresh 1002, order repointed
    expect(s2).toBe(1002n);
    expect(a.activeSeqFor('ord-1')).toBe(s2);
    expect(a.statusOf(s)).toBe('burned'); // old seq stays burned (retained for audit)
  });

  it('rejects reallocating when the current seq is still ACTIVE (that is a DEAD case)', () => {
    const a = fresh();
    a.allocate('ord-1');
    expectSeqError(() => a.reallocate('ord-1'), 'SeqNotBurned');
  });

  it('rejects reallocating an order with no allocation', () => {
    const a = fresh();
    expectSeqError(() => a.reallocate('ord-unknown'), 'NoActiveAllocation');
  });

  it('supports repeated revert→reallocate cycles', () => {
    const a = fresh();
    const s1 = a.allocate('ord-1');
    a.confirmBurned(s1);
    const s2 = a.reallocate('ord-1');
    a.confirmBurned(s2);
    const s3 = a.reallocate('ord-1');
    expect([s1, s2, s3]).toEqual([1001n, 1002n, 1003n]);
    expect(a.activeSeqFor('ord-1')).toBe(s3);
  });
});

describe('SequenceAllocator — lifecycle & persistence', () => {
  it('a full happy lifecycle: allocate → burn → order done', () => {
    const a = fresh();
    const s = a.allocate('ord-1');
    a.confirmBurned(s);
    expect(a.activeSeqFor('ord-1')).toBeUndefined();
    expect(a.statusOf(s)).toBe('burned');
  });

  it('persists to the store and restores byte-for-byte via a new allocator', () => {
    const store = new InMemorySequenceStore();
    const a = new SequenceAllocator(store, BASE);
    const s1 = a.allocate('ord-1');
    a.confirmBurned(s1);
    const s2 = a.reallocate('ord-1');
    a.allocate('ord-2');
    a.release(a.allocate('ord-3'), 'ord-3'); // leaves a free seq

    const snap = a.snapshot();
    const restored = new SequenceAllocator(store, 0n); // baseSeq ignored: store has state
    expect(restored.snapshot()).toEqual(snap);
    // the restored allocator continues correctly: next order reuses the freed seq
    expect(restored.allocate('ord-4')).toBe(s2 + 2n); // freed ord-3 seq (1004) reused
    expect(restored.activeSeqFor('ord-1')).toBe(s2);
  });

  it('release frees a seq that survives a restore', () => {
    const store = new InMemorySequenceStore();
    const a = new SequenceAllocator(store, BASE);
    a.allocate('ord-1'); // 1001
    const s2 = a.allocate('ord-2'); // 1002
    a.release(s2, 'ord-2');
    const restored = new SequenceAllocator(store, 0n);
    expect(restored.allocate('ord-3')).toBe(s2); // 1002 reused after restore
  });

  // Regression: a reallocated seq can be LOWER than the order's earlier burned seq (free-list reuse).
  // The current-seq pointer must be persisted, not re-derived as max-seq — else restore drops the live
  // active seq, hands out a burned seq, and lets reallocate mint a SECOND active seq (double-pay).
  it('preserves the current-seq pointer across restore when a reallocated seq is lower than a burned one', () => {
    const store = new InMemorySequenceStore();
    const a = new SequenceAllocator(store, 25n);
    a.allocate('B'); // 26
    a.allocate('A'); // 27
    a.confirmBurned(27n); // A's 27 reverted -> burned
    a.release(26n, 'B'); // B abandoned -> freeList = [26]
    const reused = a.reallocate('A'); // reuses freed 26 (LOWER than A's burned 27)
    expect(reused).toBe(26n);
    expect(a.activeSeqFor('A')).toBe(26n);

    const restored = new SequenceAllocator(store, 0n);
    // The live active seq survives; a burned seq is never handed out; a second active seq is impossible.
    expect(restored.activeSeqFor('A')).toBe(26n);
    expect(restored.allocate('A')).toBe(26n); // idempotent, NOT the burned 27
    expectSeqError(() => restored.reallocate('A'), 'SeqNotBurned'); // A's current 26 is active
    const activeForA = restored.snapshot().records.filter((r) => r.orderId === 'A' && r.status === 'active');
    expect(activeForA.map((r) => r.seq)).toEqual([26n]); // exactly ONE active seq
  });

  // Regression: releasing a reallocated order leaves its old burned record in bySeq. Restore must NOT
  // resurrect the order by re-pointing byOrder at that burned seq (which would let reallocate mint a seq).
  it('does not resurrect a released order across restore (burned record must not become the pointer)', () => {
    const store = new InMemorySequenceStore();
    const a = new SequenceAllocator(store, 40n);
    const s1 = a.allocate('X'); // 41
    a.confirmBurned(s1); // 41 burned
    const s2 = a.reallocate('X'); // 42 active
    a.release(s2, 'X'); // X truly abandoned; old burned 41 record remains in bySeq
    expect(a.activeSeqFor('X')).toBeUndefined();

    const restored = new SequenceAllocator(store, 0n);
    expect(restored.activeSeqFor('X')).toBeUndefined(); // not resurrected
    expectSeqError(() => restored.reallocate('X'), 'NoActiveAllocation'); // cannot mint for a dead order
  });
});
