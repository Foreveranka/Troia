import { describe, expect, it } from 'vitest';
import { step } from '../src/submit-reducer.js';
import type { ReducerAction, ReducerState } from '../src/submit-reducer.js';
import type { PollOutcome } from '../src/outcomes.js';

const base: ReducerState = {
  phase: 'submitting',
  hashHex: 'ab'.repeat(32),
  ourSeq: 101n,
  maxTime: 1000,
};

describe('submit-reducer step — the SPIKE-2 no-blind-resubmit table', () => {
  it('PENDING / DUPLICATE -> poll the known hash (never resend)', () => {
    for (const o of [
      { kind: 'PENDING', hashHex: 'x' },
      { kind: 'DUPLICATE', hashHex: 'x' },
    ] as const) {
      const r = step(base, o);
      expect(r.action).toBe('poll');
      expect(r.next.phase).toBe('polling');
    }
  });

  it('TRY_AGAIN -> resend the SAME persisted envelope (the only submit-shaped action)', () => {
    const r = step(base, { kind: 'TRY_AGAIN' });
    expect(r.action).toBe('resendPersistedEnvelope');
  });

  it('BAD_SEQ / ERROR / TIMEOUT -> resolveDeadness (verify, never assume)', () => {
    for (const o of [
      { kind: 'BAD_SEQ' },
      { kind: 'ERROR', code: 'txInsufficientFee' },
      { kind: 'TIMEOUT' },
    ] as const) {
      expect(step(base, o).action).toBe('resolveDeadness');
    }
  });

  it('SUCCESS -> concluded, verdict LANDED_SUCCESS', () => {
    const r = step({ ...base, phase: 'polling' }, { kind: 'SUCCESS', ledger: 42 });
    expect(r.action).toBe('none');
    expect(r.verdict).toBe('LANDED_SUCCESS');
    expect(r.next.phase).toBe('done');
  });

  it('FAILED (non-badSeq) -> confirmBurnedSeq, verdict LANDED_REVERTED', () => {
    const r = step({ ...base, phase: 'polling' }, { kind: 'FAILED', badSeq: false });
    expect(r.action).toBe('confirmBurnedSeq');
    expect(r.verdict).toBe('LANDED_REVERTED');
  });

  it('FAILED (badSeq) -> resolveDeadness (anomalous, do not conclude)', () => {
    const r = step({ ...base, phase: 'polling' }, { kind: 'FAILED', badSeq: true });
    expect(r.action).toBe('resolveDeadness');
  });

  it('NOT_FOUND with valid timebounds -> keep polling, verdict STILL_PENDING', () => {
    const r = step(
      { ...base, phase: 'polling', maxTime: 1000 },
      {
        kind: 'NOT_FOUND',
        latestLedgerCloseTimeUnix: 999,
      },
    );
    expect(r.action).toBe('poll');
    expect(r.verdict).toBe('STILL_PENDING');
  });

  it('NOT_FOUND past the ledger close time -> resolveDeadness (expiry is ledger-sourced)', () => {
    const r = step(
      { ...base, phase: 'polling', maxTime: 1000 },
      {
        kind: 'NOT_FOUND',
        latestLedgerCloseTimeUnix: 1001,
      },
    );
    expect(r.action).toBe('resolveDeadness');
    expect(r.verdict).toBeUndefined();
  });

  it('property: the ONLY submit-shaped action ever emitted is resendPersistedEnvelope, and only for TRY_AGAIN', () => {
    const outcomes: PollOutcome[] = [
      { kind: 'PENDING', hashHex: 'x' },
      { kind: 'DUPLICATE', hashHex: 'x' },
      { kind: 'TRY_AGAIN' },
      { kind: 'BAD_SEQ' },
      { kind: 'ERROR', code: 'e' },
      { kind: 'SUCCESS', ledger: 1 },
      { kind: 'FAILED', badSeq: false },
      { kind: 'FAILED', badSeq: true },
      { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 1 },
      { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 10_000 },
      { kind: 'TIMEOUT' },
    ];
    const phases: ReducerState['phase'][] = ['submitting', 'polling', 'done'];
    const submitShaped = new Set<ReducerAction>(['resendPersistedEnvelope']);
    for (const phase of phases) {
      for (const o of outcomes) {
        const r = step({ ...base, phase }, o);
        if (submitShaped.has(r.action)) {
          expect(o.kind).toBe('TRY_AGAIN'); // never any other outcome triggers a (re)send
        }
        // there is structurally no rebuild / re-simulate / new-seq action in the ADT.
        expect([
          'none',
          'poll',
          'resendPersistedEnvelope',
          'resolveDeadness',
          'confirmBurnedSeq',
        ]).toContain(r.action);
      }
    }
  });
});
