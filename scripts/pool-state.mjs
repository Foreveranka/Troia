// Decide, with proof, whether the recorded TroyPool is on chain. Prints exactly one word: live | absent | unknown.
//
// This exists because the two facts a deploy script must never confuse are "the pool is gone" and "I cannot see
// the pool". `just bootstrap` used to treat any failed liveness call as the former, so a momentary RPC outage
// would have let it deploy a SECOND pool — orphaning the one every document, explorer link and recon report names,
// along with its balance. A second pool must never be deployed. This is the gate.
//
// Two structural checks, in order:
//   1. `stellar network health --output json` must PARSE and say status:"healthy". Its exit code is useless — it
//      exits 0 while printing "❌ Unhealthy" — so the exit code is never consulted. A network we cannot see is
//      `unknown`, and nothing is concluded from it.
//   2. Only then, a keyless simulation of the pool's own `balance` view. It answers -> live. It does not -> the
//      contract genuinely is not there (a testnet reset) -> absent.
//
// A missing `stellar` CLI, a timeout, a rate limit, a garbled response: all `unknown`. Fail closed, always.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = process.argv[2] ?? 'testnet';
/** Same env var the server honours, so a test can point this at a corrupt or missing record. */
const RECORD = process.env.TROIA_DEPLOYMENT_PATH ?? join(ROOT, 'deployment.testnet.json');

/** Honour the CLI's own env overrides so the `unknown` branch is reachable in a test. */
const networkArgs = process.env.STELLAR_RPC_URL ? [] : ['--network', NETWORK];

function run(args) {
  return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function say(state) {
  process.stdout.write(`${state}\n`);
  process.exit(0);
}

let dep;
try {
  dep = JSON.parse(readFileSync(RECORD, 'utf8'));
  if (typeof dep.troyPool !== 'string' || typeof dep.operatorPublic !== 'string') say('unknown');
} catch {
  // A missing or corrupt record proves nothing about the pool it was supposed to name. Never `absent`.
  say('unknown');
}

// 1) Can we see the network at all? Parse the answer; never trust the exit code.
try {
  const health = JSON.parse(run(['network', 'health', ...networkArgs, '--output', 'json']));
  if (health.status !== 'healthy') say('unknown');
} catch {
  say('unknown');
}

// 2) The network answers. Now the pool's absence is a fact rather than a guess.
try {
  run([
    'contract',
    'invoke',
    '--id',
    dep.troyPool,
    '--source-account',
    dep.operatorPublic,
    ...networkArgs,
    '--send=no',
    '--',
    'balance',
  ]);
  say('live');
} catch {
  say('absent');
}
