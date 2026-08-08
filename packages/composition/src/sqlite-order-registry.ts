// The durable OrderRegistry (A-1): the same contract as InMemoryOrderRegistry, over the same SQLite file as
// the Store — so a restart's poll worker finds its work-list on disk instead of an empty Map. This closes
// KNOWN_ISSUES §1's customer-facing gap: an order sitting in SolvencyReserved when the process dies is now
// re-driven (the sale re-retrieve is idempotent) instead of forgotten with the customer already charged.
//
// THE EFFECTIVE-STATE RULE — the one piece of real logic here. Two rows describe an order's state and they
// are written at different moments: the Store's row (persistState, written BEFORE each side-effecting call)
// and the registry's row (put, written at quiescence AFTER the effects ran). In a live process every read
// happens under the per-order lock at a quiescent point, so the two agree and the rule returns the registry
// state verbatim — live behavior is unchanged. After a crash they can differ, and each direction of
// disagreement has exactly one money-safe answer:
//
//   1. registry says Reconciled            -> Reconciled. Terminal; the audit already closed it.
//   2. settlement evidence row exists      -> UsdcConfirmed (unless 1). The pay() landed — the evidence pin
//                                             (ports.ts settledEvidence) proves it; never re-drive earlier.
//   3. store says UsdcSubmitted while the  -> UsdcSubmitted. A seq was allocated and a pay() may be on the
//      registry still says Reserved /         wire; resuming from the registry's older state would re-run
//      SolvencyReserved                       chargeOk and allocate a SECOND seq for the same order. The
//                                             poll worker's witness-null / same-seq paths handle it safely.
//   4. otherwise                           -> the registry state (it is the later write in every other case).
//
// The recovered ctx is overlaid the same way: the Store row's seq/paymentId/hashHex/signedXdr are written
// before the corresponding ctx put, so where both exist the Store's value is the same or newer, and the
// persisted retry counters are authoritative over the ctx's snapshot of them.

import type { State } from '@troia/core';
import type { OrderCtx, OrderRecord, OrderRegistry } from '@troia/backend';
import { decodeOrderCtx, encodeOrderCtx } from './order-ctx-codec.js';
import type { OrderDb } from './order-db.js';
import type { SqliteOrderStore } from './sqlite-order-store.js';

/** The recovery work-list states (mirrors poll-worker.ts RECOVERY_STATES — keep in sync). */
const RECOVERY_STATES: readonly State[] = ['SolvencyReserved', 'UsdcSubmitted', 'UsdcPending'];
/** States before any charge: the only states rule 3 may override (see the header table). */
const PRE_SUBMIT_STATES: readonly State[] = ['Reserved', 'SolvencyReserved'];

export interface RegistryBootReport {
  /** in-flight orders a restarted poll worker will re-drive. */
  readonly recovered: readonly { orderId: string; state: State }[];
  /** leftovers in 'Reserved': the /intent that created them died before the hosted-form URL could ever reach
   *  a customer (the HTTP response is sent only after the first quiescent put), so no charge exists and their
   *  rows + any reservation were purged as money-safe garbage. */
  readonly purgedReserved: readonly string[];
}

export class SqliteOrderRegistry implements OrderRegistry {
  constructor(
    private readonly db: OrderDb,
    private readonly store: SqliteOrderStore,
  ) {}

  /** Boot-time sweep + inventory. Call once, before the server starts taking traffic. */
  recoverAtBoot(): RegistryBootReport {
    // Purge 'Reserved' leftovers. Effective state 'Reserved' means the first quiescent put never happened
    // (or solvency stayed unknown): the customer never received a form URL, so nothing can have been charged
    // and nothing ever will be — but a reservation may be durably held, and nothing on the poll worker's
    // work-list would ever release it. Deleting the rows returns the capacity and lets a retried /intent
    // recreate the order cleanly.
    const purged = this.db.transaction(() => {
      const stale = this.db.all(
        `SELECT r.order_id FROM registry_orders r
         LEFT JOIN store_orders s ON s.order_id = r.order_id
         WHERE r.state = 'Reserved' AND (s.state IS NULL OR s.state = 'Reserved')`,
      );
      const ids: string[] = [];
      for (const row of stale) {
        const orderId = row.order_id as string;
        this.db.run('DELETE FROM reservations WHERE order_id = ?', orderId);
        this.db.run('DELETE FROM registry_orders WHERE order_id = ?', orderId);
        this.db.run('DELETE FROM store_orders WHERE order_id = ?', orderId);
        ids.push(orderId);
      }
      // Store rows with no registry row cannot be rebuilt into a drivable ctx. They can only come from a crash
      // inside the very first put's transaction window and hold no charge (same argument as above), so they are
      // purged with the same justification rather than reported as undrivable mysteries.
      this.db.run(
        'DELETE FROM store_orders WHERE order_id NOT IN (SELECT order_id FROM registry_orders)',
      );
      return ids;
    });

    const recovered = this.ordersInStates(RECOVERY_STATES).map((r) => ({
      orderId: r.ctx.orderId,
      state: r.state,
    }));
    return { recovered, purgedReserved: purged };
  }

