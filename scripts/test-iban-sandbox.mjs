// Explicit live TESTNET smoke: simulated TRY -> anchor USDC credit -> existing pool -> demo merchant.
// No real bank/card/mainnet funds. Requires a running sandbox backend; never starts a server itself.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { deriveIds } from '../packages/core/dist/index.js';
import { TESTNET_HORIZON_URL } from '../packages/config/dist/index.js';
if (process.env.RUN_IBAN_SANDBOX !== '1')
  throw new Error('Set RUN_IBAN_SANDBOX=1 for explicit testnet execution');
const base = process.env.TROIA_TEST_BACKEND ?? 'http://127.0.0.1:3108';
const dep = JSON.parse(readFileSync('deployment.testnet.json', 'utf8'));
const merchant = readFileSync('app/storefront/src/config.ts', 'utf8').match(
  /merchant: '([^']+)'/,
)[1];
if (process.env.TROIA_WALLET_LEDGER) {
  const text = readFileSync(process.env.TROIA_WALLET_LEDGER, 'utf8');
  if (!text.includes(merchant))
    appendFileSync(
      process.env.TROIA_WALLET_LEDGER,
      `\n- Troia demo store merchant / IBAN integration; TEST recipient, not prize wallet; Stellar Testnet; ${merchant}; verified ${new Date().toISOString()}; public address from storefront configuration.\n`,
    );
}
const account = await (await fetch(`${TESTNET_HORIZON_URL}/accounts/${merchant}`)).json();
if (!account.balances?.some((b) => b.asset_code === 'USDC' && b.asset_issuer === dep.usdcIssuer))
  throw new Error('Demo merchant lacks required USDC trustline');
const balance = (x) =>
  x.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === dep.usdcIssuer).balance;
const amountStroops = '1000000';
const orderId = process.argv[2] ?? `iban-e2e-${Date.now()}`;
const session = await (await fetch(`${base}/session`, { method: 'POST' })).json();
const headers = { 'Content-Type': 'application/json', 'x-troia-session': session.token };
const request = {
  orderId,
  destination: merchant,
  amountStroops,
  assetIssuer: dep.usdcIssuer,
  memoHex: deriveIds(orderId, merchant, BigInt(amountStroops)).memoHex,
  paymentMethod: 'bank_transfer',
  ip: '127.0.0.1',
};
const response = await fetch(`${base}/intent`, {
  method: 'POST',
  headers,
  body: JSON.stringify(request),
});
const intent = await response.json();
if (!response.ok) throw new Error(`Intent ${response.status}: ${JSON.stringify(intent)}`);
if (!intent.bankTransfer || intent.bankTransfer.providerId !== 'tr-mock-anchor')
  throw new Error('No real sandbox instructions');
const { sandboxToken, ...publicInstructions } = intent.bankTransfer;
const proof = {
  network: 'Stellar Testnet',
  time: new Date().toISOString(),
  orderId,
  merchant,
  amountStroops,
  balanceBefore: balance(account),
  instructions: publicInstructions,
  status: 'pending',
};
mkdirSync('output/iban-sandbox', { recursive: true });
const save = () =>
  writeFileSync(`output/iban-sandbox/${orderId}.json`, JSON.stringify(proof, null, 2));
save();
console.log('Instructions:', JSON.stringify(publicInstructions));
const replay = await (
  await fetch(`${base}/intent`, { method: 'POST', headers, body: JSON.stringify(request) })
).json();
if (replay.token !== intent.token) throw new Error('Retry created another transfer');
const sim = await fetch(`${base}/sandbox/bank-transfer/${encodeURIComponent(orderId)}/simulate`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ sandboxToken }),
});
if (sim.status !== 202) throw new Error(`Simulation ${sim.status}: ${await sim.text()}`);
console.log('Bank simulated; waiting for independently verified settlement');
for (let i = 0; i < 50; i++) {
  const state = await (await fetch(`${base}/status/${encodeURIComponent(orderId)}`)).json();
  if (proof.status !== state.status) console.log('Status:', state.status);
  proof.status = state.status;
  save();
  if (state.status === 'completed') {
    const receipt = await (await fetch(`${base}/receipt/${encodeURIComponent(orderId)}`)).json();
    const after = await (await fetch(`${TESTNET_HORIZON_URL}/accounts/${merchant}`)).json();
    proof.receipt = receipt;
    proof.balanceAfter = balance(after);
    save();
    const toUnits = (s) => BigInt(s.replace('.', ''));
    if (toUnits(proof.balanceAfter) - toUnits(proof.balanceBefore) !== BigInt(amountStroops))
      throw new Error('Merchant balance mismatch');
    console.log('PASS: merchant received 0.1 test USDC; transaction:', receipt.txHash);
    process.exit(0);
  }
  if (['failed', 'review'].includes(state.status))
    throw new Error(`Order requires attention: ${state.status}`);
  await new Promise((r) => setTimeout(r, 2500));
}
throw new Error('Still pending; inspect existing order, do not create another payment');
