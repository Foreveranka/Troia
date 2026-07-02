import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural enforcement of the (b) invariant: src must never SIGN or BUILD a transaction, hold key
// material, or read env. With no signing key in-module, a refactor that re-serializes (b) from a corrupted
// (a) can at most emit an UNSIGNED blob whose signature check fails — the model cannot be silently broken.
// Note: TransactionBuilder.fromXDR and scValToNative are DECODE-only and allowed; the build/sign surface is not.
const FORBIDDEN = [
  '.sign(',
  '.build(',
  '.toXDR(',
  'Keypair.fromSecret',
  'Keypair.fromRawEd25519Seed',
  'Keypair.random',
  'nativeToScVal',
  'process.env',
];

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('reconciler src is keyless & buildless by construction', () => {
  it('no signing / key-material / env primitive appears in any src file', () => {
    for (const file of tsFiles(srcDir)) {
      const body = readFileSync(file, 'utf8');
      for (const bad of FORBIDDEN) {
        expect(body.includes(bad), `${file} contains forbidden "${bad}"`).toBe(false);
      }
    }
  });
});
