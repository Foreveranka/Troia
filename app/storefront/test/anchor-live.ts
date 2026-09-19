// Explicit opt-in smoke. Only a disposable testnet key; never prints or persists its secret.
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { AnchorClient, units } from '../../extension/src/anchor/client';
import { ANCHOR } from '../src/anchor/config';
if (process.env.RUN_ANCHOR_LIVE !== '1')
  throw new Error('Set RUN_ANCHOR_LIVE=1 to use the testnet sandbox.');
const key = Keypair.random();
const account = key.publicKey();
console.log('Test account:', account);
if (process.env.TROIA_WALLET_LEDGER)
  appendFileSync(
    process.env.TROIA_WALLET_LEDGER,
    `\n- ${new Date().toISOString()}: Troia anchor smoke | Stellar TESTNET (${ANCHOR.passphrase}) | ${account} | Disposable test wallet, not prize/payout wallet; secret in memory only.\n`,
  );
const client = new AnchorClient(account, async (xdr) => {
  const tx = TransactionBuilder.fromXDR(xdr, ANCHOR.passphrase);
  tx.sign(key);
  return tx.toXDR();
});
async function wait(id: string) {
  for (let i = 0; i < 36; i++) {
    const t = await client.transaction(id);
    if (t.status === 'completed') return t;
    if (['error', 'expired', 'refunded'].includes(t.status))
      throw new Error(`Transfer ${t.status}: ${t.message}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('Timed out; inspect transfer before retrying.');
}
await client.connect();
await client.prepareWallet();
const dq = await client.quote('deposit', '100.00');
console.log('Deposit quote:', dq.sell_amount, 'TRY ->', dq.buy_amount, 'USDC');
const dep = await client.start('deposit', dq);
console.log('Deposit:', dep.id);
await client.simulate(dep.id, dq.sell_amount);
const deposited = await wait(dep.id);
const afterDeposit = await client.balances();
if (!afterDeposit.trusted || units(afterDeposit.usdc, 7) <= 0n)
  throw new Error('Deposit not reflected on chain');
const wq = await client.quote('withdraw', '1.0000000');
const withdrawal = await client.start('withdraw', wq);
console.log('Withdrawal:', withdrawal.id);
const payment = await client.payWithdrawal(withdrawal, wq.sell_amount);
const withdrawn = await wait(withdrawal.id);
const afterWithdraw = await client.balances();
if (units(afterDeposit.usdc, 7) - units(afterWithdraw.usdc, 7) !== 10000000n)
  throw new Error('Withdrawal balance mismatch');
mkdirSync('test-results', { recursive: true });
appendFileSync(
  'test-results/anchor-live.jsonl',
  JSON.stringify({
    network: 'Stellar testnet',
    time: new Date().toISOString(),
    account,
    deposit: deposited,
    withdrawal: withdrawn,
    withdrawalTx: payment.hash,
    afterDeposit,
    afterWithdraw,
  }) + '\n',
);
console.log(
  JSON.stringify({
    result: 'PASS',
    account,
    depositTx: deposited.stellar_transaction_id,
    withdrawalTx: payment.hash,
    bankStatus: withdrawn.status,
    balance: afterWithdraw.usdc,
  }),
);
