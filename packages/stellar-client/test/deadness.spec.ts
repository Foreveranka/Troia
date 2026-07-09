import { describe, expect, it } from 'vitest';
import { deadnessToVerdict, resolveDeadness } from '../src/deadness.js';
import type { DeadnessInputs } from '../src/deadness.js';

const OUR_SEQ = 101n;
const inputs = (o: Partial<DeadnessInputs>): DeadnessInputs => ({
  accountSeq: 100n, // unburned by default (< ourSeq)
  ourSeq: OUR_SEQ,
  timeboundsExpired: false,
  hashLookup: 'NOT_FOUND',
  seqKnown: true,
  ...o,
});

describe('resolveDeadness — the fail-closed seq-reuse oracle', () => {
  it('unburned + not expired -> WAIT (could still land, never advance)', () => {
    expect(resolveDeadness(inputs({}))).toBe('WAIT');
  });

  it('unburned + expired -> SAFE_TO_REPLACE (provably can never be included)', () => {
    expect(resolveDeadness(inputs({ timeboundsExpired: true }))).toBe('SAFE_TO_REPLACE');
  });

  it('burned (accountSeq >= ourSeq) without proven success -> LOSS_REVIEW, never replaced', () => {
    expect(resolveDeadness(inputs({ accountSeq: 101n }))).toBe('LOSS_REVIEW');
    expect(resolveDeadness(inputs({ accountSeq: 200n }))).toBe('LOSS_REVIEW');
  });

  it('DOMINANCE: burned AND expired is still LOSS_REVIEW (a burn may have moved money)', () => {
    expect(resolveDeadness(inputs({ accountSeq: 101n, timeboundsExpired: true }))).toBe(
      'LOSS_REVIEW',
    );
  });

  it('DOMINANCE: a proven SUCCESS overrides everything -> CONFIRMED', () => {
    expect(resolveDeadness(inputs({ hashLookup: 'SUCCESS' }))).toBe('CONFIRMED');
    expect(
      resolveDeadness(inputs({ hashLookup: 'SUCCESS', accountSeq: 200n, timeboundsExpired: true })),
    ).toBe('CONFIRMED');
  });

  it('FAIL-CLOSED: an unresolvable seq read (seqKnown:false) is LOSS_REVIEW, never SAFE_TO_REPLACE', () => {
    // even with the "looks unburned + expired" inputs that would otherwise yield SAFE_TO_REPLACE
    expect(
      resolveDeadness(inputs({ seqKnown: false, accountSeq: 0n, timeboundsExpired: true })),
    ).toBe('LOSS_REVIEW');
    // but a proven SUCCESS still dominates an unknown seq
    expect(resolveDeadness(inputs({ seqKnown: false, hashLookup: 'SUCCESS' }))).toBe('CONFIRMED');
  });

  it('maps deadness verdicts onto on-chain fate labels', () => {
    expect(deadnessToVerdict('CONFIRMED')).toBe('LANDED_SUCCESS');
    expect(deadnessToVerdict('SAFE_TO_REPLACE')).toBe('DEAD_REPLACEABLE');
    expect(deadnessToVerdict('WAIT')).toBe('STILL_PENDING');
    expect(deadnessToVerdict('LOSS_REVIEW')).toBe('INDETERMINATE_LOSS_REVIEW');
  });
});
