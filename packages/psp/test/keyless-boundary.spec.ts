import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The pure core must be secret-free and network-free: no process.env, no runtime iyzipay SDK import, no
// fetch, no per-request entropy. Credentials + fetch + randomKey live ONLY in the dirty adapter. We guard the
// CODE, not doc comments (which legitimately mention iyzipay@2.0.69 as the contract source), so strip comments.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (f: string): string => stripComments(readFileSync(join(srcDir, f), 'utf8'));
const allSrc = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

const PURE_CORE = [
  'classify.ts',
  'verify-webhook.ts',
  'auth-header.ts',
  'request-builders.ts',
  'response-projectors.ts',
  'ports.ts',
  'outcomes.ts',
  'errors.ts',
  'types.ts',
];

describe('keyless / secretless boundary guards', () => {
  it('NO file in the package reads process.env or imports the iyzipay SDK at runtime', () => {
    for (const f of allSrc) {
      const src = read(f);
      expect(src, `${f} must not read process.env`).not.toContain('process.env');
      expect(src, `${f} must not import 'iyzipay'`).not.toMatch(/['"]iyzipay['"]/);
    }
  });

  it('the pure core holds no network I/O and no per-request entropy', () => {
    for (const f of PURE_CORE) {
      const src = read(f);
      expect(src, `${f} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${f} must not generate entropy (randomBytes)`).not.toContain('randomBytes');
    }
  });

  it('fetch and per-request entropy live ONLY in the iyzico adapter', () => {
    expect(read('iyzico-adapter.ts')).toMatch(/\bfetch\s*\(/);
    expect(read('iyzico-adapter.ts')).toContain('randomBytes');
    for (const f of allSrc.filter((x) => x !== 'iyzico-adapter.ts')) {
      expect(read(f), `${f} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
