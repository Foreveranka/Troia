// PURE submit-poll reducer — the SPIKE-2 heart. It NEVER rebuilds, re-simulates, re-signs, or allocates a
// sequence. Its ONLY submit-shaped action is `resendPersistedEnvelope` (the byte-identical persisted tx).
// Every uncertain outcome routes to `resolveDeadness` (the fail-closed oracle) rather than a blind resend.
// Expiry is decided from ledger close time carried on the NOT_FOUND outcome, never a local clock.

import type { PollOutcome, PollVerdict } from './outcomes.js';

export interface ReducerState {
  readonly phase: 'submitting' | 'polling' | 'done';
  readonly hashHex: string;
  readonly ourSeq: bigint;
  /** the tx timebounds maxTime (unix seconds); always finite (build.ts forbids TimeoutInfinite). */
  readonly maxTime: number;
}

export type ReducerAction =
  | 'none' // concluded; nothing more to do
  | 'poll' // observe again via getTransaction
  | 'resendPersistedEnvelope' // transient rejection: resend the EXACT persisted bytes (same hash)
  | 'resolveDeadness' // uncertain: run the authoritative account-seq + hash read, then re-decide
  | 'confirmBurnedSeq'; // our tx landed and reverted: the seq is burned by us

export interface StepResult {
  readonly next: ReducerState;
  readonly action: ReducerAction;
  /** set when this single outcome already determines the on-chain fate (SUCCESS / reverted / still-pending). */
  readonly verdict?: PollVerdict;
}

/**
 * Advance the loop by one observed outcome. Total over the whole input alphabet. Branches on the outcome
 * kind (phase is bookkeeping the client uses; the safe action is a function of the outcome).
 */
export function step(s: ReducerState, o: PollOutcome): StepResult {
  switch (o.kind) {
    // --- send outcomes ---
    case 'PENDING':
    case 'DUPLICATE':
      // Accepted / already in flight: start (or continue) polling the KNOWN hash. Do not resend.
      return { next: { ...s, phase: 'polling' }, action: 'poll' };
    case 'TRY_AGAIN':
      // Ledger full / rate limited: resend the SAME persisted envelope (idempotent — same seq, same hash).
      return { next: { ...s, phase: 'submitting' }, action: 'resendPersistedEnvelope' };
    case 'BAD_SEQ':
      // The sequence was consumed. Never resend/rebuild — verify who burned it.
      return { next: { ...s, phase: 'polling' }, action: 'resolveDeadness' };
    case 'ERROR':
      // Admission failure (insufficient fee, no account, malformed, ...). The tx did not land, but a bare
      // "not landed" is not a license to reuse the seq — verify seq state and wait for timebounds.
      return { next: { ...s, phase: 'polling' }, action: 'resolveDeadness' };

    // --- poll outcomes ---
    case 'SUCCESS':
      return { next: { ...s, phase: 'done' }, action: 'none', verdict: 'LANDED_SUCCESS' };
    case 'FAILED':
      // Included then reverted on apply. txBadSeq is anomalous here -> deadness; otherwise the seq is
      // burned by our own reverted tx (no money moved through pay()'s checks-effects ordering).
      return o.badSeq
        ? { next: { ...s, phase: 'polling' }, action: 'resolveDeadness' }
        : {
            next: { ...s, phase: 'done' },
            action: 'confirmBurnedSeq',
            verdict: 'LANDED_REVERTED',
          };
    case 'NOT_FOUND': {
      // Expiry is decided from LEDGER close time (carried on the outcome), never a local clock.
      const expired = s.maxTime > 0 && o.latestLedgerCloseTimeUnix > s.maxTime;
      return expired
        ? { next: { ...s, phase: 'polling' }, action: 'resolveDeadness' }
        : { next: { ...s, phase: 'polling' }, action: 'poll', verdict: 'STILL_PENDING' };
    }

    // --- transport timeout ---
    case 'TIMEOUT':
      // The read itself did not return — conclude nothing; escalate to the authoritative deadness read.
      return { next: { ...s, phase: 'polling' }, action: 'resolveDeadness' };
  }
}

// --- mapping the on-chain fate onto the @troia/core state-machine (§3) so the client and the core stay
// ONE machine. Typed structurally (not by importing core) to keep this file dependency-light; the
// reducer-to-core test proves each emitted event is actually accepted by core.transition in the right state.

export type CoreEventOut =
  | { readonly type: 'evidenceSuccess' }
  | { readonly type: 'evidenceReverted' }
  | { readonly type: 'evidencePending' }
  | { readonly type: 'pollStillPending' }
  | { readonly type: 'pollDead' };

export type CoreMapping =
  | { readonly kind: 'event'; readonly event: CoreEventOut }
  | { readonly kind: 'escalate'; readonly reason: string };

/**
 * A poll verdict + the current core state -> the core event to feed (or an escalation). The core routes
 * the USDC leg through UsdcSubmitted -> UsdcPending -> UsdcDead, so "still pending" and "dead" pick the
 * event valid in the CURRENT state (evidencePending from UsdcSubmitted; pollStillPending/pollDead from
 * UsdcPending). INDETERMINATE_LOSS_REVIEW has no clean core event: it escalates to the reconciler, whose
 * chain_evidence / all-hash scan is the authority for a burned-but-unproven sequence.
 */
export function verdictToCore(verdict: PollVerdict, coreState: string): CoreMapping {
  switch (verdict) {
    case 'LANDED_SUCCESS':
      return { kind: 'event', event: { type: 'evidenceSuccess' } };
    case 'LANDED_REVERTED':
      return { kind: 'event', event: { type: 'evidenceReverted' } };
    case 'STILL_PENDING':
      return coreState === 'UsdcSubmitted'
        ? { kind: 'event', event: { type: 'evidencePending' } }
        : { kind: 'event', event: { type: 'pollStillPending' } };
    case 'DEAD_REPLACEABLE':
      // UsdcSubmitted cannot take pollDead; advance to UsdcPending first (dead-ness re-derives next cycle).
      return coreState === 'UsdcSubmitted'
        ? { kind: 'event', event: { type: 'evidencePending' } }
        : { kind: 'event', event: { type: 'pollDead' } };
    case 'INDETERMINATE_LOSS_REVIEW':
      return {
        kind: 'escalate',
        reason: 'sequence burned without a proven success — hand to reconciler chain_evidence',
      };
  }
}
