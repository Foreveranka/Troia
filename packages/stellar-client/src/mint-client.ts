// The SAC-mint CONDUCTOR (the real testnet MintPort). It owns ORDERING only: read issuer seq -> build ->
// simulate -> assemble -> sign(ISSUER) -> send -> poll to finality -> read the pool balance. It holds no
// money-branching. Like buildStellarPort it is SDK-adjacent (RpcPort/Signer are concrete at the composition
// root) and LIVE-SMOKED, not offline-run. The signer here is the ISSUER key (SAC admin) — SEPARATE from the
// operator payout key, so a mint never consumes an operator payout sequence. No durable write-ahead journal:
// the settlement worker's per-order claim + deterministic `topup:<orderId>` ref is the idempotency shield for
// the PoC (a durable mint journal is the same Phase-2 boundary as the durable payout sequence store).

import { assembleFromSimulation, hashOf } from './assemble.js';
import { buildSacMintTransaction } from './sac-mint.js';
import type { RpcPort, Signer } from './ports.js';
import { SubmitError } from './errors.js';

export interface SacMintClientPorts {
  readonly rpc: RpcPort;
  /** the ISSUER key (SAC admin). MUST be separate from the operator payout key. */
  readonly signer: Signer;
  /** unix seconds now — for the injected timebounds (never Date.now inside the pure builder). */
  readonly nowUnix: () => number;
}

export interface SacMintClientConfig {
  readonly sacContractId: string;
  /** the pool contract C-address (mint destination). */
  readonly pool: string;
  readonly passphrase: string;
  readonly feeStroops: string;
  readonly timeboundsSecs: number;
  /** finality poll cadence + budget (bounded so a wedged RPC cannot stall the rebalance loop forever). */
  readonly finalityPollMs: number;
  readonly finalityMaxAttempts: number;
  /** read the pool's live USDC balance after the mint lands (reuses the StellarPort SAC read). */
  readonly readPoolBalanceStroops: () => Promise<bigint>;
}

/** The rebalance MintPort: mint `usdcStroops` USDC to the pool and return the tx hash + the post-mint balance. */
export interface SacMintPort {
  mintToPool(usdcStroops: bigint): Promise<{ txHash: string; poolStroops: bigint }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createSacMintClient(ports: SacMintClientPorts, cfg: SacMintClientConfig): SacMintPort {
  const issuerPublic = ports.signer.publicKey();

  return {
    async mintToPool(usdcStroops) {
      const seqRead = await ports.rpc.readAccountSeq(issuerPublic);
      if (!seqRead.exists) {
        throw new SubmitError(`issuer account ${issuerPublic} not found on-chain — fund it before minting`);
      }
      const now = ports.nowUnix();
      const unprepared = buildSacMintTransaction({
        issuerPublic,
        seq: seqRead.seq,
        // NO lower time bound (matches the pay path, perform.ts): minTime = now risks txTooEarly when the node
        // wall-clock is a few seconds ahead of the network's latest ledger close time. Only maxTime (expiry) matters.
        minTime: 0,
        maxTime: now + cfg.timeboundsSecs,
        fee: cfg.feeStroops,
        passphrase: cfg.passphrase,
        sacContractId: cfg.sacContractId,
        to: cfg.pool,
        amount: usdcStroops,
      });
      const sim = await ports.rpc.simulate(unprepared);
      const submittable = assembleFromSimulation(unprepared, sim);
      const txHash = hashOf(submittable);
      const signedXdr = ports.signer.sign(submittable);

      const outcome = await ports.rpc.send(signedXdr);
      // Fail-closed on any non-accepted send. PENDING/DUPLICATE both give an on-chain hash to poll; a repeat of
      // the SAME mint (same seq) is DUPLICATE, which is safe to poll to the same result.
      if (outcome.kind === 'ERROR') throw new SubmitError(`SAC mint send failed: ${outcome.code}`);
      if (outcome.kind === 'BAD_SEQ') throw new SubmitError('SAC mint send returned BAD_SEQ');
      if (outcome.kind === 'TRY_AGAIN') throw new SubmitError('SAC mint send returned TRY_AGAIN (retry next tick)');

      for (let attempt = 0; attempt < cfg.finalityMaxAttempts; attempt += 1) {
        const g = await ports.rpc.getTransaction(txHash);
        if (g.kind === 'SUCCESS') {
          const poolStroops = await cfg.readPoolBalanceStroops();
          return { txHash, poolStroops };
        }
        if (g.kind === 'FAILED') throw new SubmitError('SAC mint tx FAILED on-chain');
        await sleep(cfg.finalityPollMs); // NOT_FOUND -> not yet in a closed ledger; wait and re-poll
      }
      throw new SubmitError('SAC mint did not reach finality within the attempt budget');
    },
  };
}
