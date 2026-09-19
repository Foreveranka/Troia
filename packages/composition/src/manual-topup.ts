// Offline operator bookkeeping after a confirmed testnet transfer. Never signs or transfers funds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpc, StrKey, scValToNative } from '@stellar/stellar-sdk';
import { testnetConfig } from '@troia/config';
import { SorobanRpcAdapter } from '@troia/stellar-client/adapters';
import { parseDeployment } from './env.js';
import { buildDurableBundle } from './durable-bundle.js';
import { acquireProcessLock } from './process-lock.js';

async function main() {
  const [hash, cost] = process.argv.slice(2);
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !cost || !/^[1-9][0-9]*$/.test(cost))
    throw new Error(
      'Usage: node manual-topup.js <confirmed transfer hash> <book value in TRY kurus>',
    );
  const path = process.env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json';
  const dep = parseDeployment(JSON.parse(readFileSync(path, 'utf8')), path);
  const net = testnetConfig(dep);
  const dir = join(process.env.TROIA_DATA_DIR?.trim() || 'data', dep.troyPool);
  const release = acquireProcessLock(dir);
  try {
    const { ledger } = buildDurableBundle(dir);
    const ref = `manual:${hash}`;
    if (ledger.hasRef(ref)) {
      console.log('Already booked; no changes.');
      return;
    }
    if (!ledger.all().length)
      throw new Error(
        'Start the backend once to book the initial balance before recording later top-ups.',
      );
    const result = await new rpc.Server(net.rpcUrl).getTransaction(hash);
    if (result.status !== 'SUCCESS')
      throw new Error('Transaction not confirmed or outside RPC retention; no changes.');
    let amount = 0n;
    for (const e of result.events.contractEventsXdr.flat()) {
      const contract = e.contractId;
      if (!contract || StrKey.encodeContract(contract.value) !== dep.usdcSacContractId) continue;
      const v = e.body.v0;
      const topics = v.topics.map(scValToNative);
      if (topics[0] !== 'transfer') continue;
      // Only administrator-funded inbound transfers are accepted by this operator tool.
      if (topics[1] !== dep.adminPublic || topics[2] !== dep.troyPool) continue;
      const value: unknown = scValToNative(v.data);
      if (typeof value !== 'bigint' || value <= 0n)
        throw new Error('Unsupported transfer event format');
      amount += value;
    }
    if (amount <= 0n) throw new Error('No matching admin → pool USDC transfer in this transaction');
    const balance = await new SorobanRpcAdapter(net.rpcUrl, net.passphrase).readSacBalance(
      dep.usdcSacContractId,
      dep.troyPool,
      dep.operatorPublic,
    );
    if (balance !== ledger.nativeBalance('USDC_POOL') + amount)
      throw new Error(
        'Unreconciled balance: finish settlement bookkeeping and reconcile all movements first.',
      );
    ledger.recordTopUp({ ref, usdcStroops: amount, valueKurus: BigInt(cost) });
    console.log(`Recorded ${amount} stroops from confirmed transfer ${hash}. Restart the backend.`);
  } finally {
    release();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Top-up failed');
  process.exitCode = 1;
});
