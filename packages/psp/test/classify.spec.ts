import { describe, expect, it } from 'vitest';
import {
  captureEvent,
  classifyIyzicoResult,
  preauthEvent,
  TERMINAL_DECLINE_WHITELIST,
  voidEvent,
} from '../src/classify.js';
import type { PspOp, RawIyzicoResult } from '../src/outcomes.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });
const CHARGE_OPS: PspOp[] = ['preauth', 'checkout', 'capture'];

describe('classifyIyzicoResult — the money-safety oracle (UNKNOWN is the safe default)', () => {
  it('never SUCCESS on ambiguity: transport/parse failures and empty envelopes are UNKNOWN for every op', () => {
    const ambiguous: RawIyzicoResult[] = [
      { kind: 'timeout' },
      { kind: 'malformed', reason: '5xx' },
      body({}), // missing status
      body({ status: 'weird' }), // unknown status value
      body({ status: 123 as unknown as string }), // wrong-typed status
    ];
    for (const op of ['preauth', 'capture', 'void', 'refund', 'checkout'] as PspOp[]) {
      for (const raw of ambiguous) expect(classifyIyzicoResult(raw, op)).toBe('UNKNOWN');
    }
  });

  it('SUCCESS only on the exact terminal-success shape per op', () => {
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }), 'preauth')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }), 'checkout')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1' }), 'capture')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success' }), 'void')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success' }), 'refund')).toBe('SUCCESS');
  });

  it('a success envelope with a non-terminal / fraud-review payment is UNKNOWN, not SUCCESS', () => {
    for (const paymentStatus of ['INIT_THREEDS', 'CALLBACK_THREEDS', 'BKM_POS_SELECTED', 'PENDING_CREDIT', 'FAILURE']) {
      expect(classifyIyzicoResult(body({ status: 'success', paymentStatus, fraudStatus: 1 }), 'preauth')).toBe('UNKNOWN');
    }
    // fraud not approved (0 = manual review, -1 = reject) is UNKNOWN even with paymentStatus SUCCESS
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 0 }), 'preauth')).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: -1 }), 'preauth')).toBe('UNKNOWN');
    // capture success envelope but no paymentId, or an error present -> UNKNOWN
    expect(classifyIyzicoResult(body({ status: 'success' }), 'capture')).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1', errorCode: '10051' }), 'capture')).toBe('UNKNOWN');
  });

  it('capture never reads a PRE_AUTH (uncaptured hold) or a numeric-error body as captured', () => {
    // a PRE_AUTH payment-detail is a live, UNCAPTURED hold -> must be UNKNOWN, never captured
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1', phase: 'PRE_AUTH' }), 'capture')).toBe('UNKNOWN');
    // a real capture (phase POST_AUTH, or phase absent) is SUCCESS
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1', phase: 'POST_AUTH' }), 'capture')).toBe('SUCCESS');
    // an error field of ANY type (numeric, not just string) blocks SUCCESS
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1', errorCode: 10051 as unknown as string }), 'capture')).toBe('UNKNOWN');
  });

  it('an out-of-enum op fails safe to UNKNOWN', () => {
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }), 'bogus' as PspOp)).toBe('UNKNOWN');
  });

  it('FAILURE for a charge only on the CLOSED terminal-decline whitelist; unlisted codes are UNKNOWN', () => {
    for (const code of TERMINAL_DECLINE_WHITELIST) {
      for (const op of CHARGE_OPS) {
        expect(classifyIyzicoResult(body({ status: 'failure', errorCode: code }), op)).toBe('FAILURE');
      }
    }
    // an unlisted / transient / missing code must NOT be a FAILURE (fail-safe -> UNKNOWN)
    expect(classifyIyzicoResult(body({ status: 'failure', errorCode: '99999' }), 'preauth')).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ status: 'failure' }), 'preauth')).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ status: 'failure', errorCode: 'SYSTEM_ERROR' }), 'capture')).toBe('UNKNOWN');
  });

  it('void/refund failure is a definitive (retry-safe) FAILURE, independent of the charge whitelist', () => {
    expect(classifyIyzicoResult(body({ status: 'failure', errorCode: 'anything' }), 'void')).toBe('FAILURE');
    expect(classifyIyzicoResult(body({ status: 'failure' }), 'refund')).toBe('FAILURE');
  });

  it('property: SUCCESS is emitted ONLY on a whitelisted success shape, never on ambiguity', () => {
    // garbled success envelopes with random extra/missing fields never yield SUCCESS for a charge unless
    // the exact (paymentStatus===SUCCESS && fraudStatus===1) holds.
    const junk = [
      body({ status: 'success' }),
      body({ status: 'success', paymentStatus: 'SUCCESS' }), // no fraudStatus
      body({ status: 'success', fraudStatus: 1 }), // no paymentStatus
      body({ status: 'success', paymentStatus: 'success', fraudStatus: 1 }), // lowercase != 'SUCCESS'
      body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: '1' as unknown as number }),
    ];
    for (const raw of junk) expect(classifyIyzicoResult(raw, 'preauth')).toBe('UNKNOWN');
  });
});

describe('per-op mappers onto core §3 events', () => {
  it('preauthEvent maps SUCCESS/FAILURE/UNKNOWN -> preauthOk/Rejected/Unknown', () => {
    expect(preauthEvent(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }))).toEqual({ type: 'preauthOk' });
    expect(preauthEvent(body({ status: 'failure', errorCode: '10051' }))).toEqual({ type: 'preauthRejected' });
    expect(preauthEvent({ kind: 'timeout' })).toEqual({ type: 'preauthUnknown' });
  });

  it('captureEvent carries retriesRemaining on a failure', () => {
    expect(captureEvent(body({ status: 'success', paymentId: 'p1' }), true)).toEqual({ type: 'captureSuccess' });
    expect(captureEvent(body({ status: 'failure', errorCode: '10005' }), true)).toEqual({ type: 'captureFailed', retriesRemaining: true });
    expect(captureEvent(body({ status: 'failure', errorCode: '10005' }), false)).toEqual({ type: 'captureFailed', retriesRemaining: false });
    expect(captureEvent({ kind: 'malformed', reason: 'x' }, true)).toEqual({ type: 'captureUnknown' });
  });

  it('voidEvent maps SUCCESS/FAILURE/UNKNOWN -> voidConfirmed/NotVoided/Unknown', () => {
    expect(voidEvent(body({ status: 'success' }))).toEqual({ type: 'voidConfirmed' });
    expect(voidEvent(body({ status: 'failure' }))).toEqual({ type: 'voidNotVoided' });
    expect(voidEvent({ kind: 'timeout' })).toEqual({ type: 'voidUnknown' });
  });
});
