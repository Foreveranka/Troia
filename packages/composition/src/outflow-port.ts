// Bind the SDK-backed event tail to this deployment's SAC and pool. Like buildStellarPort, this constructs a real
// RPC client, so it is type-checked and live-smoked rather than exercised by the offline suite; the pure worker it
// feeds (tailOutflows / judgeOutflows) is unit-tested.
//
// It uses its own SorobanRpcAdapter rather than sharing the payout one. That is deliberate: the tail is a
// read-only observer on a slow interval, and a stall in it must never contend with, or time out alongside, the
// requests that move money.

import type { NetworkConfig } from '@troia/config';
import { SorobanRpcAdapter } from '@troia/stellar-client/adapters';
import type { PoolActivityPage, PoolFetch, TxLiveness } from '@troia/stellar-client';
import type { BuildStellarPortOptions } from './build-stellar-port.js';

export interface OutflowTail {
  fetchPoolActivity(req: PoolFetch): Promise<PoolActivityPage>;
  latestLedger(): Promise<number>;
  /** Is that transaction still on chain? The reconciler asks before believing its own durable cache. */
  checkTxLiveness(txHash: string): Promise<TxLiveness>;
}

/** Watch the USDC token contract for transfers OUT of this pool — every one of them, whoever moved them. */
export function buildOutflowTail(
  network: NetworkConfig,
  opts?: BuildStellarPortOptions,
): OutflowTail {
  const rpc = new SorobanRpcAdapter(network.rpcUrl, network.passphrase, opts);
  const sac = network.usdc.sacContractId;
  const pool = network.contracts.troyPool;
  return {
    fetchPoolActivity: (req) => rpc.fetchPoolActivity(sac, pool, req),
    latestLedger: async () => (await rpc.latestLedger()).sequence,
    checkTxLiveness: (txHash) => rpc.checkTxLiveness(txHash),
  };
}
