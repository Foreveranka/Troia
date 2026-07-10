// What the chain said about the pool, kept because the chain will not keep it.
//
// Soroban RPC forgets contract events after about a week, and it forgets them for everyone. An order settled ten
// days ago cannot be looked up any more — not by us, not by an auditor, not by anybody. So the tail writes down
// what it sees as it sees it, and the reconciler reads that. The window still bounds what we can ever LEARN; it no
// longer bounds what we can REMEMBER.
//
// Three record kinds in one append-only log, because they come from one scan:
//   out — USDC left the pool in this transaction (the token contract's own account of what moved).
//   set — the pool announced a settlement for this order (`payment_made`, indexed by the order's tx_id).
//   upg — the pool's code was replaced. After this, its announcements are claims, not proofs.
//   cov — the instant we began watching. Only forward: a re-anchor after a retention gap moves it. Everything
//         before it was never scanned, so its absence from `set` is a fact about us and not about the chain.
//
// The observations are a CACHE of the chain, not a substitute for it: the reconciler re-confirms a settlement is
// still on chain before it will call an order reconciled. A testnet reset must not be reconciled away.

import type { ChainObservationStore } from '@troia/backend';
import type { OutflowEvent, PoolUpgrade, SettlementObservation } from '@troia/stellar-client';
import { FileAppendLog } from './file-append-log.js';

const OBSERVATIONS_FILE = 'chain-observations.log';
const RECORD_VERSION = 1;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export class ObservationCodecError extends Error {
  constructor(what: string) {
    super(`chain-observation record is not decodable: ${what}`);
    this.name = 'ObservationCodecError';
  }
}

type Record_ =
  | { readonly t: 'out'; readonly o: OutflowEvent }
  | { readonly t: 'set'; readonly s: SettlementObservation }
  | { readonly t: 'upg'; readonly u: PoolUpgrade }
  | { readonly t: 'cov'; readonly u: number };

function encode(r: Record_): string {
  if (r.t === 'out') {
    return JSON.stringify({
      v: RECORD_VERSION,
      t: 'out',
      txHash: r.o.txHash,
      ledger: r.o.ledger,
      ledgerCloseUnix: r.o.ledgerCloseUnix,
      to: r.o.to,
      amountStroops: String(r.o.amountStroops),
    });
  }
  if (r.t === 'cov') {
    return JSON.stringify({ v: RECORD_VERSION, t: 'cov', unix: r.u });
  }
  if (r.t === 'upg') {
    return JSON.stringify({
      v: RECORD_VERSION,
      t: 'upg',
      txHash: r.u.txHash,
      ledger: r.u.ledger,
      ledgerCloseUnix: r.u.ledgerCloseUnix,
    });
  }
  const s = r.s;
  return JSON.stringify({
    v: RECORD_VERSION,
    t: 'set',
    txIdHex: s.txIdHex,
    txHash: s.txHash,
    ledger: s.ledger,
    ledgerCloseUnix: s.ledgerCloseUnix,
    contractId: s.contractId,
    sourceAccount: s.sourceAccount,
    merchant: s.merchant,
    amountStroops: String(s.amountStroops),
    appliedRateStroops: String(s.appliedRateStroops),
    memoHex: s.memoHex,
  });
}

function str(v: unknown, f: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new ObservationCodecError(`bad ${f}`);
  return v;
}
function int(v: unknown, f: string): number {
  if (!Number.isSafeInteger(v)) throw new ObservationCodecError(`bad ${f}`);
  return v as number;
}
function amount(v: unknown, f: string): bigint {
  if (typeof v !== 'string' || !DECIMAL.test(v)) throw new ObservationCodecError(`bad ${f}`);
  return BigInt(v);
}

function decode(payload: string): Record_ {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new ObservationCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new ObservationCodecError('not an object');
  const r = raw as Record<string, unknown>;
  if (r.v !== RECORD_VERSION) throw new ObservationCodecError(`unsupported version ${String(r.v)}`);
  if (r.t === 'out') {
    return {
      t: 'out',
      o: {
        txHash: str(r.txHash, 'txHash'),
        ledger: int(r.ledger, 'ledger'),
        ledgerCloseUnix: int(r.ledgerCloseUnix, 'ledgerCloseUnix'),
        to: str(r.to, 'to'),
        amountStroops: amount(r.amountStroops, 'amountStroops'),
      },
    };
  }
  if (r.t === 'cov') {
    const u = int(r.unix, 'unix');
    if (u < 0) throw new ObservationCodecError('bad unix');
    return { t: 'cov', u };
  }
  if (r.t === 'upg') {
    return {
      t: 'upg',
      u: {
        txHash: str(r.txHash, 'txHash'),
        ledger: int(r.ledger, 'ledger'),
        ledgerCloseUnix: int(r.ledgerCloseUnix, 'ledgerCloseUnix'),
      },
    };
  }
  if (r.t !== 'set') throw new ObservationCodecError(`unknown record type ${String(r.t)}`);
  return {
    t: 'set',
    s: {
      txIdHex: str(r.txIdHex, 'txIdHex'),
      txHash: str(r.txHash, 'txHash'),
      ledger: int(r.ledger, 'ledger'),
      ledgerCloseUnix: int(r.ledgerCloseUnix, 'ledgerCloseUnix'),
      contractId: str(r.contractId, 'contractId'),
      sourceAccount: str(r.sourceAccount, 'sourceAccount'),
      merchant: str(r.merchant, 'merchant'),
      amountStroops: amount(r.amountStroops, 'amountStroops'),
      appliedRateStroops: amount(r.appliedRateStroops, 'appliedRateStroops'),
      memoHex: str(r.memoHex, 'memoHex'),
    },
  };
}

