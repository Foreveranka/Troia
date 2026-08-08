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

// The ONE sanctioned exception, explicit so it cannot spread silently. Channel-mode P2 (A-5) verifies the
// operator's auth-entry signature over the SorobanAuthorization HASH-ID PREIMAGE, and computing that payload
// requires serializing the preimage (`preimage.toXDR()`) to hash it. That is VERIFICATION: no key material,
// no signing, and the serialized bytes are hashed-and-compared, never emitted as evidence. The invariant's
// teeth — the Keypair/sign bans that make forging impossible — remain global and unexceptioned.
const ALLOWED: readonly { readonly file: string; readonly token: string }[] = [
  { file: 'verify-crypto.ts', token: '.toXDR(' },
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
        const allowed = ALLOWED.some((a) => file.endsWith(a.file) && a.token === bad);
        if (allowed) continue;
        expect(body.includes(bad), `${file} contains forbidden "${bad}"`).toBe(false);
      }
    }
  });
});
