import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAuthorizationHeader } from '../src/auth-header.js';

const here = dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(readFileSync(join(here, 'fixtures', 'auth-header.vector.json'), 'utf8')) as {
  apiKey: string;
  secretKey: string;
  randomKey: string;
  uriPath: string;
  requestBodyString: string;
  authorization: string;
};

const base = {
  apiKey: vec.apiKey,
  secretKey: vec.secretKey,
  uriPath: vec.uriPath,
  requestBodyString: vec.requestBodyString,
  randomKey: vec.randomKey,
};

describe('computeAuthorizationHeader — IYZWSv2, byte-exact vs iyzipay@2.0.69', () => {
  it('matches the SDK-generated golden header for fixed inputs', () => {
    const h = computeAuthorizationHeader(base);
    expect(h.authorization).toBe(vec.authorization);
    expect(h.xIyziRnd).toBe(vec.randomKey);
    expect(h.xIyziClientVersion).toBe('iyzipay-node-2.0.69');
  });

  it('changing ANY signed input changes the header (no field is ignored)', () => {
    const h0 = computeAuthorizationHeader(base).authorization;
    expect(computeAuthorizationHeader({ ...base, secretKey: 'other' }).authorization).not.toBe(h0);
    expect(computeAuthorizationHeader({ ...base, apiKey: 'other' }).authorization).not.toBe(h0);
    expect(computeAuthorizationHeader({ ...base, uriPath: '/payment/postauth' }).authorization).not.toBe(h0);
    expect(computeAuthorizationHeader({ ...base, randomKey: 'other' }).authorization).not.toBe(h0);
    // a single trailing byte in the body flips the signature (sign-the-sent-string is exact)
    expect(
      computeAuthorizationHeader({ ...base, requestBodyString: base.requestBodyString + ' ' }).authorization,
    ).not.toBe(h0);
  });
});
