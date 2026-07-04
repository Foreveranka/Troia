// Async serialization primitives. The pool Mutex makes reserve()'s CHECK->(durable write)->COMMIT atomic so
// two concurrent solvency reservations can never both pass the check and over-commit the pool (SPIKE-3). The
// KeyedMutex (withOrderLock) serializes all of one order's mutating work so its Store writes + engine advance
// run single-writer (crash-safe ordering). Node is single-threaded, so these guard the ONLY hazard that
// exists here: interleaving across `await` points inside a critical section.

/** The minimal lock surface the Store depends on (so a test can inject a NoOpMutex to prove the real lock is
 *  load-bearing). */
export interface Lock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * A FIFO async mutex. run(fn) queues fn behind all prior fns and resolves/rejects with fn's own result.
 *
 * The two-promise split is LOAD-BEARING: `result` carries fn's rejection to THIS caller only, while the
 * separate `tail = result.then(noop, noop)` swallows it so the next queued fn always runs. A naive
 * `this.tail = this.tail.then(fn)` would poison the lock permanently on the first throw (every later fn
 * chains onto a rejected tail -> never runs, every caller sees the FIRST caller's error, and the trailing
 * rejected tail triggers an unhandledRejection).
 */
export class Mutex implements Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

interface KeyEntry {
  readonly mutex: Mutex;
  waiters: number;
}

/** Per-key mutex with refcount eviction, so a long-running bridge doesn't retain one Mutex per orderId
 *  forever. get/create/waiters++ run synchronously inside run(), so waiters never spuriously hits 0 while a
 *  caller is queued; the `=== entry` guard makes the delete safe against a freshly-recreated key. */
export class KeyedMutex {
  private readonly locks = new Map<string, KeyEntry>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (entry === undefined) {
      entry = { mutex: new Mutex(), waiters: 0 };
      this.locks.set(key, entry);
    }
    const e = entry;
    e.waiters += 1;
    return e.mutex.run(fn).finally(() => {
      e.waiters -= 1;
      if (e.waiters === 0 && this.locks.get(key) === e) this.locks.delete(key);
    });
  }

  /** number of currently-tracked keys (for the eviction test). */
  size(): number {
    return this.locks.size;
  }
}
