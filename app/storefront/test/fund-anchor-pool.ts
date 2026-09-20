// Explicit testnet operator setup. Signing keys never leave the local CLI key store.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { AnchorClient } from '../../extension/src/anchor/client';
import { ANCHOR } from '../src/anchor/config';
if (process.env.TROIA_SETUP_TESTNET !== '1')
  throw new Error('Explicit testnet setup opt-in required');
const dep = JSON.parse(readFileSync('../../deployment.anchor-testnet.json', 'utf8'));
if (dep.usdcIssuer !== ANCHOR.issuer) throw new Error('Issuer mismatch');
const key = Keypair.fromSecret(
  execFileSync('stellar', ['keys', 'secret', 'troia-admin'], { encoding: 'utf8' }).trim(),
);
if (key.publicKey() !== dep.adminPublic) throw new Error('Admin mismatch');
const client = new AnchorClient(key.publicKey(), async (xdr) => {
  const tx = TransactionBuilder.fromXDR(xdr, ANCHOR.passphrase);
  tx.sign(key);
  return tx.toXDR();
});
await client.connect();
await client.prepareWallet();
const evidence = '../../docs/deployments/anchor-seed.json';
let state = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) : null;
if (!state) {
  const q = await client.quote('deposit', '2000.00');
  const d = await client.start('deposit', q);
  state = {
    pool: dep.troyPool,
    account: key.publicKey(),
    amount: q.buy_amount,
    tryAmount: q.sell_amount,
    id: d.id,
  };
  writeFileSync(evidence, JSON.stringify(state, null, 2) + '\n');
  await client.simulate(d.id, q.sell_amount);
}
if (state.pool !== dep.troyPool) throw new Error('Saved seed belongs to a different pool');
for (let i = 0; i < 20; i++) {
  const t = await client.transaction(state.id);
  if (i === 0) console.log(JSON.stringify(t));
  if (t.status === 'completed') {
    state.depositTx = t.stellar_transaction_id;
    writeFileSync(evidence, JSON.stringify(state, null, 2) + '\n');
    console.log(JSON.stringify(state));
    process.exit(0);
  }
  if (['error', 'expired', 'refunded'].includes(t.status)) throw new Error(`Deposit ${t.status}`);
  await new Promise((r) => setTimeout(r, 2000));
}
throw new Error('Pending deposit; inspect saved ID before retrying');
