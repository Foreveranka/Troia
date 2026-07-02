// Offline verify runner. Launch: `node --import ./block-net.mjs ./verify.mjs <report.json>`.
// Positive-armed exit: exit 0 ONLY if the network block is provably armed (a deliberate connect throws),
// every order re-derived, network attempts stayed 0, and all re-derivations matched. Emits one JSON line.

import net from 'node:net';
import { readFileSync } from 'node:fs';
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

const result = verifyReport(report);
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
