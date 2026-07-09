// scripts/preflight.mjs — the live-smoke READINESS GATE wiring (ROADMAP Phase 4.5). Reads .env + the deployment
// record, then smokes every DIRTY dependency the end-to-end run needs — the operator account (fees), the pool USDC
// balance (readSacBalance), the CEX spot oracle, the Yahoo daily-close history, and iyzico reachability — and
// prints a green/red readiness report. Exit 0 = ready to drive a real charge; exit 1 = fix the reds first. Run via
// `just preflight` (node --env-file=.env). The network IS used (this is a live probe), but it moves NO money and
// creates NO checkout form. The pure report logic (runPreflight) is unit-tested offline in @troia/composition.

import { readFileSync } from 'node:fs';
import { testnetConfig } from '../packages/config/dist/index.js';
import { LiveCexOracle, YahooUsdTryHistory } from '../packages/oracle/dist/index.js';
import { buildPreflightProbes, runPreflight } from '../packages/composition/dist/index.js';
import { LocalKeySigner } from '../packages/stellar-client/dist/adapters.js';

function requireEnv(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim().length === 0) {
    console.error(`missing required env var ${name} (fill it in .env)`);
    process.exit(1);
  }
  return v;
}

const deploymentPath = process.env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json';
let deployment;
try {
  deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
} catch (e) {
  console.error(`cannot read ${deploymentPath}: ${e.message} — run 'just fund' first`);
  process.exit(1);
}
const network = testnetConfig(deployment);

// Static preamble: the operator secret must derive the deployed operator public — the #1 `just serve` gotcha, and
// cheap to catch here (local, no network) before wasting a live run.
const operatorSecret = requireEnv('TROIA_OPERATOR_SECRET');
const derivedOperator = new LocalKeySigner(operatorSecret).publicKey();
const keyOk = derivedOperator === network.operatorPublic;

const iyzicoSecretKey = requireEnv('IYZICO_SECRET_KEY');
const probes = buildPreflightProbes({
  network,
  iyzico: {
    apiKey: requireEnv('IYZICO_API_KEY'),
    secretKey: iyzicoSecretKey,
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET?.trim() || iyzicoSecretKey,
  },
  // The same settlement-rate policy `just serve` uses (0.5% band, genuine 3-source majority).
  spotOracle: new LiveCexOracle({
    policy: { maxAgeMs: 60_000, deviationThresholdBps: 50, minQuorum: 3 },
  }),
  history: new YahooUsdTryHistory(),
});

const report = await runPreflight(probes);

// Prepend the static key-match check so the report is one coherent list.
const checks = [
  {
    name: 'operator key matches deployment',
    ok: keyOk,
    detail: keyOk
      ? derivedOperator
      : `env derives ${derivedOperator} != deployment ${network.operatorPublic}`,
  },
  ...report.checks,
];
const ok = keyOk && report.ok;

console.log(`\n  Troia preflight — ${network.rpcUrl}\n`);
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(32)}  ${c.detail}`);
}
console.log(
  `\n  ${ok ? 'READY — every dependency is up; you can drive a real charge behind the webhook tunnel.' : 'NOT READY — fix the FAIL rows above before the live run.'}\n`,
);
process.exit(ok ? 0 : 1);
