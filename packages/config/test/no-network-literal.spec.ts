import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: network-specific literals must live ONLY in a designated config module per deployable —
// `packages/config` for the backend/contracts/core, and each app's own config module (the storefront +
// extension are STANDALONE npm packages that can't import `@troia/config`, so each owns one config file).
// If any OTHER source file hard-codes a passphrase, RPC/Horizon/PSP host, or a bare Stellar address
// (G.../C...), boundary discipline has been broken and "mainnet = swap the config" is no longer true.

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, '..', '..'); // packages/
const repoRoot = resolve(packagesDir, '..'); // repo root
const appDir = join(repoRoot, 'app');

// Host / passphrase literals that belong only in a config module.
const FORBIDDEN_LITERALS: readonly string[] = [
  'Test SDF Network', // network passphrase
  'soroban-testnet.stellar.org',
  'horizon-testnet.stellar.org',
  'sandbox-api.iyzipay.com',
];

// Any bare Stellar strkey public address literal (G-account or C-contract, 56 base32 chars). Catches a
// hard-coded issuer / merchant / operator / contract id, not just today's deployment.
const STELLAR_ADDRESS = /\b[GC][A-Z2-7]{55}\b/;

// The designated config module of each deployable — the ONE place a network literal is allowed. Everything
// else under the scanned roots must be clean. (packages/config is excluded wholesale below.)
const CONFIG_MODULES: readonly string[] = [
  join(appDir, 'storefront', 'src', 'config.ts'),
  join(appDir, 'extension', 'src', 'lib', 'config.ts'),
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // no such dir (e.g. a package with no src yet)
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...collectSourceFiles(full));
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every src file that must NOT hold a network literal: packages/<pkg>/src (except config) + app/<app>/src
 *  (except each app's designated config module). */
function scannedFiles(): string[] {
  const files: string[] = [];

  const pkgs = readdirSync(packagesDir).filter((p) => {
    if (p === 'config') return false; // the designated config authority for the backend/core
    try {
      return statSync(join(packagesDir, p)).isDirectory();
    } catch {
      return false;
    }
  });
  for (const pkg of pkgs) files.push(...collectSourceFiles(join(packagesDir, pkg, 'src')));

  let apps: string[] = [];
  try {
    apps = readdirSync(appDir).filter((a) => {
      try {
        return statSync(join(appDir, a)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    apps = []; // no app/ dir
  }
  for (const app of apps) {
    for (const file of collectSourceFiles(join(appDir, app, 'src'))) {
      if (!CONFIG_MODULES.includes(file)) files.push(file); // the app's config module is the allowed boundary
    }
  }

  return files;
}

describe('network-literal boundary', () => {
  const files = scannedFiles();

  it('scans both packages/ and app/ (a real sample of each, so the guard cannot silently cover nothing)', () => {
    // Sanity: the app layer is actually in scope. If this ever drops to zero the guard would be scanning
    // nothing meaningful in app/ and the boundary claim would be vacuous.
    expect(files.some((f) => f.includes(`${join(appDir, 'storefront')}`))).toBe(true);
    expect(files.some((f) => f.includes(`${join(appDir, 'extension')}`))).toBe(true);
  });

  it('no source outside a config module hard-codes a network host, passphrase, or Stellar address', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const literal of FORBIDDEN_LITERALS) {
        if (content.includes(literal)) offenders.push(`${file} contains forbidden literal "${literal}"`);
      }
      const addr = content.match(STELLAR_ADDRESS);
      if (addr) offenders.push(`${file} hard-codes a Stellar address literal "${addr[0]}"`);
    }
    expect(offenders).toEqual([]);
  });
});
