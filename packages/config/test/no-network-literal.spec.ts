import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: network-specific literals must live ONLY in packages/config. If any other package
// hard-codes a passphrase, RPC/Horizon host, or PSP host, boundary discipline has been broken.

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, '..', '..'); // packages/

const FORBIDDEN: readonly string[] = [
  'Test SDF Network', // network passphrase
  'soroban-testnet.stellar.org',
  'horizon-testnet.stellar.org',
  'sandbox-api.iyzipay.com',
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('network-literal boundary', () => {
  it('no package other than config hard-codes a network-specific literal', () => {
    const packages = readdirSync(packagesDir).filter((p) => {
      if (p === 'config') return false;
      try {
        return statSync(join(packagesDir, p)).isDirectory();
      } catch {
        return false;
      }
    });

    const offenders: string[] = [];
    for (const pkg of packages) {
      const srcDir = join(packagesDir, pkg, 'src');
      let files: string[];
      try {
        files = collectSourceFiles(srcDir);
      } catch {
        continue; // no src yet
      }
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const literal of FORBIDDEN) {
          if (content.includes(literal)) {
            offenders.push(`${file} contains forbidden literal "${literal}"`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
