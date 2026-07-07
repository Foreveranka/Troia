// Concrete PoC implementations of two stellar-client seams the composition root must inject: an in-memory
// WriteAheadJournal and a SystemClock. Both are SDK-free (a Map + Date.now), so they live alongside the pure core
// and are exported from the package index (no @stellar/stellar-sdk type crosses index.ts). The journal is
// single-process — correct for the PoC live-smoke (one process, no restart); cross-restart recovery is a Phase-2
// durable-store swap behind this SAME WriteAheadJournal interface.

import type { Clock, WriteAheadJournal } from './ports.js';

/** Wall-clock epoch seconds. Logging/backoff only — NEVER consulted for tx liveness/expiry (that is ledger-close
 *  sourced), so clock skew here can never free a still-live sequence. */
export class SystemClock implements Clock {
  nowUnix(): number {
    return Math.floor(Date.now() / 1000);
  }
}

/** In-memory write-ahead journal: the exact signed envelope + hash per order, written before any send so a
 *  same-process crash/recovery resends the byte-identical envelope (never a fresh build on a live seq). The seq
 *  is part of the persist call but not needed on load (resendPersisted replays signedXdr verbatim). */
export class InMemoryJournal implements WriteAheadJournal {
  private readonly entries = new Map<string, { readonly hashHex: string; readonly signedXdr: string }>();

  async persistPreSubmit(orderId: string, _seq: string, hashHex: string, signedXdrBase64: string): Promise<void> {
    this.entries.set(orderId, { hashHex, signedXdr: signedXdrBase64 });
  }

  async loadPersisted(orderId: string): Promise<{ hashHex: string; signedXdr: string } | null> {
    return this.entries.get(orderId) ?? null;
  }
}
