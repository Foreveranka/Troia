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

// TWO trust anchors, resolved by the SAME rule: from OUTSIDE the report, never from it. An explicit env override
// (set only by a trusted runner — e.g. the synthetic-corpus `just verify` targets, whose throwaway signer and
// throwaway pool are deliberately not the deployment's), else the committed deployment record. Fail closed (exit 2)
// if either cannot resolve to a well-formed key — never fall back to the report.
//
//   operator (G…) — WHO signed. Else a forged report names, and self-signs with, an attacker's key and passes
//                   against itself.
//   TroyPool (C…) — WHERE the money went. A signature proves authorship, not destination: an operator-signed pay()
//                   to a look-alike contract drains nothing from the canonical pool yet re-derives MATCHED, because
//                   the report supplies BOTH sides of every contract comparison it makes.
function readDeployment() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const path = process.env.TROIA_DEPLOYMENT_PATH ?? join(repoRoot, 'deployment.testnet.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveAnchor(envVar, deploymentField) {
  const override = process.env[envVar];
  if (typeof override === 'string' && override.length > 0) return override;
  return readDeployment()[deploymentField];
}

let canonicalOperator;
let canonicalTroyPool;
try {
  canonicalOperator = resolveAnchor('TROIA_OPERATOR_PUBLIC', 'operatorPublic');
  canonicalTroyPool = resolveAnchor('TROIA_TROY_POOL', 'troyPool');
} catch (e) {
  fail(`cannot resolve the canonical anchors: ${e.message}`);
}
if (typeof canonicalOperator !== 'string' || !/^G[A-Z2-7]{55}$/.test(canonicalOperator)) {
  fail(`canonical operator is not a valid G-key: ${canonicalOperator}`);
}
if (typeof canonicalTroyPool !== 'string' || !/^C[A-Z2-7]{55}$/.test(canonicalTroyPool)) {
  fail(`canonical TroyPool is not a valid C-address: ${canonicalTroyPool}`);
}

const result = verifyReport(report, canonicalOperator, canonicalTroyPool);
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
