// scripts/tamper-check.mjs — the NEGATIVE half of the offline reconciliation proof (docs/RECONCILIATION.md §5).
// `just verify` proves an honest report re-derives; this proves a DISHONEST one cannot. It reads the committed
// honest report, flips one order's stored verdict to a lie, writes the forgery to a temp file, and runs the same
// network-blocked verifier over it. The forgery must be caught by RE-DERIVATION, not by a missing file:
//
//   verify.mjs exit 1 = it read the report and the recomputation disagreed  -> the proof we want
//   verify.mjs exit 2 = it could not even read the report (ENOENT, bad JSON) -> proves NOTHING
//
// Asserting only "non-zero exit" would accept exit 2 and silently test nothing, so this script pins exit == 1 AND
// the recomputed-verdict failure line. Exit 0 here means "the tamper was detected". Nothing is written into the
// repo, so a reviewer can run it on a bare clone in any order. Wired as `just verify-tampered`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const blockNet = join(repoRoot, 'packages/reconciler/bin/block-net.mjs');
const verifier = join(repoRoot, 'packages/reconciler/bin/verify.mjs');
const honestPath =
  process.argv[2] ?? join(repoRoot, 'packages/reconciler/test/fixtures/recon-report.json');

// The committed acceptance corpus is signed by a throwaway, seed-derived operator (generate.ts
// operatorKeypair('troia-demo-0001')), NOT the real deployment operator whose secret is never committed. Pin the
// verifier to that corpus operator so re-derivation reaches the tampered order's VERDICT (a canonical-operator
// mismatch would short-circuit first). This is a committed, non-report constant — never sourced from the report
// itself. An explicit TROIA_OPERATOR_PUBLIC (e.g. set by `just verify-tampered`) wins for standalone runs.
const CORPUS_OPERATOR = 'GA6C2W6OPOJJYIRCG3QSMTD7MZVBTVQM6QATLOPVGXI2AIUGXCSNE52K';

function die(reason) {
  console.error(`tamper-check FAILED: ${reason}`);
  process.exit(1);
}

let honest;
try {
  honest = JSON.parse(readFileSync(honestPath, 'utf8'));
} catch (e) {
  die(`cannot read the honest report at ${honestPath}: ${e.message}`);
}

// Pick the order the honest report already convicts. Lying about THIS one is the sharpest test: its signature is
// valid, so only re-deriving the verdict from the embedded evidence can expose the lie.
const target = honest.orders.findIndex((o) => o.verdict === 'CORRUPT_LOCAL');
if (target === -1) die(`no CORRUPT_LOCAL order in ${honestPath} — nothing to lie about`);

const forged = JSON.parse(JSON.stringify(honest));
forged.orders[target].verdict = 'MATCHED';
forged.orders[target].status = 'matched';
forged.summary = { ...honest.summary, matched: honest.summary.matched + 1, mismatch: 0 };

const forgedPath = join(mkdtempSync(join(tmpdir(), 'troia-tamper-')), 'recon-report.tampered.json');
writeFileSync(forgedPath, JSON.stringify(forged, null, 2) + '\n');

let stdout = '';
let code = 0;
try {
  stdout = execFileSync('node', ['--import', blockNet, verifier, forgedPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TROIA_OPERATOR_PUBLIC: process.env.TROIA_OPERATOR_PUBLIC ?? CORPUS_OPERATOR,
    },
  });
} catch (e) {
  code = e.status ?? -1;
  stdout = e.stdout ?? '';
}

if (code === 0) die('the verifier ACCEPTED a forged report');
if (code !== 1)
  die(`the verifier exited ${code} — it never read the report, so nothing was proven`);

let result;
try {
  result = JSON.parse(stdout);
} catch {
  die(`the verifier emitted no JSON verdict (stdout: ${stdout.trim() || '<empty>'})`);
}
if (result.ok !== false) die(`expected ok:false, got ok:${result.ok}`);
if (result.networkAttempts !== 0)
  die(`the verifier touched the network ${result.networkAttempts}x`);

const orderId = honest.orders[target].order_id;
const caught = (result.failures ?? []).some(
  (f) => f.includes(orderId) && f.includes('recomputed CORRUPT_LOCAL'),
);
if (!caught)
  die(`no re-derivation failure for ${orderId}; failures: ${JSON.stringify(result.failures)}`);

console.log(JSON.stringify({ tamperDetected: true, verifierExit: code, ...result }));
