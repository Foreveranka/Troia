// The composition-owned per-order view. The engine's Store persists the mutable settlement facts (state,
// reservations, counters, evidence); the registry persists the OrderCtx + the last quiescent State the HTTP
// layer threads through start()/advance(). It is indexed by BOTH orderId (for /status) and conversationId —
// the ONLY key the iyzico webhook carries (paymentConversationId = deriveIds(...).idempotencyKeyHex). In
// memory for the offline suite; 4.3d makes it durable and rebuilds it (with the Store's OrderRow) on recovery.

import type { State } from '@troia/core';
import type { OrderCtx } from '../ctx.js';

export interface OrderRecord {
  readonly ctx: OrderCtx;
  readonly state: State;
}

export interface OrderRegistry {
  /** Upsert by orderId; also (re)indexes conversationId -> orderId. Single-writer per order (call under the
   *  caller's withOrderLock). */
  put(ctx: OrderCtx, state: State): void;
  getByOrderId(orderId: string): OrderRecord | undefined;
  getByConversationId(conversationId: string): OrderRecord | undefined;
  /** A materialized snapshot of orders currently in any of the given states — the poll/recovery worker's
   *  work-list. Returns a COPY (not a live Map view), so advance() mutating the registry mid-poll is safe. */
  ordersInStates(states: readonly State[]): readonly OrderRecord[];
}

export class InMemoryOrderRegistry implements OrderRegistry {
  private readonly byOrder = new Map<string, OrderRecord>();
  private readonly convToOrder = new Map<string, string>();

  put(ctx: OrderCtx, state: State): void {
    this.byOrder.set(ctx.orderId, { ctx, state });
    this.convToOrder.set(ctx.conversationId, ctx.orderId);
  }

  getByOrderId(orderId: string): OrderRecord | undefined {
    return this.byOrder.get(orderId);
  }

  getByConversationId(conversationId: string): OrderRecord | undefined {
    const orderId = this.convToOrder.get(conversationId);
    return orderId === undefined ? undefined : this.byOrder.get(orderId);
  }

  ordersInStates(states: readonly State[]): readonly OrderRecord[] {
    const wanted = new Set<State>(states);
    return [...this.byOrder.values()].filter((r) => wanted.has(r.state)); // materialized copy
  }
}
