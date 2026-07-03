import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as psp from '../src/index.js';

// Strip comments: index.ts's doc comment legitimately explains WHY IyzicoSandboxProvider is not exported.
const rawIndex = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
);
const indexSrc = rawIndex.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('public surface — SDK/secret-free', () => {
  it('does NOT re-export the credential-bearing IyzicoSandboxProvider', () => {
    expect(indexSrc).not.toContain('IyzicoSandboxProvider');
    expect('IyzicoSandboxProvider' in psp).toBe(false);
  });

  it('exposes the pure core + the createPaymentProvider factory', () => {
    expect(typeof psp.classifyIyzicoResult).toBe('function');
    expect(typeof psp.verifyWebhookSignature).toBe('function');
    expect(typeof psp.computeAuthorizationHeader).toBe('function');
    expect(typeof psp.createPaymentProvider).toBe('function');
    expect(typeof psp.buildPreAuthRequest).toBe('function');
  });
});
