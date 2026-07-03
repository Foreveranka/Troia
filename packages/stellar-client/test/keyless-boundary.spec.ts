import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The INVERSE of the reconciler's keyless guard, with a DIFFERENT forbidden list. The stellar-client is the
// dirty package (it builds/signs/submits), so nativeToScVal/.build/.toXDR are legitimately used by the pure
// core. What must stay quarantined: no key material and no network SDK Server in the pure core; the Signer
// is the single keyed seam; the SDK Servers live only in the adapters; no file reads secrets from env.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Strip comments before scanning: a doc comment mentioning a forbidden token (e.g. explaining that the
// pure core must NOT import Keypair) is documentation, not a violation. We guard the CODE, not the prose.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (f: string): string => stripComments(readFileSync(join(srcDir, f), 'utf8'));

const PURE_CORE = [
  'build.ts',
  'assemble.ts',
  'submit-reducer.ts',
  'deadness.ts',
  'account-snapshot.ts',
  'ports.ts',
  'outcomes.ts',
  'errors.ts',
];

describe('keyless / dirty separation guards', () => {
  it('no pure-core file holds key material or a concrete SDK Server', () => {
    for (const f of PURE_CORE) {
      const src = read(f);
      expect(src, `${f} must not import Keypair`).not.toMatch(/\bKeypair\b/);
      expect(src, `${f} must not construct an rpc.Server`).not.toContain('rpc.Server');
      expect(src, `${f} must not construct a Horizon.Server`).not.toContain('Horizon.Server');
    }
  });

  it('no file in the package reads secrets from process.env (secrets are injected at the composition root)', () => {
    for (const f of [...PURE_CORE, 'client.ts', 'index.ts', 'signer.ts', 'rpc-adapter.ts', 'horizon-adapter.ts']) {
      expect(read(f), `${f} must not read process.env`).not.toContain('process.env');
    }
  });

  it('the conductor holds no key and no SDK Server (it uses injected ports only)', () => {
    const src = read('client.ts');
    expect(src).not.toMatch(/\bKeypair\b/);
    expect(src).not.toContain('rpc.Server');
    expect(src).not.toContain('Horizon.Server');
  });

  it('the public surface (index.ts) is SDK-free (no Server type crosses it)', () => {
    const src = read('index.ts');
    expect(src).not.toContain('rpc.Server');
    expect(src).not.toContain('Horizon.Server');
    expect(src).not.toContain("from '@stellar/stellar-sdk'");
  });

  it('signing lives ONLY in signer.ts', () => {
    expect(read('signer.ts')).toMatch(/\bKeypair\b/);
    // no OTHER src file may import Keypair from stellar-base for signing purposes
    for (const f of [...PURE_CORE, 'client.ts']) {
      expect(read(f)).not.toMatch(/\bKeypair\b/);
    }
  });

  it('the SDK Servers live ONLY in their adapters', () => {
    expect(read('rpc-adapter.ts')).toContain('rpc.Server');
    expect(read('horizon-adapter.ts')).toContain('Horizon.Server');
  });
});
