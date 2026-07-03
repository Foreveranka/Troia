// DIRTY concrete RpcPort over @stellar/stellar-sdk's rpc.Server. network:true, keyless. This is the ONLY
// place Soroban-RPC SDK types live; every method maps a raw SDK response into a normalized outcome ADT so
// the pure core never sees an SDK type. Not exercised by the offline suite (it needs a live RPC); it is
// type-checked by tsc and live-smoked once contracts are deployed (Phase 4.4+).

import { Keypair, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type {
  AccountSeqRead,
  GetTxOutcome,
  LedgerHead,
  SendOutcome,
  SimResult,
} from './outcomes.js';
import type { RpcPort, UnpreparedTx } from './ports.js';
import { SimulationError, SubmitError } from './errors.js';

export class SorobanRpcAdapter implements RpcPort {
  private readonly server: rpc.Server;

  constructor(
    rpcUrl: string,
    private readonly passphrase: string,
    opts?: { allowHttp?: boolean },
  ) {
    this.server = new rpc.Server(rpcUrl, opts?.allowHttp === true ? { allowHttp: true } : undefined);
  }

  async simulate(unprepared: UnpreparedTx): Promise<SimResult> {
    const sim = await this.server.simulateTransaction(unprepared);
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(sim.error);
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new SimulationError('footprint touches archived entries — RestoreFootprint required first');
    }
    if (sim.transactionData === undefined) {
      throw new SimulationError('simulation returned no transactionData (footprint)');
    }
    const auth = sim.result?.auth ?? [];
    return {
      sorobanDataXdr: sim.transactionData.build().toXDR('base64'),
      minResourceFee: sim.minResourceFee,
      authXdr: auth.map((a) => a.toXDR('base64')),
    };
  }

  async send(signedXdrBase64: string): Promise<SendOutcome> {
    const tx = TransactionBuilder.fromXDR(signedXdrBase64, this.passphrase);
    const res = await this.server.sendTransaction(tx);
    switch (res.status) {
      case 'PENDING':
        return { kind: 'PENDING', hashHex: res.hash };
      case 'DUPLICATE':
        return { kind: 'DUPLICATE', hashHex: res.hash };
      case 'TRY_AGAIN_LATER':
        return { kind: 'TRY_AGAIN' };
      case 'ERROR':
        return isBadSeq(res.errorResult)
          ? { kind: 'BAD_SEQ' }
          : { kind: 'ERROR', code: resultCodeName(res.errorResult) };
      default:
        return { kind: 'ERROR', code: `unknown send status ${String(res.status)}` };
    }
  }

  async getTransaction(hashHex: string): Promise<GetTxOutcome> {
    const res = await this.server.getTransaction(hashHex);
    switch (res.status) {
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return { kind: 'SUCCESS', ledger: res.ledger };
      case rpc.Api.GetTransactionStatus.NOT_FOUND:
        return { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: Number(res.latestLedgerCloseTime) };
      case rpc.Api.GetTransactionStatus.FAILED:
        return { kind: 'FAILED', badSeq: isBadSeqResult(res.resultXdr) };
    }
    // GetTransactionStatus is exhausted above; this is unreachable.
    throw new SubmitError('unreachable: unknown getTransaction status');
  }

  async readAccountSeq(operatorPublic: string): Promise<AccountSeqRead> {
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(operatorPublic).xdrAccountId() }),
    );
    const res = await this.server.getLedgerEntries(key);
    const entry = res.entries[0];
    if (entry === undefined) return { exists: false, seq: '0' };
    return { exists: true, seq: entry.val.account().seqNum().toString() };
  }

  async latestLedger(): Promise<LedgerHead> {
    const res = await this.server.getLatestLedger();
    return { sequence: res.sequence, closeTimeUnix: Number(res.closeTime) };
  }
}

function isBadSeq(errorResult: xdr.TransactionResult | undefined): boolean {
  if (errorResult === undefined) return false;
  return errorResult.result().switch().name === 'txBadSeq';
}

function isBadSeqResult(resultXdr: xdr.TransactionResult | undefined): boolean {
  if (resultXdr === undefined) return false;
  return resultXdr.result().switch().name === 'txBadSeq';
}

function resultCodeName(errorResult: xdr.TransactionResult | undefined): string {
  if (errorResult === undefined) return 'unknown';
  return errorResult.result().switch().name;
}
