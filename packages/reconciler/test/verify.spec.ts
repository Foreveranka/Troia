import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acceptanceNetwork, buildAcceptanceReport } from './fixtures/build-corpus.js';
import { verifyReport, type ReconReport } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const blockNet = join(pkgRoot, 'bin', 'block-net.mjs');
const runner = join(pkgRoot, 'bin', 'verify.mjs');
const reportPath = join(here, 'fixtures', 'recon-report.json');
const tamperedPath = join(here, 'fixtures', 'recon-report.tampered.json');
const livePath = join(here, 'fixtures', 'recon-report.live.json');

// The committed acceptance corpus is signed by a throwaway seed-derived operator, so the offline runner must be
// pinned to THAT operator (never the report's own field). Real reviewer-facing reports pin to the canonical
// deployment operator (read here straight from the committed record).
const corpusOperator = acceptanceNetwork().operator_public;
const canonicalOperator = (
  JSON.parse(readFileSync(join(repoRoot, 'deployment.testnet.json'), 'utf8')) as {
    operatorPublic: string;
  }
).operatorPublic;

interface RunOut {
  code: number;
  out: string;
  err: string;
}
function runVerify(path: string): RunOut {
  try {
    const out = execFileSync('node', ['--import', blockNet, runner, path], {
      encoding: 'utf8',
      env: { ...process.env, TROIA_OPERATOR_PUBLIC: corpusOperator },
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

describe('just verify — offline armed acceptance (3.4)', () => {
  beforeAll(() => {
    // Regenerate the committed acceptance report deterministically, then build the package for the runner.
    writeFileSync(reportPath, JSON.stringify(buildAcceptanceReport(), null, 2) + '\n');
    execFileSync('pnpm', ['--filter', '@troia/reconciler', 'build'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  }, 180_000);

  it('exits 0 with the network blocked; summary {total:3, matched:2, mismatch:1, unsettled:0}', () => {
    const { code, out, err } = runVerify(reportPath);
    expect(code, `stderr: ${err}`).toBe(0);
    const res = JSON.parse(out);
    expect(res.ok).toBe(true);
    expect(res.networkAttempts).toBe(0);
    expect(res.ordersVerified).toBe(3);
    expect(res.summary).toEqual({ total: 3, matched: 2, mismatch: 1, unsettled: 0 });
    expect(res.failures).toEqual([]);
  });

  it('the committed report proves ord-003 = CORRUPT_LOCAL with a valid signature', () => {
    const report = buildAcceptanceReport();
    const o = report.orders[2];
    expect(o?.order_id).toBe('ord-003');
    expect(o?.verdict).toBe('CORRUPT_LOCAL');
    expect(o?.signature_valid).toBe(true);
  });

  it('a tampered stored verdict flips the exit code to non-zero (recomputation disagrees)', () => {
    const report = JSON.parse(JSON.stringify(buildAcceptanceReport()));
    report.orders[2].verdict = 'MATCHED';
    report.orders[2].status = 'matched';
    report.summary = { total: 3, matched: 3, mismatch: 0, unsettled: 0 };
    writeFileSync(tamperedPath, JSON.stringify(report));
    const { code, out } = runVerify(tamperedPath);
    expect(code).not.toBe(0);
    const res = JSON.parse(out);
    expect(res.ok).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);
  });

  it('rejects a report whose operator is not the canonical one — the self-signed forge is closed', () => {
    // The corpus is signed by a throwaway operator (not Troia's canonical one) — the exact shape of a forgery:
    // a report that names, and is signed by, a non-canonical key. Under the OLD self-referential verify this
    // passed (that IS the 999,999-USDC self-signed-payout forge). Pinned to canonical, it must fail on BOTH the
    // operator mismatch AND every signature re-deriving to EVIDENCE_TAMPERED.
    const r = verifyReport(buildAcceptanceReport(), canonicalOperator);
    expect(r.ok).toBe(false);
    expect(
      r.failures.some((f) => f.includes('operator_public') && f.includes('!= canonical')),
    ).toBe(true);
    expect(r.failures.some((f) => f.includes('recomputed EVIDENCE_TAMPERED'))).toBe(true);
  });

  it('accepts a genuine report whose operator IS the canonical one (no over-rejection)', () => {
    const live = JSON.parse(readFileSync(livePath, 'utf8')) as ReconReport;
    const r = verifyReport(live, canonicalOperator);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('the bin fails closed (exit 2) when the canonical operator cannot be resolved — never falls back to the report', () => {
    const env = { ...process.env };
    delete env.TROIA_OPERATOR_PUBLIC;
    env.TROIA_DEPLOYMENT_PATH = join(here, 'fixtures', '__no_such_deployment__.json');
    let code = 0;
    let out = '';
    try {
      execFileSync('node', ['--import', blockNet, runner, reportPath], { encoding: 'utf8', env });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      out = err.stdout ?? '';
    }
    expect(code).toBe(2); // exit 2 = anchor unresolved (NOT 0/1 = fell back to the report and verified)
    if (out.length > 0) expect(JSON.parse(out).ok).not.toBe(true);
  });

  it('the corpus operator hardcoded in justfile / ci.yml / tamper-check.mjs matches the seed derivation', () => {
    // Those three files hardcode this value (they cannot import the TS fixture). corpusOperator is DERIVED from
    // generate.ts operatorKeypair('troia-demo-0001'); pinning it here means a drifted hardcoded copy is caught,
    // not silently mis-pinned.
    expect(corpusOperator).toBe('GA6C2W6OPOJJYIRCG3QSMTD7MZVBTVQM6QATLOPVGXI2AIUGXCSNE52K');
  });
});
