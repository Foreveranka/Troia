// DIRTY concrete RpcPort over @stellar/stellar-sdk's rpc.Server. network:true, keyless. This is the ONLY
// place Soroban-RPC SDK types live; every method maps a raw SDK response into a normalized outcome ADT so
// the pure core never sees an SDK type. Not exercised by the offline suite (it needs a live RPC); it is
// type-checked by tsc and live-smoked once contracts are deployed (Phase 4.4+).

import {
  Account,
  Address,
  Contract,
  Keypair,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type {
  AccountSeqRead,
  GetTxOutcome,
  LedgerHead,
  SendOutcome,
  SimResult,
} from './outcomes.js';
import type { RpcPort, UnpreparedTx } from './ports.js';
import { SimulationError, SubmitError } from './errors.js';
import { withTimeout } from './net-timeout.js';
import { firstContractErrorCodeFromContract, scValI128ToBigInt } from './soroban-reads.js';
import type { DiagnosticScVals } from './soroban-reads.js';
import { cursorLedger } from './outflow-types.js';
import type {
  OutflowEvent,
  PoolActivityPage,
  PoolFetch,
  PoolUpgrade,
  SettlementObservation,
  TxLiveness,
} from './outflow-types.js';

/** Per-call RPC deadline: high enough to never trip on normal latency (<2s), low enough that a genuinely hung
 *  socket can't wedge the poll loop indefinitely (see net-timeout.ts). Overridable via opts.timeoutMs. */
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

export class SorobanRpcAdapter implements RpcPort {
  private readonly server: rpc.Server;
  private readonly timeoutMs: number;

  constructor(
    rpcUrl: string,
    private readonly passphrase: string,
    opts?: { allowHttp?: boolean; timeoutMs?: number },
  ) {
    this.server = new rpc.Server(
      rpcUrl,
      opts?.allowHttp === true ? { allowHttp: true } : undefined,
    );
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  async simulate(unprepared: UnpreparedTx): Promise<SimResult> {
    const sim = await withTimeout(
      this.server.simulateTransaction(unprepared),
      this.timeoutMs,
      'rpc.simulate',
    );
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(sim.error);
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new SimulationError(
        'footprint touches archived entries — RestoreFootprint required first',
      );
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
    const res = await withTimeout(this.server.sendTransaction(tx), this.timeoutMs, 'rpc.send');
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
    const res = await withTimeout(
      this.server.getTransaction(hashHex),
      this.timeoutMs,
      'rpc.getTransaction',
    );
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
    const res = await withTimeout(
      this.server.getLedgerEntries(key),
      this.timeoutMs,
      'rpc.getLedgerEntries',
    );
    const entry = res.entries[0];
    if (entry === undefined) return { exists: false, seq: '0' };
    return { exists: true, seq: entry.val.account().seqNum().toString() };
  }

  async latestLedger(): Promise<LedgerHead> {
    const res = await withTimeout(
      this.server.getLatestLedger(),
      this.timeoutMs,
      'rpc.latestLedger',
    );
    return { sequence: res.sequence, closeTimeUnix: Number(res.closeTime) };
  }

  /** Read a holder's SAC balance (stroops) by SIMULATING a read-only `balance(holder)` — no tx is submitted,
   *  so `source` only needs to be a valid G-address (its on-chain seq is irrelevant to a read simulation). The
   *  composition uses this once at bootstrap to seed the Store with the live pool balance. Extra method beyond
   *  RpcPort; network:true, live-smoked. */
  async readSacBalance(
    sacContractId: string,
    holderAddress: string,
    sourcePublic: string,
  ): Promise<bigint> {
    const op = new Contract(sacContractId).call('balance', new Address(holderAddress).toScVal());
    const tx = new TransactionBuilder(new Account(sourcePublic, '0'), {
      fee: '100',
      networkPassphrase: this.passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await withTimeout(
      this.server.simulateTransaction(tx),
      this.timeoutMs,
      'rpc.readSacBalance',
    );
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
      const res = await withTimeout(
        this.server.getTransaction(hashHex),
        this.timeoutMs,
        'rpc.readContractErrorCode',
      );
      if (res.status !== rpc.Api.GetTransactionStatus.FAILED) return null;
      return firstContractErrorCodeFromContract(collectDiagnosticEvents(res), contractId);
    } catch {
      return null; // a timeout here -> null -> classifyRevertCause 'Other' -> fresh-seq re-drive (money-safe)
    }
  }

  /** OBSERVABILITY ONLY (flag-1 live check): describe a reverted tx's diagnostics + what the contract-scoped parser
   *  reads, so a live run can confirm the getTransaction-FAILED shape (does the node populate diagnostic events?
   *  does the TroyPool error carry its own contractId?). No money logic; never called on the money path — the
   *  money path uses readContractErrorCode, whose null is fail-SAFE. Used by scripts/probe-revert.mjs. */
  async describeRevert(
    hashHex: string,
    contractId: string,
  ): Promise<{
    status: string;
    topDiagnosticEvents: number;
    eventContractIds: readonly (string | null)[];
    classifiedCode: number | null;
  }> {
    const res = await withTimeout(
      this.server.getTransaction(hashHex),
      this.timeoutMs,
      'rpc.describeRevert',
    );
    if (res.status !== rpc.Api.GetTransactionStatus.FAILED) {
      return {
        status: String(res.status),
        topDiagnosticEvents: 0,
        eventContractIds: [],
        classifiedCode: null,
      };
    }
    const events = collectDiagnosticEvents(res);
    return {
      status: String(res.status),
      topDiagnosticEvents: (res.diagnosticEventsXdr ?? []).length,
      eventContractIds: events.map((e) => e.contractId),
      classifiedCode: firstContractErrorCodeFromContract(events, contractId),
    };
  }

  /**
   * Everything the chain did to the pool since `req`, in one scan of two contracts.
   *
   * The filter is contractId-ONLY, and the classification happens here. That is a defensive choice, not laziness:
   * a topics filter whose arity does not match the emitted event returns an EMPTY page with NO error — measured.
   * A classic-asset SAC emits four topics today (`transfer`, from, to, the asset name) and a protocol change
   * could drop the fourth. A silent empty page while the pool drains is the worst outcome an alarm can have, so
   * we accept receiving the inbound mints too and discard them here.
   *
   * A `payment_made` observation is emitted ONLY when it is complete. Its `source_account` is not in the event, so
   * it is read from the enclosing transaction's envelope; if that read fails, the whole page is reported as
   * unreachable rather than yielding a half-decoded observation. A half-decoded one would compare unequal against
   * our own signed transaction and manufacture a divergence alarm on a perfectly good payout.
   */
  async fetchPoolActivity(
    sacContractId: string,
    poolContractId: string,
    req: PoolFetch,
    limit = 200,
  ): Promise<PoolActivityPage> {
    const filters = [{ type: 'contract' as const, contractIds: [sacContractId, poolContractId] }];
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await withTimeout(
        this.server.getEvents({ ...req, filters, limit }),
        this.timeoutMs,
        'rpc.getEvents',
      );
    } catch (e) {
      return this.classifyEventsFailure(e, req, sacContractId);
    }

    const outflows: OutflowEvent[] = [];
    const settlements: SettlementObservation[] = [];
    const upgrades: PoolUpgrade[] = [];
    const sourceCache = new Map<string, string>();

    for (const ev of res.events) {
      // A transfer or an announcement inside a failed contract call moved nothing and settled nothing: the whole
      // invocation was rolled back.
      if (ev.inSuccessfulContractCall !== true) continue;
      const name = ev.topic[0];
      if (name === undefined || name.switch().name !== 'scvSymbol') continue;
      const symbol = name.sym().toString();
      const closeUnix = Math.floor(new Date(ev.ledgerClosedAt).getTime() / 1000);

      if (String(ev.contractId) === sacContractId && symbol === 'transfer') {
        const outflow = toOutflowEvent(ev, poolContractId, closeUnix);
        if (outflow !== null) outflows.push(outflow);
        continue;
      }
      if (String(ev.contractId) !== poolContractId) continue;

      if (symbol === 'upgraded') {
        upgrades.push({ txHash: ev.txHash, ledger: ev.ledger, ledgerCloseUnix: closeUnix });
        continue;
      }
      if (symbol !== 'payment_made') continue;

      let source = sourceCache.get(ev.txHash);
      if (source === undefined) {
        const read = await this.readTxSourceAccount(ev.txHash);
        if (read === null) {
          // We cannot complete this observation. Never emit a partial one; re-read the whole page next tick.
          return { kind: 'RPC_UNAVAILABLE', reason: `cannot read the envelope of ${ev.txHash}` };
        }
        source = read;
        sourceCache.set(ev.txHash, read);
      }
      const observed = toSettlementObservation(ev, source, closeUnix);
      if (observed !== null) settlements.push(observed);
    }

    return {
      kind: 'PAGE',
      outflows,
      settlements,
      upgrades,
      cursor: res.cursor,
      latestLedger: res.latestLedger,
      latestLedgerCloseUnix: Number(res.latestLedgerCloseTime),
      oldestLedger: res.oldestLedger,
    };
  }

  /** The source account of a landed transaction, from its envelope. Null when the node cannot answer. */
  private async readTxSourceAccount(hashHex: string): Promise<string | null> {
    try {
      const res = await withTimeout(
        this.server.getTransaction(hashHex),
        this.timeoutMs,
        'rpc.getTransaction.source',
      );
      if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;
      const env = res.envelopeXdr;
      if (env === undefined) return null;
      // A fee-bump wraps the real transaction; the reconciler compares against the INNER source, and a muxed
      // source would canonicalize to nothing. Read what our own decoder reads, or nothing at all.
      const inner =
        env.switch().name === 'envelopeTypeTxFeeBump'
          ? env.feeBump().tx().innerTx().v1().tx()
          : env.v1().tx();
      const account = inner.sourceAccount();
      if (account.switch().name !== 'keyTypeEd25519') return null;
      return StrKey.encodeEd25519PublicKey(account.ed25519());
    } catch {
      return null;
    }
  }

  /**
   * Is this transaction still on chain, successful, and at which ledger? A durable local observation outlives the
   * chain it describes: after a testnet reset the settlement it records simply is not there any more, and
   * reconciling MATCHED off that stale cache would assert "the chain agrees" about something the chain has never
   * heard of. ABSENT means the chain says no; UNKNOWN means we could not ask, which is not the same thing.
   */
  async checkTxLiveness(hashHex: string): Promise<TxLiveness> {
    try {
      const res = await withTimeout(
        this.server.getTransaction(hashHex),
        this.timeoutMs,
        'rpc.getTransaction.liveness',
      );
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { kind: 'SUCCESS', ledger: res.ledger };
      }
      if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { kind: 'ABSENT' };
      return { kind: 'UNKNOWN', reason: String(res.status) };
    } catch (e) {
      return { kind: 'UNKNOWN', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * `-32600` comes back BOTH when the requested position is below the retention floor and when it is ahead of the
   * node's head — measured; the code alone cannot tell them apart, and the message is free text nobody should be
   * parsing. So ask the node for its range structurally, and compare.
   *
   * Below the floor is a PERMANENT blind spot: those events are gone from this endpoint forever. Ahead of the
   * head is a node that is behind US (a rollback, or a load balancer serving a lagging replica) — the events
   * still exist, we simply cannot see them from here, so it is an availability stall and never an accusation.
   */
  private async classifyEventsFailure(
    e: unknown,
    req: PoolFetch,
    sacContractId: string,
  ): Promise<PoolActivityPage> {
    const reason = e instanceof Error ? e.message : String(e);
    if ((e as { code?: unknown }).code !== -32600) return { kind: 'RPC_UNAVAILABLE', reason };

    let oldestLedger: number;
    let latestLedger: number;
    try {
      const head = await withTimeout(
        this.server.getLatestLedger(),
        this.timeoutMs,
        'rpc.getEvents.rangeProbe',
      );
      const probe = await withTimeout(
        this.server.getEvents({
          startLedger: head.sequence - 1,
          filters: [{ type: 'contract' as const, contractIds: [sacContractId] }],
          limit: 1,
        }),
        this.timeoutMs,
        'rpc.getEvents.rangeProbe',
      );
      oldestLedger = probe.oldestLedger;
      latestLedger = probe.latestLedger;
    } catch {
      // We could not even establish the node's range, so we cannot claim a blind spot. Stall, never accuse.
      return { kind: 'RPC_UNAVAILABLE', reason };
    }

    const at = 'cursor' in req ? cursorLedger(req.cursor) : req.startLedger;
    if (at < oldestLedger) {
      return { kind: 'CURSOR_BELOW_RETENTION', cursorLedger: at, oldestLedger, latestLedger };
    }
    return { kind: 'RPC_UNAVAILABLE', reason };
  }
}

/** A SAC `transfer` whose `from` is the pool, or null. */
function toOutflowEvent(
  ev: rpc.Api.EventResponse,
  poolAddress: string,
  ledgerCloseUnix: number,
): OutflowEvent | null {
  // [transfer, from, to] plus, on a classic-asset SAC, the asset name. Tolerate either arity.
  const from = ev.topic[1];
  const to = ev.topic[2];
  if (from === undefined || to === undefined) return null;
  if (Address.fromScVal(from).toString() !== poolAddress) return null; // an inflow, or someone else's transfer
  return {
    txHash: ev.txHash,
    ledger: ev.ledger,
    ledgerCloseUnix,
    to: Address.fromScVal(to).toString(),
    amountStroops: scValI128ToBigInt(ev.value),
  };
}

/** The pool's `payment_made`: topics [symbol, tx_id], data a name-keyed map. Complete, or null. */
function toSettlementObservation(
  ev: rpc.Api.EventResponse,
  sourceAccount: string,
  ledgerCloseUnix: number,
): SettlementObservation | null {
  const txIdScVal = ev.topic[1];
  if (txIdScVal === undefined || txIdScVal.switch().name !== 'scvBytes') return null;
  if (ev.value.switch().name !== 'scvMap') return null;
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of ev.value.map() ?? []) {
    if (entry.key().switch().name !== 'scvSymbol') return null;
    fields.set(entry.key().sym().toString(), entry.val());
  }
  const amount = fields.get('amount');
  const appliedRate = fields.get('applied_rate');
  const merchant = fields.get('merchant');
  const memo = fields.get('memo');
  if (amount === undefined || appliedRate === undefined) return null;
  if (merchant === undefined || memo === undefined) return null;
  if (memo.switch().name !== 'scvBytes') return null;
  return {
    txIdHex: txIdScVal.bytes().toString('hex'),
    txHash: ev.txHash,
    ledger: ev.ledger,
    ledgerCloseUnix,
    contractId: String(ev.contractId),
    sourceAccount,
    merchant: Address.fromScVal(merchant).toString(),
    amountStroops: scValI128ToBigInt(amount),
    appliedRateStroops: scValI128ToBigInt(appliedRate),
    memoHex: memo.bytes().toString('hex'),
  };
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
