import { describe, expect, it } from 'vitest';
import {
  projectCheckoutFormInit,
  projectCheckoutFormResult,
  projectPayment,
} from '../src/response-projectors.js';
import type { RawIyzicoResult } from '../src/outcomes.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });

describe('response projectors — carry happy-path fields, never fabricate a missing one', () => {
  it('projectCheckoutFormInit extracts token/content/conversationId; missing -> malformed', () => {
    const ok = projectCheckoutFormInit(body({ status: 'success', token: 't', checkoutFormContent: '<script>', conversationId: 'c1' }));
    expect(ok).toEqual({ kind: 'ok', token: 't', checkoutFormContent: '<script>', conversationId: 'c1' });
    expect(projectCheckoutFormInit(body({ status: 'success', token: 't' })).kind).toBe('malformed');
  });

  it('projectCheckoutFormResult extracts token/paymentId/paymentStatus/conversationId', () => {
    const ok = projectCheckoutFormResult(body({ token: 't', paymentId: 'p1', paymentStatus: 'SUCCESS', conversationId: 'c1' }));
    expect(ok).toEqual({ kind: 'ok', token: 't', paymentId: 'p1', paymentStatus: 'SUCCESS', conversationId: 'c1' });
    expect(projectCheckoutFormResult(body({ token: 't', paymentStatus: 'SUCCESS' })).kind).toBe('malformed');
    // A FAILED attempt (e.g. failed 3DS) still projects to 'ok' when it carries the four fields — the projector
    // carries fields, it does not judge the outcome. chargeEvent then classifies it: a paymentStatus 'FAILURE'
    // reads UNKNOWN -> chargeUnknown (retry-safe), keeping the order open so a retry-success can settle it.
    expect(projectCheckoutFormResult(body({ token: 't', paymentId: '36434664', paymentStatus: 'FAILURE', conversationId: 'c1' })).kind).toBe('ok');
  });

  it('projectPayment extracts paymentId/conversationId', () => {
    expect(projectPayment(body({ paymentId: 'p1', conversationId: 'c1' }))).toEqual({ kind: 'ok', paymentId: 'p1', conversationId: 'c1' });
    expect(projectPayment(body({ conversationId: 'c1' })).kind).toBe('malformed');
  });

  it('transport markers project to malformed (never a fabricated success)', () => {
    expect(projectPayment({ kind: 'timeout' }).kind).toBe('malformed');
    expect(projectCheckoutFormInit({ kind: 'malformed', reason: '5xx' }).kind).toBe('malformed');
    // a wrong-typed field is treated as missing
    expect(projectPayment(body({ paymentId: 123 as unknown as string, conversationId: 'c1' })).kind).toBe('malformed');
  });
});