export class FileChainObservationStore implements ChainObservationStore {
  private readonly log: FileAppendLog;
  private readonly outByTx = new Map<string, bigint>();
  private readonly setByTxId = new Map<string, SettlementObservation>();
  private readonly seenOutflow = new Set<string>();
  private readonly upgraded: PoolUpgrade[] = [];
  private coverageStart: number | null = null;
  readonly warnings: readonly string[];

  constructor(dataDir: string) {
    this.log = new FileAppendLog(dataDir, OBSERVATIONS_FILE);
    const replayed = this.log.replay();
    this.warnings =
      replayed.recovered === null
        ? []
        : [
            `${OBSERVATIONS_FILE}: dropped a torn tail — its page was never checkpointed, so the same events are ` +
              `re-read on the next tick`,
          ];
    for (const payload of replayed.payloads) this.index(decode(payload));
  }

  private index(r: Record_): void {
    if (r.t === 'cov') {
      // The floor only ever rises. Taking the max (rather than the last record) means no ordering assumption about
      // the log: an earlier start can never claim we scanned ledgers we did not.
      if (this.coverageStart === null || r.u > this.coverageStart) this.coverageStart = r.u;
      return;
    }
    if (r.t === 'out') {
      // One transaction can move USDC more than once. Sum them, and dedupe on a re-read of the same page.
      const key = `${r.o.txHash}:${r.o.ledger}:${r.o.to}:${r.o.amountStroops}`;
      if (this.seenOutflow.has(key)) return;
      this.seenOutflow.add(key);
      this.outByTx.set(r.o.txHash, (this.outByTx.get(r.o.txHash) ?? 0n) + r.o.amountStroops);
      return;
    }
    if (r.t === 'upg') {
      if (!this.upgraded.some((u) => u.txHash === r.u.txHash)) this.upgraded.push(r.u);
      return;
    }
    // The FIRST announcement for a tx_id is the one that settled it: the contract's Processed(tx_id) guard makes
    // a second pay() on the same identifier revert, so a later one could only come from replaced code.
    if (!this.setByTxId.has(r.s.txIdHex)) this.setByTxId.set(r.s.txIdHex, r.s);
  }

  recordOutflow(o: OutflowEvent): void {
    const key = `${o.txHash}:${o.ledger}:${o.to}:${o.amountStroops}`;
    if (this.seenOutflow.has(key)) return; // a re-read page must not double-count what moved
    this.log.append(encode({ t: 'out', o }));
    this.index({ t: 'out', o });
  }

  recordSettlement(s: SettlementObservation): void {
    if (this.setByTxId.has(s.txIdHex)) return;
    this.log.append(encode({ t: 'set', s }));
    this.index({ t: 'set', s });
  }

  recordUpgrade(u: PoolUpgrade): void {
    if (this.upgraded.some((x) => x.txHash === u.txHash)) return;
    this.log.append(encode({ t: 'upg', u }));
    this.index({ t: 'upg', u });
  }

  recordCoverageStart(unix: number): void {
    // Nothing new to say — do not grow the log. This is thrift, not safety: the floor's correctness lives in the
    // max fold in `index`, which holds even for a log whose records arrive out of order.
    if (this.coverageStart !== null && unix <= this.coverageStart) return;
    this.log.append(encode({ t: 'cov', u: unix }));
    this.index({ t: 'cov', u: unix });
  }

  coverageStartUnix(): number | null {
    return this.coverageStart;
  }

  settlementByTxId(txIdHex: string): SettlementObservation | undefined {
    return this.setByTxId.get(txIdHex);
  }

  outflowStroopsByTx(txHash: string): bigint {
    return this.outByTx.get(txHash) ?? 0n;
  }

  upgrades(): readonly PoolUpgrade[] {
    return Object.freeze([...this.upgraded]);
  }
}

// --- reconciled orders ----------------------------------------------------------------------------------------

const RECONCILED_FILE = 'reconciled.log';

/** Which orders the audit has closed. Durable, so a restart neither re-audits nor re-advances a closed order. */
export class FileReconciledStore {
  private readonly log: FileAppendLog;
  private readonly closed = new Set<string>();
  readonly warnings: readonly string[];

  constructor(dataDir: string) {
    this.log = new FileAppendLog(dataDir, RECONCILED_FILE);
    const replayed = this.log.replay();
    this.warnings =
      replayed.recovered === null
        ? []
        : [`${RECONCILED_FILE}: dropped a torn tail — that order is simply audited again`];
    for (const payload of replayed.payloads) {
      const raw = JSON.parse(payload) as { v?: unknown; orderId?: unknown };
      if (raw.v !== RECORD_VERSION)
        throw new ObservationCodecError('unsupported reconciled version');
      this.closed.add(str(raw.orderId, 'orderId'));
    }
  }

  has(orderId: string): boolean {
    return this.closed.has(orderId);
  }

  /** Durable BEFORE the state machine is advanced: a crash between the two re-audits, it does not re-advance. */
  mark(orderId: string): void {
    if (this.closed.has(orderId)) return;
    this.log.append(JSON.stringify({ v: RECORD_VERSION, orderId }));
    this.closed.add(orderId);
  }
}
