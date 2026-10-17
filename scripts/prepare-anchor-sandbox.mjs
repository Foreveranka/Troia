/* global AbortSignal */
// Explicit TESTNET preparation. Creates a separate collection account; never reuses the payout operator.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TESTNET_PASSPHRASE,
  TESTNET_HORIZON_URL,
  TR_MOCK_ANCHOR,
} from '../packages/config/dist/index.js';
const require = createRequire(new URL('../packages/composition/package.json', import.meta.url));
const { Keypair, Asset, Horizon, TransactionBuilder, Operation } = require('@stellar/stellar-sdk');
const path = resolve('.env.bank-sandbox');
let key;
if (existsSync(path)) {
  const secret = readFileSync(path, 'utf8').match(
    /^BANK_TRANSFER_ANCHOR_SECRET=(S[A-Z2-7]{55})$/m,
  )?.[1];
  if (!secret) throw new Error('Invalid existing sandbox file; refusing to replace it');
  key = Keypair.fromSecret(secret);
} else {
  key = Keypair.random();
  writeFileSync(
    path,
    `# Stellar TESTNET only; private, never commit\nBANK_TRANSFER_MODE=tr-mock-anchor\nBANK_TRANSFER_ANCHOR_SECRET=${key.secret()}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  if (process.env.TROIA_WALLET_LEDGER)
    appendFileSync(
      process.env.TROIA_WALLET_LEDGER,
      `\n- Troia IBAN / TR Mock Anchor collection account; TEST wallet, not prize/payout wallet; Stellar Testnet (${TESTNET_PASSPHRASE}); ${key.publicKey()}; verified ${new Date().toISOString()}; local key file: ${path}.\n`,
    );
}
chmodSync(path, 0o600);
const horizon = new Horizon.Server(TESTNET_HORIZON_URL);
let account;
try {
  account = await horizon.loadAccount(key.publicKey());
} catch (e) {
  if (e.response?.status !== 404) throw e;
  const response = await fetch(`https://friendbot.stellar.org?addr=${key.publicKey()}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Testnet friendbot unavailable');
  account = await horizon.loadAccount(key.publicKey());
}
if (
  !account.balances.some((b) => b.asset_code === 'USDC' && b.asset_issuer === TR_MOCK_ANCHOR.issuer)
) {
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', TR_MOCK_ANCHOR.issuer) }))
    .setTimeout(120)
    .build();
  tx.sign(key);
  const result = await horizon.submitTransaction(tx);
  console.log('Test USDC trustline:', result.hash);
}
console.log('Sandbox collection account ready:', key.publicKey());
console.log('Private configuration saved:', path);
