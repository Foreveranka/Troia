// scripts/probe-revert.mjs <txHash> — LIVE CHECK for the revert-read path. Given the tx hash of a
// LANDED-and-REVERTED pay(), it reports whether the node populated diagnostic events on the FAILED tx and what OUR
// contract-scoped parser (readContractErrorCode) reads — the one shape only a live reverted tx can confirm.
// Money-safety note: a null classification is SAFE (re-drive; the on-chain Processed(tx_id) guard is the real
// double-pay shield), so this is a LIVENESS/observability check, not a money-path assertion. Requires
// deployment.testnet.json. Usage:
//   node scripts/probe-revert.mjs <txHash>
// To PRODUCE a reverted tx: run `node --env-file=.env scripts/stage-revert.mjs`, which prints a hash to pass here.
// (Note: a double-pay does NOT work — a deterministically-reverting pay() fails simulation and is never submitted,
// so no reverted tx is created. stage-revert lands one by pausing the pool between simulation and inclusion.)

import { readFileSync } from 'node:fs';
import { testnetConfig } from '../packages/config/dist/index.js';
import { SorobanRpcAdapter } from '../packages/stellar-client/dist/adapters.js';

const hash = process.argv[2];
if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
  console.error('usage: node scripts/probe-revert.mjs <txHash (64 hex)>');
  process.exit(1);
}

const dep = JSON.parse(
  readFileSync(process.env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json', 'utf8'),
);
const network = testnetConfig(dep);
const rpc = new SorobanRpcAdapter(network.rpcUrl, network.passphrase);

const NAMED = {
  1: 'AlreadyProcessed',
  2: 'InsufficientBalance',
  3: 'Paused',
  4: 'NotAuthorized',
  5: 'InvalidAmount',
};
const r = await rpc.describeRevert(hash, network.contracts.troyPool);

console.log(`\n  tx ${hash}`);
console.log(`  status                 ${r.status}`);
console.log(`  diagnostic events      ${r.topDiagnosticEvents}`);
console.log(
  `  event contractIds      ${r.eventContractIds.length ? r.eventContractIds.join(', ') : '(none)'}`,
);
console.log(`  TroyPool               ${network.contracts.troyPool}`);
const c = r.classifiedCode;
console.log(
  `  readContractErrorCode  ${c === null ? 'null' : `${c} (${NAMED[c] ?? 'unknown'})`}\n`,
);

if (c !== null) {
  console.log(
    `  OK — the contract-scoped revert-read works end-to-end on a live reverted tx (read code ${c} = ${NAMED[c] ?? 'unknown'}).\n`,
  );
} else if (r.status === 'FAILED' && r.topDiagnosticEvents > 0) {
  console.log(
    '  NOTE — FAILED with diagnostics but no TroyPool-scoped code. Check whether the revert code sits on a',
  );
  console.log(
    '         different contractId (SAC vs TroyPool) or nested in the soroban meta. Re-drive is money-safe.\n',
  );
} else if (r.status !== 'FAILED') {
  console.log(
    `  NOTE — this tx is ${r.status}, not a reverted pay(). Pass the hash of a REVERTED invocation.\n`,
  );
}
process.exit(0);
