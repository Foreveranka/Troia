// scripts/intent.mjs — drive ONE real charge through a RUNNING backend (the Phase-4.5 live-smoke driver, standing
// in for the storefront until 5.1). It ensures a demo merchant with a USDC trustline, derives the order's memo from
// (orderId, merchant, amount) EXACTLY as the backend does, POSTs /intent to the local server, and saves the returned
// iyzico hosted-form HTML to demo/checkout.html to open in a browser and pay with a Troy sandbox test card. The
// backend prices the order server-side (a client cannot dictate the price/currency). Requires `just serve` running
// in another terminal + `just fund` already done. Usage: node scripts/intent.mjs [orderId] [usdcAmount]
// Defaults: a ledger-nonce order id (no replay-guard collision on re-run) and 1 USDC.

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deriveIds } from '../packages/core/dist/index.js';

const NET = 'testnet';
const HORIZON = 'https://horizon-testnet.stellar.org';
const PORT = process.env.PORT ?? '3000';
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' });

const dep = JSON.parse(readFileSync(process.env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json', 'utf8'));
const ISSUER = dep.usdcIssuer;

function ensureMerchant() {
  try {
    sh('stellar keys address troia-demo-merchant 2>/dev/null');
  } catch {
    sh(`stellar keys generate troia-demo-merchant --network ${NET} --fund`);
    sh(`stellar tx new change-trust --source-account troia-demo-merchant --line USDC:${ISSUER} --network ${NET}`);
  }
  return sh('stellar keys address troia-demo-merchant').trim();
}

async function ledgerNonce() {
  const r = await fetch(`${HORIZON}/ledgers?order=desc&limit=1`);
  const j = await r.json();
  return String(j._embedded.records[0].sequence);
}

const merchant = ensureMerchant();
const orderId = process.argv[2] ?? `troia-live-${await ledgerNonce()}`;
const usdc = Number(process.argv[3] ?? '1');
const amountStroops = String(Math.round(usdc * 10_000_000));
const d = deriveIds(orderId, merchant, BigInt(amountStroops));

console.log(`intent: order ${orderId} | ${usdc} USDC | merchant ${merchant}`);
const res = await fetch(`http://localhost:${PORT}/intent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    orderId,
    destination: merchant,
    amountStroops,
    assetIssuer: ISSUER,
    memoHex: d.memoHex,
    ip: '85.34.78.112',
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`  /intent -> ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`  priced ${body.paidPriceTry} kurus (spread ${body.spreadBps} bps)${body.poolLow ? ' [POOL LOW]' : ''}`);
console.log(`  token ${body.token}`);
if (body.checkoutFormContent) {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>Troia checkout ${orderId}</title></head>` +
    `<body><div id="iyzipay-checkout-form" class="responsive"></div>${body.checkoutFormContent}</body></html>`;
  mkdirSync('demo', { recursive: true });
  writeFileSync('demo/checkout.html', html);
  console.log('  wrote demo/checkout.html — open it in a browser and pay with a Troy sandbox test card');
}
console.log(`  watch: curl -s http://localhost:${PORT}/status/${encodeURIComponent(orderId)}`);
process.exit(0);
