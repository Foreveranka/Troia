// Composition-root factory. Wiring only, no money-branching. The secrets are injected here (from env at the
// backend), never read from process.env inside the package.

import { IyzicoSandboxProvider } from './iyzico-adapter.js';
import { PspBuildError } from './errors.js';
import type { PaymentProvider, PspNetworkConfig, PspSecrets } from './ports.js';

function requireNonEmpty(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PspBuildError(`missing or empty psp config: ${name}`);
  }
}

export function createPaymentProvider(
  config: PspNetworkConfig,
  secrets: PspSecrets,
): PaymentProvider {
  // Fail fast on a misconfigured deploy rather than run silently keyless (an empty HMAC key is attacker-known).
  requireNonEmpty('baseUrl', config.baseUrl);
  requireNonEmpty('apiKey', secrets.apiKey);
  requireNonEmpty('secretKey', secrets.secretKey);
  requireNonEmpty('webhookSigningSecret', secrets.webhookSigningSecret);
  return new IyzicoSandboxProvider(config, secrets);
}
