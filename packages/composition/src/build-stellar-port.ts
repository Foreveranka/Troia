// buildStellarPort — the real factory: construct the live SDK-backed adapters (SorobanRpcAdapter / HorizonAdapter
// / LocalKeySigner) + an in-memory journal + a system clock from the secret-free NetworkConfig plus the operator
// secret (env-sourced, NEVER from NetworkConfig), build a StellarClient, and wrap it into the backend StellarPort.
// This constructs SDK Servers, so — like the adapters it builds — it is type-checked here and LIVE-SMOKED, not
// exercised by the offline suite; the money-critical wiring it composes (wrapStellarPort) IS unit-tested.

import type { StellarPort } from '@troia/backend';
import type { NetworkConfig } from '@troia/config';
import { createStellarClient, InMemoryJournal, SystemClock } from '@troia/stellar-client';
import { HorizonAdapter, LocalKeySigner, SorobanRpcAdapter } from '@troia/stellar-client/adapters';
import { wrapStellarPort } from './stellar-port.js';

export interface BuildStellarPortOptions {
  /** allow a plain-http RPC/Horizon (testnet + mainnet are https; only a local dev node needs this). */
  readonly allowHttp?: boolean;
}

/** Build the backend StellarPort from the network config + the operator secret. The journal instance is SHARED
 *  between the client (which writes each pay() envelope before send) and readRevertErrorCode (which reads back the
 *  order's tx hash), so a reverted pay() can be classified. */
export function buildStellarPort(
  network: NetworkConfig,
  operatorSecret: string,
  opts?: BuildStellarPortOptions,
): StellarPort {
  const rpc = new SorobanRpcAdapter(network.rpcUrl, network.passphrase, opts);
  const horizon = new HorizonAdapter(network.horizonUrl, opts);
  const signer = new LocalKeySigner(operatorSecret);
  const journal = new InMemoryJournal(); // SHARED: the client writes it, readRevertErrorCode reads it
  const client = createStellarClient({ rpc, horizon, signer, journal, clock: new SystemClock() });
  return wrapStellarPort(client, rpc, journal, {
    sacContractId: network.usdc.sacContractId,
    troyPool: network.contracts.troyPool,
    operatorPublic: signer.publicKey(),
  });
}
