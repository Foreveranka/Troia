import { describe, expect, it } from 'vitest';
import { createPaymentProvider } from '../src/factory.js';
import { PspBuildError } from '../src/errors.js';
import type { PspSecrets } from '../src/ports.js';

const CONFIG = { baseUrl: 'https://sandbox-api.iyzipay.com' };
const SECRETS: PspSecrets = { apiKey: 'k', secretKey: 's', webhookSigningSecret: 'w' };

describe('createPaymentProvider — fail-fast on a misconfigured deploy', () => {
  it('builds a provider with complete config/secrets', () => {
    const provider = createPaymentProvider(CONFIG, SECRETS);
    expect(typeof provider.createPreAuth).toBe('function');
  });

  it('throws on any empty/blank secret or baseUrl (never runs silently keyless)', () => {
    expect(() => createPaymentProvider({ baseUrl: '' }, SECRETS)).toThrow(PspBuildError);
    expect(() => createPaymentProvider(CONFIG, { ...SECRETS, apiKey: '' })).toThrow(PspBuildError);
    expect(() => createPaymentProvider(CONFIG, { ...SECRETS, secretKey: '  ' })).toThrow(PspBuildError);
    expect(() => createPaymentProvider(CONFIG, { ...SECRETS, webhookSigningSecret: '' })).toThrow(PspBuildError);
  });
});
