// wrapStellarPort — assemble the backend StellarPort from a StellarClient (its 4 core methods) PLUS the two extra
// Soroban reads the port needs (pool balance, reverted pay() error code). PURE WIRING: it imports only TYPES
// (erased at runtime), touches no SDK and no network, so it is fully unit-testable with fakes. buildStellarPort
// supplies the real SorobanRpcAdapter as both the client's RpcPort and the `reads`, over one shared journal.

import type { StellarPort } from '@troia/backend';
import type { StellarClient, WriteAheadJournal } from '@troia/stellar-client';

/** The two extra Soroban reads the backend StellarPort needs beyond a StellarClient. SorobanRpcAdapter satisfies
 *  this structurally (it has both methods); a fake satisfies it in tests. */
export interface SorobanReads {
  readSacBalance(
    sacContractId: string,
    holderAddress: string,
    sourcePublic: string,
  ): Promise<bigint>;
  readContractErrorCode(hashHex: string, contractId: string): Promise<number | null>;
}

/** The deploy addresses the two extra reads bind to. */
export interface StellarPortWiring {
  /** the USDC SAC whose balance() reports the pool's holdings. */
  readonly sacContractId: string;
  /** the pool contract: BOTH the USDC balance holder AND the contract the revert code is scoped to. Passing the
   *  SAC id here instead would let an inner SAC transfer error be mis-read as a TroyPool Error code, so this is
   *  fixed to the pool contract. */
  readonly troyPool: string;
  /** a valid G-address used only to SOURCE the read-only balance simulation (its on-chain seq is irrelevant). */
  readonly operatorPublic: string;
}

/**
 * Compose the StellarPort. submitPay/resendPersisted/observe/loadDestinationSnapshot forward to the client;
 * readPoolBalanceStroops reads the pool's SAC balance; readRevertErrorCode resolves the order's pay() tx hash from
 * the SHARED write-ahead journal and reads its contract Error code SCOPED to the pool contract. A missing witness
 * or any read failure yields null — the money-safe re-drive default (classifyRevertCause(null)='Other').
 */
export function wrapStellarPort(
  client: StellarClient,
  reads: SorobanReads,
  journal: WriteAheadJournal,
  wiring: StellarPortWiring,
): StellarPort {
  return {
    submitPay: (req) => client.submitPay(req),
    resendPersisted: (orderId) => client.resendPersisted(orderId),
    observe: (state) => client.observe(state),
    loadDestinationSnapshot: (destination) => client.loadDestinationSnapshot(destination),
    readPoolBalanceStroops: () =>
      reads.readSacBalance(wiring.sacContractId, wiring.troyPool, wiring.operatorPublic),
    async readRevertErrorCode(orderId) {
      const persisted = await journal.loadPersisted(orderId);
      if (persisted === null) return null; // no pay() witness for this order -> nothing to classify -> safe (Other)
      // SCOPE to the pool contract, NEVER the SAC: an inner SAC transfer error must not be read as a TroyPool code.
      return reads.readContractErrorCode(persisted.hashHex, wiring.troyPool);
    },
  };
}
