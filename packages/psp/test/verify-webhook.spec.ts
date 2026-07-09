import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWebhookSignature } from '../src/verify-webhook.js';
import type { WebhookEvent } from '../src/verify-webhook.js';

const here = dirname(fileURLToPath(import.meta.url));
const gv = JSON.parse(readFileSync(join(here, 'fixtures', 'webhook.golden.json'), 'utf8')) as {
  signingSecret: string;
  event: WebhookEvent;
  signature: string;
};

describe('verifyWebhookSignature — X-IYZ-SIGNATURE-V3, forged-webhook-proof', () => {
  it('ACCEPTS a genuinely-signed event', () => {
    expect(
      verifyWebhookSignature({
        signingSecret: gv.signingSecret,
        event: gv.event,
        providedSignature: gv.signature,
      }),
    ).toBe(true);
  });

  it('REJECTS a tampered signed field (same signature, flipped status)', () => {
    const tampered: WebhookEvent = { ...gv.event, status: 'FAILURE' };
    expect(
      verifyWebhookSignature({
        signingSecret: gv.signingSecret,
        event: tampered,
        providedSignature: gv.signature,
      }),
    ).toBe(false);
  });

  it('REJECTS a tampered signature (one hex char flipped)', () => {
    const bad = (gv.signature[0] === 'a' ? 'b' : 'a') + gv.signature.slice(1);
    expect(
      verifyWebhookSignature({
        signingSecret: gv.signingSecret,
        event: gv.event,
        providedSignature: bad,
      }),
    ).toBe(false);
  });

  it('REJECTS the correct event+signature under a WRONG secret', () => {
    expect(
      verifyWebhookSignature({
        signingSecret: 'wrong-secret',
        event: gv.event,
        providedSignature: gv.signature,
      }),
    ).toBe(false);
  });

  it('FAILS CLOSED on a missing/empty/short signature or a missing required field — without throwing', () => {
    for (const providedSignature of [null, undefined, '', 'ab', 'zz', gv.signature.slice(0, -2)]) {
      expect(
        verifyWebhookSignature({
          signingSecret: gv.signingSecret,
          event: gv.event,
          providedSignature,
        }),
      ).toBe(false);
    }
    // a webhook missing a required signed field cannot be verified -> reject (token present-but-undefined reads
    // the same as absent to the verifier; the cast satisfies exactOptionalPropertyTypes without changing behavior)
    const noToken = { ...gv.event, token: undefined } as unknown as WebhookEvent;
    expect(
      verifyWebhookSignature({
        signingSecret: gv.signingSecret,
        event: noToken,
        providedSignature: gv.signature,
      }),
    ).toBe(false);
    // an absent event-type family selector cannot be verified -> reject
    const noType: WebhookEvent = { ...gv.event, iyziEventType: '' };
    expect(
      verifyWebhookSignature({
        signingSecret: gv.signingSecret,
        event: noType,
        providedSignature: gv.signature,
      }),
    ).toBe(false);
  });

  it('FAILS CLOSED on an empty signing secret (an attacker-known HMAC key must never verify)', () => {
    expect(
      verifyWebhookSignature({
        signingSecret: '',
        event: gv.event,
        providedSignature: gv.signature,
      }),
    ).toBe(false);
  });

  it('uses a constant-time comparison (source guard: timingSafeEqual, no === on the signature)', () => {
    const src = readFileSync(join(here, '..', 'src', 'verify-webhook.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
    expect(src).not.toMatch(/provided\s*===/);
  });
});
