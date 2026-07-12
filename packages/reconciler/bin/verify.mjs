// Offline verify runner. Launch: `node --import ./block-net.mjs ./verify.mjs <report.json>`.
// Positive-armed exit: exit 0 ONLY if the network block is provably armed (a deliberate connect throws),
// every order re-derived, network attempts stayed 0, and all re-derivations matched. Emits one JSON line.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { verifyReport } from '../dist/verify.js';

function fail(error, code = 2) {
  console.error(JSON.stringify({ ok: false, error }));
  process.exit(code);
}

// 1) Startup canary — the guard MUST be armed. Turns "did not call out" into "the block is active".
let armed = false;
try {
  net.connect(65535, '127.0.0.1');
} catch {
  armed = true;
}
if (!armed) fail('guard-not-armed');
globalThis.__troiaNet.attempts = 0; // discard the canary's own increment

const reportPath = process.argv[2];
if (!reportPath) fail('usage: verify.mjs <report.json>');

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  fail(`cannot read report: ${e.message}`);
}

// The trust anchor: the operator key every signature is checked against. It MUST come from OUTSIDE the report —
// else a forged report could name (and self-sign with) an attacker's key and pass against itself. Precedence: an
// explicit TROIA_OPERATOR_PUBLIC (set only by a trusted runner — e.g. the synthetic-corpus `just verify` targets,
// whose throwaway signer is deliberately not the deployment operator), else the committed deployment record.
// NEVER the report. Fail closed (exit 2) if it cannot resolve to a well-formed G-key — never fall back to the report.
function resolveCanonicalOperator() {
  const override = process.env.TROIA_OPERATOR_PUBLIC;
  if (typeof override === 'string' && override.length > 0) return override;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const deploymentPath =
    process.env.TROIA_DEPLOYMENT_PATH ?? join(repoRoot, 'deployment.testnet.json');
  return JSON.parse(readFileSync(deploymentPath, 'utf8')).operatorPublic;
}

let canonicalOperator;
try {
  canonicalOperator = resolveCanonicalOperator();
} catch (e) {
  fail(`cannot resolve canonical operator: ${e.message}`);
}
if (typeof canonicalOperator !== 'string' || !/^G[A-Z2-7]{55}$/.test(canonicalOperator)) {
  fail(`canonical operator is not a valid G-key: ${canonicalOperator}`);
}

const result = verifyReport(report, canonicalOperator);
const attempts = globalThis.__troiaNet.attempts;
const expectedOrders = Array.isArray(report.orders) ? report.orders.length : -1;
const ok = result.ok && attempts === 0 && result.ordersVerified === expectedOrders;

console.log(
  JSON.stringify({
    ok,
    summary: result.summary,
    ordersVerified: result.ordersVerified,
    networkAttempts: attempts,
    failures: result.failures,
  }),
);
process.exit(ok ? 0 : 1);
