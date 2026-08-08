// scripts/add-channels.mjs — the A-5 channel ceremony: create + fund N channel accounts on testnet and print
// the TROIA_CHANNEL_SECRETS line for .env. Channels are fee-payers ONLY: they hold friendbot XLM for
// transaction fees, never USDC and never any contract authority — a leaked channel key can burn fees, not
// move the pool. Usage: node scripts/add-channels.mjs [count]   (default 5)
//
// Requires the `stellar` CLI (same dependency as `just fund`). Keys are stored under the CLI's keystore as
// troia-channel-<n> and ALSO printed as secrets — put them in .env and restart `just serve`.

import { execSync } from 'node:child_process';

const NET = 'testnet';
const count = Number(process.argv[2] ?? '5');
if (!Number.isInteger(count) || count < 1 || count > 20) {
  console.error('usage: node scripts/add-channels.mjs [count 1..20]');
  process.exit(1);
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const secrets = [];
for (let i = 1; i <= count; i++) {
  const name = `troia-channel-${i}`;
  try {
    sh(`stellar keys address ${name} 2>/dev/null`);
    console.log(`${name}: already exists — reusing`);
  } catch {
    sh(`stellar keys generate ${name} --network ${NET} --fund`);
    console.log(`${name}: created + funded (friendbot)`);
  }
  secrets.push(sh(`stellar keys show ${name}`));
}

console.log('\nAdd this line to .env and restart `just serve`:\n');
console.log(`TROIA_CHANNEL_SECRETS=${secrets.join(',')}`);
