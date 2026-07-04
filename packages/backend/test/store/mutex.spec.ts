import { describe, expect, it } from 'vitest';
import { KeyedMutex, Mutex } from '../../src/store/mutex.js';

const microtask = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe('Mutex', () => {
  it('T1: a throwing critical section releases the lock (no deadlock) and errors only its own caller', async () => {
    const m = new Mutex();
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown): void => {
      unhandled = e;
    };
    process.on('unhandledRejection', onUnhandled);

    await expect(m.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // the lock must still work — the next fn runs and its OWN result comes back (not 'boom')
    await expect(m.run(async () => 42)).resolves.toBe(42);

    await microtask();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toBeNull(); // the swallowed tail must not surface as an unhandledRejection
  });

  it('T2: runs queued critical sections strictly FIFO even when a later section would finish sooner', async () => {
    const m = new Mutex();
    const order: string[] = [];
    // A yields the MOST microtasks, C the fewest. WITHOUT FIFO serialization the fastest section finishes
    // first -> output [C,B,A]; the mutex must still deliver call-order [A,B,C] regardless of internal timing.
    const cs = (label: string, yields: number) => async (): Promise<void> => {
      for (let i = 0; i < yields; i++) await microtask();
      order.push(label);
    };
    await Promise.all([m.run(cs('A', 3)), m.run(cs('B', 2)), m.run(cs('C', 1))]);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('serializes: two concurrent sections never interleave their read-modify-write', async () => {
    const m = new Mutex();
    let counter = 0;
    const seen: number[] = [];
    const cs = async (): Promise<void> => {
      const read = counter;
      await microtask();
      counter = read + 1;
      seen.push(counter);
    };
    await Promise.all([m.run(cs), m.run(cs)]);
    expect(seen).toEqual([1, 2]); // without the lock both read 0 -> [1, 1]
  });
});

describe('KeyedMutex', () => {
  it('T3: same key mutually excludes; different keys run concurrently; keys evict to 0', async () => {
    const km = new KeyedMutex();
    let shared = 0;
    const seen: number[] = [];
    const cs = async (): Promise<void> => {
      const read = shared;
      await microtask();
      shared = read + 1;
      seen.push(shared);
    };
    // same key -> serialized
    await Promise.all([km.run('k', cs), km.run('k', cs)]);
    expect(seen).toEqual([1, 2]);
    expect(km.size()).toBe(0); // refcount eviction: no retained Mutex after both settle

    // different keys -> independent locks, both progress
    let a = 0;
    let b = 0;
    await Promise.all([
      km.run('a', async () => { a = 1; }),
      km.run('b', async () => { b = 1; }),
    ]);
    expect([a, b]).toEqual([1, 1]);
    expect(km.size()).toBe(0);
  });

  it('a throwing section on one key does not wedge that key', async () => {
    const km = new KeyedMutex();
    await expect(km.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(km.run('k', async () => 7)).resolves.toBe(7);
    expect(km.size()).toBe(0);
  });
});
