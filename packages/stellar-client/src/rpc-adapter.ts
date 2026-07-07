// DIRTY concrete RpcPort over @stellar/stellar-sdk's rpc.Server. network:true, keyless. This is the ONLY
// place Soroban-RPC SDK types live; every method maps a raw SDK response into a normalized outcome ADT so
// the pure core never sees an SDK type. Not exercised by the offline suite (it needs a live RPC); it is
// type-checked by tsc and live-smoked once contracts are deployed (Phase 4.4+).

import { Account, Address, Contract, Keypair, rpc, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type {
  AccountSeqRead,
  GetTxOutcome,
  LedgerHead,
  SendOutcome,
  SimResult,
} from './outcomes.js';
import type { RpcPort, UnpreparedTx } from './ports.js';
import { SimulationError, SubmitError } from './errors.js';
import { firstContractErrorCodeFromContract, scValI128ToBigInt } from './soroban-reads.js';
import type { DiagnosticScVals } from './soroban-reads.js';

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

  /** Read a holder's SAC balance (stroops) by SIMULATING a read-only `balance(holder)` — no tx is submitted,
   *  so `source` only needs to be a valid G-address (its on-chain seq is irrelevant to a read simulation). The
   *  composition uses this once at bootstrap to seed the Store with the live pool balance. Extra method beyond
   *  RpcPort; network:true, live-smoked. */
  async readSacBalance(sacContractId: string, holderAddress: string, sourcePublic: string): Promise<bigint> {
    const op = new Contract(sacContractId).call('balance', new Address(holderAddress).toScVal());
    const tx = new TransactionBuilder(new Account(sourcePublic, '0'), {
      fee: '100',
      networkPassphrase: this.passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(sim.error);
    const retval = sim.result?.retval;
    if (retval === undefined) throw new SimulationError('balance simulation returned no retval');
    return scValI128ToBigInt(retval);
  }

  /** The contract Error discriminant of a LANDED-and-REVERTED pay() (for confirmBurnedSeq -> classifyRevertCause).
   *  SCOPED to `contractId` (the TroyPool C-address): only an error emitted BY that contract counts, so the inner
   *  USDC SAC's own error can never be mis-read as TroyPool AlreadyProcessed/InsufficientBalance. Only a FAILED tx
   *  carries a code; SUCCESS/NOT_FOUND and any read/parse failure return null — the money-SAFE default
   *  (classifyRevertCause(null)='Other' -> fresh-seq re-drive; the on-chain Processed(tx_id) guard is the real
   *  double-pay shield, so a null can never cause a double payout). Extra method beyond RpcPort; live-smoked. */
  async readContractErrorCode(hashHex: string, contractId: string): Promise<number | null> {
    try {
      const res = await this.server.getTransaction(hashHex);
      if (res.status !== rpc.Api.GetTransactionStatus.FAILED) return null;
      return firstContractErrorCodeFromContract(collectDiagnosticEvents(res), contractId);
    } catch {
      return null;
    }
  }
}

/** Reduce a reverted tx's diagnostic events (top-level list AND, as a fallback, the ones nested in the soroban
 *  meta) to (emitting contract C-address, topics+data ScVals) pairs, so firstContractErrorCodeFromContract can
 *  scan only the events the TroyPool contract itself emitted. Per-event and per-source failures are swallowed —
 *  a missing/odd shape just yields fewer events (-> null -> safe re-drive), never a wrong contract's code. */
function collectDiagnosticEvents(res: rpc.Api.GetFailedTransactionResponse): DiagnosticScVals[] {
  const out: DiagnosticScVals[] = [];
  const push = (events: readonly xdr.DiagnosticEvent[] | undefined): void => {
    for (const ev of events ?? []) {
      try {
        const cev = ev.event();
        const cid = cev.contractId();
        // ContractId is an opaque 32-byte Hash at runtime; encode it to the same C-address form as the pool id.
        const contractId = cid === null ? null : StrKey.encodeContract(cid as unknown as Buffer);
        const v0 = cev.body().v0();
        out.push({ contractId, vals: [...v0.topics(), v0.data()] });
      } catch {
        // a non-v0 body or an unreadable contractId -> skip this event (fewer events, still safe).
      }
    }
  };
  const top = res.diagnosticEventsXdr ?? [];
  push(top);
  // FALLBACK ONLY when the top-level list is absent/empty (some nodes carry diagnostics inside the soroban meta
  // instead) — pushing both unconditionally would double-count the same events.
  if (top.length === 0) {
    try {
      push(res.resultMetaXdr.v3().sorobanMeta()?.diagnosticEvents());
    } catch {
      // resultMetaXdr is not a V3 soroban meta (or carries no sorobanMeta) -> nothing to add.
    }
  }
  return out;
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
