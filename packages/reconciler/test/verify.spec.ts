import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAcceptanceReport } from './fixtures/build-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const blockNet = join(pkgRoot, 'bin', 'block-net.mjs');
const runner = join(pkgRoot, 'bin', 'verify.mjs');
const reportPath = join(here, 'fixtures', 'recon-report.json');
const tamperedPath = join(here, 'fixtures', 'recon-report.tampered.json');

interface RunOut {
  code: number;
  out: string;
  err: string;
}
function runVerify(path: string): RunOut {
  try {
    const out = execFileSync('node', ['--import', blockNet, runner, path], { encoding: 'utf8' });
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
    execFileSync('pnpm', ['--filter', '@troia/reconciler', 'build'], { cwd: repoRoot, stdio: 'ignore' });
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
});
