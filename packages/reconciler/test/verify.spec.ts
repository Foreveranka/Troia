import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Networks, StrKey } from '@stellar/stellar-base';
import {
  acceptanceNetwork,
  acceptanceTroyPool,
  buildAcceptanceReport,
} from './fixtures/build-corpus.js';
import { buildSignedPay, bytes32 } from './fixtures/generate.js';
import { buildReconReport } from '../src/report.js';
import { decodeSignedPay, verifyReport, type ReconReport } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const blockNet = join(pkgRoot, 'bin', 'block-net.mjs');
const runner = join(pkgRoot, 'bin', 'verify.mjs');
const reportPath = join(here, 'fixtures', 'recon-report.json');
const tamperedPath = join(here, 'fixtures', 'recon-report.tampered.json');
const livePath = join(here, 'fixtures', 'recon-report.live.json');

// The committed acceptance corpus is signed by a throwaway seed-derived operator and settles through a throwaway
// seed-derived pool, so the offline runner must be pinned to THOSE (never the report's own fields). Real
// reviewer-facing reports pin to the canonical deployment anchors (read here straight from the committed record).
const corpusOperator = acceptanceNetwork().operator_public;
const corpusPool = acceptanceTroyPool();
const deployment = JSON.parse(readFileSync(join(repoRoot, 'deployment.testnet.json'), 'utf8')) as {
  operatorPublic: string;
  troyPool: string;
};
const canonicalOperator = deployment.operatorPublic;
const canonicalPool = deployment.troyPool;

interface RunOut {
  code: number;
  out: string;
  err: string;
}
function runVerify(path: string, overrides: Record<string, string> = {}): RunOut {
  try {
    const out = execFileSync('node', ['--import', blockNet, runner, path], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TROIA_OPERATOR_PUBLIC: corpusOperator,
        TROIA_TROY_POOL: corpusPool,
        ...overrides,
      },
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
    const r = verifyReport(buildAcceptanceReport(), canonicalOperator, canonicalPool);
    expect(r.ok).toBe(false);
    expect(
      r.failures.some((f) => f.includes('operator_public') && f.includes('!= canonical')),
    ).toBe(true);
    expect(r.failures.some((f) => f.includes('recomputed EVIDENCE_TAMPERED'))).toBe(true);
  });

  it('accepts a genuine report whose operator IS the canonical one (no over-rejection)', () => {
    const live = JSON.parse(readFileSync(livePath, 'utf8')) as ReconReport;
    const r = verifyReport(live, canonicalOperator, canonicalPool);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('the bin fails closed (exit 2) when an anchor cannot be resolved — never falls back to the report', () => {
    const env = { ...process.env };
    delete env.TROIA_OPERATOR_PUBLIC;
    delete env.TROIA_TROY_POOL;
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

  it('the bin fails closed (exit 2) on a malformed TroyPool anchor — a G-key is not a settlement contract', () => {
    const { code } = runVerify(reportPath, { TROIA_TROY_POOL: corpusOperator });
    expect(code).toBe(2);
  });

  it('the corpus anchors hardcoded in justfile / ci.yml / tamper-check.mjs match the seed derivation', () => {
    // Those three files hardcode these values (they cannot import the TS fixture). Both are DERIVED here from the
    // 'troia-demo-0001' seed, so a drifted hardcoded copy is caught rather than silently mis-pinning the verifier.
    expect(corpusOperator).toBe('GA6C2W6OPOJJYIRCG3QSMTD7MZVBTVQM6QATLOPVGXI2AIUGXCSNE52K');
    expect(corpusPool).toBe('CBE4G2FHXZGGEYNUTBAICHPKMMVGJBF4757GY5IRBLMRP3O42CLCYPHB');
  });
});

// The dishonest-operator attack the operator pin alone does NOT stop. Every signature is genuine, every hash is
// self-consistent, the chain snapshot agrees with the signed XDR — and not one stroop left the canonical TroyPool,
// because the pay() went to a contract the operator deployed itself. The report is internally flawless: it says
// MATCHED, and re-deriving it from the embedded evidence AGREES. Only an anchor from outside the report can see it.
describe('verifyReport — the settlement contract is pinned, not merely self-consistent', () => {
  const LOOKALIKE = StrKey.encodeContract(createHash('sha256').update('lookalike-pool').digest());

  /** One order, fully coherent, settled through `pool`. With pool = LOOKALIKE this is the forgery. */
  function reportSettledThrough(pool: string): ReconReport {
    const merchant = 'GA6C2W6OPOJJYIRCG3QSMTD7MZVBTVQM6QATLOPVGXI2AIUGXCSNE52K';
    const memo = bytes32('lookalike|memo');
    const built = buildSignedPay({
      seed: 'troia-demo-0001', // the CORPUS operator — a real, valid, canonical-for-this-corpus signature
      troyPoolContractId: pool,
      txId32: bytes32('lookalike|txid'),
      amountStroops: 999_999_0000000n,
      appliedRate: 411_075_000n,
      merchant,
      memo32: memo,
      seq: '200',
      passphrase: Networks.TESTNET,
    });
    const dec = decodeSignedPay(built.signed_xdr, Networks.TESTNET);
    return buildReconReport('lookalike', acceptanceNetwork(), [
      {
        business_intent: {
          order_id: 'ord-forged',
          destination: merchant,
          amount_stroops: '9999990000000',
          memo_hex: memo.toString('hex'),
        },
        ledger_evidence: { signed_xdr: built.signed_xdr, hash: built.hash },
        chain_evidence: {
          tx_hash: built.hash,
          fetched_at_ledger: 2_000_200,
          horizon_snapshot: dec.projection, // the snapshot AGREES with the XDR — both name the look-alike
        },
      },
    ]);
  }

  it('the forgery is internally perfect: it re-derives to MATCHED, so nothing inside the report can catch it', () => {
    const forged = reportSettledThrough(LOOKALIKE);
    expect(forged.orders[0]?.verdict).toBe('MATCHED');
    expect(forged.orders[0]?.signature_valid).toBe(true);
    expect(forged.orders[0]?.chain_bound).toBe(true);
    expect(forged.summary).toEqual({ total: 1, matched: 1, mismatch: 0, unsettled: 0 });
  });

  it('pinned to the real pool, it FAILS — the payout never touched the canonical TroyPool', () => {
    const r = verifyReport(reportSettledThrough(LOOKALIKE), corpusOperator, corpusPool);
    expect(r.ok).toBe(false);
    expect(
      r.failures.some((f) => f.includes('signed pay() invokes') && f.includes(LOOKALIKE)),
    ).toBe(true);
    expect(
      r.failures.some((f) => f.includes('chain snapshot names') && f.includes(LOOKALIKE)),
    ).toBe(true);
  });

  it('the SAME order through the canonical pool verifies clean — the pin rejects the forgery, not the shape', () => {
    const r = verifyReport(reportSettledThrough(corpusPool), corpusOperator, corpusPool);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});