  /** Upsert by orderId; also (re)indexes conversationId. Single-writer per order (caller's withOrderLock). */
  put(ctx: OrderCtx, state: State): void {
    this.db.run(
      `INSERT INTO registry_orders (order_id, ctx_json, state, conversation_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (order_id) DO UPDATE SET
         ctx_json = excluded.ctx_json, state = excluded.state, conversation_id = excluded.conversation_id`,
      ctx.orderId,
      encodeOrderCtx(ctx),
      state,
      ctx.conversationId,
    );
  }

  getByOrderId(orderId: string): OrderRecord | undefined {
    const row = this.db.get(
      'SELECT order_id, ctx_json, state FROM registry_orders WHERE order_id = ?',
      orderId,
    );
    return row === undefined ? undefined : this.toRecord(row);
  }

  getByConversationId(conversationId: string): OrderRecord | undefined {
    const row = this.db.get(
      'SELECT order_id, ctx_json, state FROM registry_orders WHERE conversation_id = ?',
      conversationId,
    );
    return row === undefined ? undefined : this.toRecord(row);
  }

  /** The poll/recovery work-list. Filters on the EFFECTIVE state, so an order whose Store row advanced past
   *  its registry row (crash window, rule 3) is selected under the state it must actually resume from. */
  ordersInStates(states: readonly State[]): readonly OrderRecord[] {
    const wanted = new Set<State>(states);
    const out: OrderRecord[] = [];
    for (const row of this.db.all('SELECT order_id, ctx_json, state FROM registry_orders')) {
      const rec = this.toRecord(row);
      if (wanted.has(rec.state)) out.push(rec);
    }
    return out; // materialized copy — safe against mid-poll puts, like the in-memory registry
  }

  private toRecord(row: Record<string, unknown>): OrderRecord {
    const orderId = row.order_id as string;
    const registryState = row.state as State;
    const ctx = decodeOrderCtx(row.ctx_json as string);
    const store = this.store.orderRow(orderId);
    const retries = this.store.retryCounts(orderId);

    // ctx overlay: the Store row is written before the ctx put on every leg, so where both carry a value the
    // Store's is the same or newer; a null never overwrites a value (fields only ever gain).
    const merged: OrderCtx = {
      ...ctx,
      activeSeq: store?.seq ?? ctx.activeSeq,
      paymentId: store?.paymentId ?? ctx.paymentId,
      hashHex: store?.hashHex ?? ctx.hashHex,
      signedXdr: store?.signedXdr ?? ctx.signedXdr,
      deadRetries: Math.max(ctx.deadRetries, retries.dead),
      reversalRetries: Math.max(ctx.reversalRetries, retries.reversal),
    };
    return { ctx: merged, state: this.effectiveState(orderId, registryState, store?.state) };
  }

  private effectiveState(
    orderId: string,
    registryState: State,
    storeState: State | undefined,
  ): State {
    if (registryState === 'Reconciled') return 'Reconciled'; // rule 1
    if (this.store.settledEvidence(orderId) !== undefined) return 'UsdcConfirmed'; // rule 2
    if (storeState === 'UsdcSubmitted' && PRE_SUBMIT_STATES.includes(registryState)) {
      return 'UsdcSubmitted'; // rule 3 — never resume behind an allocated seq
    }
    return registryState; // rule 4
  }
}
