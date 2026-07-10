import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Troia settles against ONE deployment: one USDC issuer, one asset contract, one TroyPool, one operator, one
// admin. That identity is not a machine-local detail a clone re-invents — it is the project, and it is recorded
// in `deployment.testnet.json`, which is committed precisely because every value in it is public (the same five
// appear in docs/DEPLOYMENTS.md).
//
// The two apps cannot import `@troia/config` — they are standalone npm packages — so each keeps a generated
// module holding the one identifier it must pin: the issuer. `just fund` writes those files from the record.
// Nothing stops a hand-edit, a stale checkout, or a `just bootstrap` on a branch from letting them drift, and a
// drifted extension does not fail loudly: it fails CLOSED, silently refusing to show the banner for the very
// USDC it was built to settle. That is why this is a test and not a convention.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const STRKEY_ACCOUNT = /^G[A-Z2-7]{55}$/;
const STRKEY_CONTRACT = /^C[A-Z2-7]{55}$/;

interface Deployment {
  readonly usdcIssuer: string;
  readonly usdcSacContractId: string;
  readonly troyPool: string;
  readonly operatorPublic: string;
  readonly adminPublic: string;
  readonly backendUrl: string;
  readonly storefrontOrigins: readonly string[];
}

function readDeployment(): Deployment {
  const raw = readFileSync(join(repoRoot, 'deployment.testnet.json'), 'utf8');
  return JSON.parse(raw) as Deployment;
}

/** The generated modules are plain constants by construction, so read them as text rather than importing a
 *  browser-targeted package into this suite. If the shape ever stops matching, that is itself a finding. */
function readGeneratedIssuer(relPath: string): string {
  const src = readFileSync(join(repoRoot, relPath), 'utf8');
  const m = /export const USDC_ISSUER = '([^']+)';/.exec(src);
  expect(m, `${relPath}: no \`export const USDC_ISSUER = '…'\``).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

const GENERATED = [
  'app/storefront/src/deployment.generated.ts',
  'app/extension/src/lib/deployment.generated.ts',
] as const;

describe('the deployment record is the one source of Troia’s on-chain identity', () => {
  it('is committed, not ignored — a clone must not have to re-invent the pool', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    const ignoresIt = gitignore
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === 'deployment.testnet.json' || l === '/deployment.testnet.json');
    expect(ignoresIt, '.gitignore must not ignore deployment.testnet.json').toBe(false);
  });

  it('holds the five on-chain identifiers, each a well-formed strkey', () => {
    const d = readDeployment();
    expect(d.usdcIssuer).toMatch(STRKEY_ACCOUNT);
    expect(d.operatorPublic).toMatch(STRKEY_ACCOUNT);
    expect(d.adminPublic).toMatch(STRKEY_ACCOUNT);
    expect(d.usdcSacContractId).toMatch(STRKEY_CONTRACT);
    expect(d.troyPool).toMatch(STRKEY_CONTRACT);
  });

  // Going live must be a change to this record, never to the extension's source. Both the manifest's match
  // patterns and the background worker's exact-origin allowlist are generated from these two fields.
  it('holds the service endpoints, as bare origins', () => {
    const d = readDeployment();
    expect(d.backendUrl).toMatch(/^https?:\/\/[^/]+$/);
    expect(d.storefrontOrigins.length).toBeGreaterThan(0);
    for (const o of d.storefrontOrigins) expect(o).toMatch(/^https?:\/\/[^/]+$/);
  });

  it('carries no secret — a seed would be a catastrophe in a committed file', () => {
    const raw = readFileSync(join(repoRoot, 'deployment.testnet.json'), 'utf8');
    expect(raw).not.toMatch(/\bS[A-Z2-7]{55}\b/); // a Stellar secret seed
    expect(raw).not.toMatch(/PRIVATE KEY/i);
  });

  it('three roles are three distinct keys, even on testnet', () => {
    const d = readDeployment();
    const keys = [d.usdcIssuer, d.operatorPublic, d.adminPublic];
    expect(new Set(keys).size, 'issuer, operator and admin must not collapse').toBe(3);
  });

  it.each(GENERATED)('%s pins the deployment’s issuer, not one someone typed', (rel) => {
    expect(readGeneratedIssuer(rel)).toBe(readDeployment().usdcIssuer);
  });

  it('the extension pins the deployment’s backend and storefront origins', () => {
    const d = readDeployment();
    const src = readFileSync(
      join(repoRoot, 'app/extension/src/lib/deployment.generated.ts'),
      'utf8',
    );
    const backend = /export const BACKEND_BASE_URL = '([^']+)';/.exec(src);
    expect(backend?.[1]).toBe(d.backendUrl);
    for (const o of d.storefrontOrigins) expect(src).toContain(`'${o}'`);
  });

  it('both apps agree with each other — a half-run `just fund` is a real failure mode', () => {
    const [storefront, extension] = GENERATED.map(readGeneratedIssuer);
    expect(storefront).toBe(extension);
  });
});
