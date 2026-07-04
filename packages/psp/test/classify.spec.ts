import { describe, expect, it } from 'vitest';
import {
  chargeEvent,
  classifyIyzicoResult,
  reversalEvent,
  TERMINAL_DECLINE_WHITELIST,
} from '../src/classify.js';
import type { PspOp, RawIyzicoResult } from '../src/outcomes.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });
const CHARGE_OPS: PspOp[] = ['preauth', 'checkout', 'capture', 'sale'];

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

  it('sale (direct charge) is SUCCESS only on a captured shape with a paymentId, and NEVER on a PRE_AUTH hold', () => {
    const captured = { status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1 };
    // a completed direct sale (phase absent or AUTH) with a paymentId is a real captured charge
    expect(classifyIyzicoResult(body(captured), 'sale')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ ...captured, phase: 'AUTH' }), 'sale')).toBe('SUCCESS');
    // the money-safety shield: a still-live PRE_AUTH hold must NEVER read as charged (would send USDC vs a hold)
    expect(classifyIyzicoResult(body({ ...captured, phase: 'PRE_AUTH' }), 'sale')).toBe('UNKNOWN');
    // a SUCCESS shape with NO paymentId must read UNKNOWN — a chargeOk we could not later void is money-unsafe
    expect(classifyIyzicoResult(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }), 'sale')).toBe('UNKNOWN');
    // intermediate paymentStatus or fraud-review -> UNKNOWN
    expect(classifyIyzicoResult(body({ ...captured, paymentStatus: 'CALLBACK_THREEDS' }), 'sale')).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ ...captured, fraudStatus: 0 }), 'sale')).toBe('UNKNOWN');
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
  it('chargeEvent maps SUCCESS/FAILURE/UNKNOWN -> chargeOk/Rejected/Unknown (captured shape only)', () => {
    expect(chargeEvent(body({ status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1 }))).toEqual({ type: 'chargeOk' });
    expect(chargeEvent(body({ status: 'failure', errorCode: '10051' }))).toEqual({ type: 'chargeRejected' });
    expect(chargeEvent({ kind: 'timeout' })).toEqual({ type: 'chargeUnknown' });
    // a PRE_AUTH hold is never a completed charge -> Unknown (re-driven by the recovery worklist, no USDC)
    expect(chargeEvent(body({ status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1, phase: 'PRE_AUTH' }))).toEqual({ type: 'chargeUnknown' });
    // a SUCCESS shape with NO paymentId -> chargeUnknown (never a chargeOk we could not unwind)
    expect(chargeEvent(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }))).toEqual({ type: 'chargeUnknown' });
  });

  it('reversalEvent: only SUCCESS confirms; FAILURE and UNKNOWN both re-drive within budget (no reversalUnknown-stay)', () => {
    expect(reversalEvent(body({ status: 'success' }), true)).toEqual({ type: 'reversalConfirmed' });
    expect(reversalEvent(body({ status: 'failure' }), true)).toEqual({ type: 'reversalNotDone', retriesRemaining: true });
    expect(reversalEvent(body({ status: 'failure' }), false)).toEqual({ type: 'reversalNotDone', retriesRemaining: false });
    // an UNKNOWN (timeout) void re-drives within budget too — a same-day void is idempotent, so it must NEVER
    // become a bare observe-only stay that strands a charged order (adversarial finding #1).
    expect(reversalEvent({ kind: 'timeout' }, true)).toEqual({ type: 'reversalNotDone', retriesRemaining: true });
  });
});
