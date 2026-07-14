// scripts/stage-revert.mjs — stage a LANDED-and-REVERTED pay() on testnet, so scripts/probe-revert.mjs has a real
// reverted transaction to read a contract error code from. Prints the tx hash of the reverted invocation.
//
// WHY THIS IS NOT "just double-pay". A deterministically-reverting pay() cannot pass simulation, so the CLI never
// submits it and no reverted tx is ever created — the AlreadyProcessed recipe some older notes describe simply
// does not land. The ONLY way to get a reverted pay() ON CHAIN is to change state BETWEEN simulation and
// inclusion. pause() is the one lever we control, and pay() checks it FIRST — before the Processed write and
// before the transfer:
//
//     read_operator().require_auth();
//     if read_paused() { return Err(Paused) }      // <-- we land here
//     ... Processed guard ... balance ... set(Processed) ... transfer ...   // <-- never reached
//
// So a paused revert moves NO USDC, marks NO tx_id (the Err rolls the whole invocation back), emits NO transfer
// event (the payout tail sees nothing), and leaves the books untouched. It costs one operator sequence + fees.
//
// SAFETY, structural and fail-closed:
//   - REFUSES if the backend is up (:PORT bound): pausing under a live payout would revert a real customer's tx.
//   - REFUSES if the pool is already paused (someone else's state — we do not touch it).
//   - unpause is GUARANTEED by a guard that runs on every exit path (success, throw, SIGINT, SIGTERM).
//   - the pay() is SENT ONLY AFTER is_paused re-reads as true. If the pause did not land, we abort rather than
//     let a real (unauthorized) payout through.
//   - a POST-run check asserts the balance is byte-identical and the pool is unpaused again.
//
// Requires `.env` (TROIA_ADMIN_SECRET + TROIA_OPERATOR_SECRET) and deployment.testnet.json. Run with:
//   node --env-file=.env scripts/stage-revert.mjs
// then feed the printed hash to:  node scripts/probe-revert.mjs <hash>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';

const NET = 'testnet';
const PORT = process.env.PORT ?? '3000';
const dep = JSON.parse(
  readFileSync(process.env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json', 'utf8'),
);
const POOL = dep.troyPool;
const OP_PUB = dep.operatorPublic;
const ADMIN = requireSecret('TROIA_ADMIN_SECRET');
const OPERATOR = requireSecret('TROIA_OPERATOR_SECRET');

// A fixed demo merchant + a benign amount. The tx_id is fresh (so the revert is unambiguously the Paused guard,
// never AlreadyProcessed), yet deterministic per UTC day so a re-run on the same day reuses one intent.
const MERCHANT = 'GDF7V2G5FB5UF4AT7ZQ2A4L3YFG44UVJW3APSZWDN3FCI3HJCCMMGOXN';
const MEMO = '6115721c3f246433a851a959ba9b0bc8c3de9bc486f5da2cdd0f022bad30c5a9';
const APPLIED_RATE = '411075000';
const TX_ID = createHash('sha256')
  .update(`troia-stage-revert:${new Date().toISOString().slice(0, 10)}`)
  .digest('hex');

function requireSecret(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim().length === 0)
    fail(`missing ${name} — run with: node --env-file=.env scripts/stage-revert.mjs`);
  return v;
}
function fail(msg) {
  console.error(`stage-revert: ${msg}`);
  process.exit(1);
}
/** Run stellar. `secret` (if given) travels in the child env, never on the command line. `input` feeds stdin. */
function run(args, { secret, input, secretVar = 'STELLAR_ACCOUNT' } = {}) {
  return execFileSync('stellar', args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: secret ? { ...process.env, [secretVar]: secret } : process.env,
  }).toString();
}
/** A keyless contract view: the trimmed last line stellar prints. */
function view(fn, ...rest) {
  const out = run([
    'contract',
    'invoke',
    '--id',
    POOL,
    '--source-account',
    OP_PUB,
    '--network',
    NET,
    '--send=no',
    '--',
    fn,
    ...rest,
  ]);
  return out.trim().split('\n').pop().trim();
}
function adminCall(fn) {
  run(['contract', 'invoke', '--id', POOL, '--network', NET, '--', fn], { secret: ADMIN });
}
function backendIsUp() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: Number(PORT) }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

if (await backendIsUp())
  fail(
    `the backend is answering on :${PORT}. Pausing now could revert a live payout. Stop it first.`,
  );

const balBefore = view('balance');
if (view('is_paused') !== 'false') fail('the pool is already paused — not touching it.');
console.log(`── before ──  balance ${balBefore}  is_paused false`);

// 1) build → simulate (attach footprint) → sign, all offline of the pool's state; compute the hash before sending
const scratch = mkdtempSync(join(tmpdir(), 'troia-stage-revert-'));
const built = run([
  'contract',
  'invoke',
  '--id',
  POOL,
  '--source-account',
  OP_PUB,
  '--network',
  NET,
  '--build-only',
  '--',
  'pay',
  '--tx_id',
  TX_ID,
  '--amount',
  '1',
  '--applied_rate',
  APPLIED_RATE,
  '--merchant',
  MERCHANT,
  '--memo',
  MEMO,
]);
const assembled = run(['tx', 'simulate', '--source-account', OP_PUB, '--network', NET], {
  input: built,
});
const signed = run(['tx', 'sign', '--network', NET], {
  input: assembled,
  secret: OPERATOR,
  secretVar: 'STELLAR_SIGN_WITH_KEY',
});
writeFileSync(join(scratch, 'pay-signed.xdr'), signed);
const txHash = run(['tx', 'hash', '--network', NET], { input: signed }).trim();
console.log(`── signed (not sent) ──  tx hash ${txHash}`);

// 2) guaranteed unpause on EVERY exit path — armed BEFORE we pause
let unpaused = false;
function unpause() {
  if (unpaused) return;
  try {
    adminCall('unpause');
    unpaused = true;
  } catch (e) {
    console.error(
      `!!! UNPAUSE FAILED — run manually: stellar contract invoke --id ${POOL} -- unpause`,
    );
    console.error(String(e).split('\n')[0]);
  }
}
process.on('exit', () => {
  unpause();
  const balAfter = view('balance');
  const pausedAfter = view('is_paused');
  const ok = balAfter === balBefore && pausedAfter === 'false';
  console.log(
    `── after ──  balance ${balAfter}  is_paused ${pausedAfter}  ${ok ? 'OK' : '!!! INVARIANT DRIFT'}`,
  );
  console.log(`\ntx ${txHash}\nnext: node scripts/probe-revert.mjs ${txHash}`);
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// 3) pause → VERIFY → send. The verify is the safety gate: never send unless the pool is provably paused.
console.log('── pause ──');
adminCall('pause');
if (view('is_paused') !== 'true')
  fail('pause did not land — refusing to send the pay() (it would SUCCEED)');
console.log('   is_paused true');

console.log('── send (must land and REVERT) ──');
let sendExit = 0;
try {
  run(['tx', 'send', '--network', NET], { input: signed });
} catch {
  sendExit = 1; // a reverted tx makes `stellar tx send` exit non-zero — EXPECTED
}
console.log(`   send exit ${sendExit} (non-zero is expected — the tx reverted)`);
// the exit hook now runs: unpause + post-invariant check + the "next" hint
