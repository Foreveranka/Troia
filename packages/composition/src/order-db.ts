// The durable order database (A-1): a single SQLite file holding everything KNOWN_ISSUES §1 lists as
// deliberately volatile in the PoC — the Store's OrderRows, the solvency reservations, the retry counters,
// the webhook dedup set, the loss flags, and the registry's OrderCtx. It uses node:sqlite (DatabaseSync):
// the SYNCHRONOUS API is load-bearing, not a convenience — the Store contract requires strictly synchronous
// read-modify-write (no await between read and write; see in-memory-store.ts header), and a sync sqlite call
// preserves that atomicity on the event loop while making every commit durable.
//
// FAILURE MODEL: a database that refuses a statement is poisoned for the life of the process, exactly like a
// refused append-only log. Every error is rethrown with code 'DurableLogFailure', so the existing machinery —
// isDurableLogFailure -> tick loops exit the process -> the boot probe re-checks the disk — applies unchanged.
// A store that cannot record must not keep running effects it will never remember.

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

export const ORDER_DB_FILE = 'orders.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_orders (
  order_id   TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  seq        TEXT,
  payment_id TEXT,
  hash_hex   TEXT,
  signed_xdr TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS registry_orders (
  order_id        TEXT PRIMARY KEY,
  ctx_json        TEXT NOT NULL,
  state           TEXT NOT NULL,
  conversation_id TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS registry_orders_conversation ON registry_orders(conversation_id);
CREATE INDEX IF NOT EXISTS registry_orders_state ON registry_orders(state);

CREATE TABLE IF NOT EXISTS reservations (
  order_id       TEXT PRIMARY KEY,
  amount_stroops TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  settled        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS retry_counters (
  order_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (order_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS webhooks (
  event_id   TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS losses (
  order_id     TEXT NOT NULL,
  bucket       TEXT NOT NULL,
  usdc_tx_hash TEXT,
  at_ms        INTEGER NOT NULL,
  PRIMARY KEY (order_id, bucket)
) STRICT;

CREATE TABLE IF NOT EXISTS mint_intents (
  ref          TEXT PRIMARY KEY,
  boot_id      TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL
) STRICT;
`;

function poisoned(op: string, e: unknown): Error {
  const cause = e instanceof Error ? e.message : String(e);
  const err = new Error(`order-db ${op} failed: ${cause}`);
  (err as Error & { code: string }).code = 'DurableLogFailure';
  return err;
}

/**
 * A guarded handle over the one shared database. The Store and the OrderRegistry both hold the SAME OrderDb,
 * so their rows live in one file and one durability domain. Statements are prepared lazily and cached.
 */
export class OrderDb {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string, opts?: { busyTimeoutMs?: number }) {
    try {
      this.db = new DatabaseSync(path);
      // WAL keeps readers cheap; FULL makes every committed write survive power loss, which is the entire
      // point of this file existing. NORMAL would trade the crash-in-charge-window guarantee for speed.
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = FULL;');
      // Cross-PROCESS contention: another instance holding the write lock makes this one WAIT (up to the
      // timeout) instead of failing instantly. After the timeout the statement throws SQLITE_BUSY, which the
      // poisoned() wrapper turns into a fail-fast DurableLogFailure — never a silent skip.
      this.db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeoutMs ?? 5000};`);
      this.db.exec(SCHEMA);
    } catch (e) {
      throw poisoned('open/migrate', e);
    }
  }

  /**
   * Run `fn` inside a single BEGIN IMMEDIATE transaction and return its result. IMMEDIATE takes the WRITE
   * lock at BEGIN — before the first read — which is what makes a multi-statement CHECK -> COMMIT atomic
   * against OTHER PROCESSES sharing this file: a second instance's transaction cannot interleave between the
   * check and the commit, it can only wait its turn (or time out into the poisoned fail-fast). `fn` MUST be
   * fully synchronous — an await inside would hold the database write lock across event-loop turns.
   *
   * A throw rolls back: nothing `fn` wrote survives, so the caller retries the whole unit or fails whole.
   */
  transaction<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE;');
    } catch (e) {
      throw poisoned('begin', e);
    }
    let result: T;
    try {
      result = fn();
    } catch (e) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // rollback failure is unreachable while the connection is alive; the original error matters more
      }
      throw e;
    }
    try {
      this.db.exec('COMMIT;');
    } catch (e) {
      throw poisoned('commit', e);
    }
    return result;
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (s === undefined) {
      try {
        s = this.db.prepare(sql);
      } catch (e) {
        throw poisoned('prepare', e);
      }
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Execute a mutating statement; returns the number of affected rows. */
  run(sql: string, ...args: (string | number | null)[]): number {
    try {
      return Number(this.stmt(sql).run(...args).changes);
    } catch (e) {
      throw poisoned('write', e);
    }
  }

  get(sql: string, ...args: (string | number | null)[]): Record<string, unknown> | undefined {
    try {
      return this.stmt(sql).get(...args) as Record<string, unknown> | undefined;
    } catch (e) {
      throw poisoned('read', e);
    }
  }

  all(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] {
    try {
      return this.stmt(sql).all(...args) as Record<string, unknown>[];
    } catch (e) {
      throw poisoned('read', e);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // closing is best-effort; the process is exiting anyway
    }
  }
}

/** Open (creating/migrating as needed) the order database inside the per-pool data dir. */
export function openOrderDb(dataDir: string, opts?: { busyTimeoutMs?: number }): OrderDb {
  return new OrderDb(join(dataDir, ORDER_DB_FILE), opts);
}
