// Double-entry, append-only settlement ledger (ADR-4 spread transparency; ARCHITECTURE §7 packages).
// Pure and deterministic — fixed-point bigint only, no clock, no network. It records where the money
// went: fiat_in (TRY collected), crypto_out (USDC paid), spread (margin), fee (PSP cost). The reporting
// (functional) currency is kuruş; every leg carries its NATIVE amount (kuruş or stroops) AND its value
// in kuruş, and a valid entry's kuruş legs sum equal on both sides (classic double-entry). Native amounts
// stay in their own currency so drift detection can compare the pool's USDC total to the on-chain balance
// — the chain is the source of truth, and any nonzero drift is an alarm, never silently absorbed.

export const STROOP = 10_000_000n; // 1 USDC = 1e7 stroops (Stellar 7 decimals)
export const KURUS_PER_TRY = 100n; // TRY has 2 decimals (kuruş)

// Assets increase on the DEBIT side; income/equity increase on the CREDIT side. Each account is bound to
// exactly one native currency, so a leg can never be mis-tagged.
export type Account = 'FIAT_CASH' | 'USDC_POOL' | 'SPREAD_REVENUE' | 'PSP_FEE' | 'EXTERNAL_FUNDING';
export type Currency = 'TRY' | 'USDC';
export type EntryKind = 'SETTLEMENT' | 'TOPUP';

const ACCOUNT_CURRENCY: Record<Account, Currency> = {
  FIAT_CASH: 'TRY', // TRY we custody at the PSP/bank
  USDC_POOL: 'USDC', // USDC held in the Stellar pool
  SPREAD_REVENUE: 'TRY', // transparent margin (ADR-4)
  PSP_FEE: 'TRY', // processing cost (expense)
  EXTERNAL_FUNDING: 'TRY', // counter-account for pool top-ups (rebalance / minted testnet USDC)
};

export interface Leg {
  readonly account: Account;
  /** Amount in the account's native minor units (kuruş for TRY accounts, stroops for USDC). Always > 0. */
  readonly native: bigint;
  /** Value in the functional currency (kuruş). Always > 0. For TRY accounts this equals `native`. */
  readonly kurus: bigint;
}

export interface JournalEntry {
  readonly seq: number; // 0-based append index, assigned by the ledger (append-only ordering)
  readonly ref: string; // idempotency key (order_id for settlements, a top-up id otherwise)
  readonly kind: EntryKind;
  readonly debits: readonly Leg[];
  readonly credits: readonly Leg[];
}

export interface SettlementInput {
  readonly orderId: string; // becomes the entry ref (idempotent per order)
  readonly usdcStroops: bigint; // USDC paid to the merchant (> 0)
  readonly userTryKurus: bigint; // what the user paid, in kuruş (> 0) — the frozen price (invariant ⑤)
  readonly spreadKurus: bigint; // transparent margin, in kuruş (>= 0, < userTryKurus)
  readonly feeKurus?: bigint; // PSP/processing cost, in kuruş (>= 0, <= userTryKurus); default 0
}

export interface TopUpInput {
  readonly ref: string; // top-up id (idempotent)
  readonly usdcStroops: bigint; // USDC added to the pool (> 0)
  readonly valueKurus: bigint; // TRY value of the top-up, in kuruş (> 0)
}

export interface DriftReport {
  readonly expectedPoolStroops: bigint; // ledger-derived pool USDC (nativeBalance of USDC_POOL)
  readonly observedPoolStroops: bigint; // on-chain balance — the source of truth
  readonly driftStroops: bigint; // observed - expected (negative => chain has less; possible loss)
  readonly inSync: boolean; // drift === 0
}

export type LedgerErrorCode =
  | 'EmptyEntry'
  | 'NonPositiveAmount'
  | 'ValuationMismatch'
  | 'Unbalanced'
  | 'DuplicateRef'
  | 'InvalidSettlement'
  | 'CorruptJournal';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function sumKurus(legs: readonly Leg[]): bigint {
  return legs.reduce((s, l) => s + l.kurus, 0n);
}
function sumNative(legs: readonly Leg[]): bigint {
  return legs.reduce((s, l) => s + l.native, 0n);
}
// Deep-freeze the legs we store so the append-only journal is immutable at RUNTIME, not just at the
// type level: `readonly` is erased in compiled JS, so without this a plain-JS caller could mutate a
// stored leg's amount and silently unbalance a recorded entry. We copy first so we never freeze the
// caller's arrays/objects out from under them.
function frozenLegs(legs: readonly Leg[]): readonly Leg[] {
  return Object.freeze(legs.map((l) => Object.freeze({ ...l })));
}

export interface PostInput {
  readonly ref: string;
  readonly kind: EntryKind;
  readonly debits: readonly Leg[];
  readonly credits: readonly Leg[];
}

// ---------------------------------------------------------------------------------------------------------
// Durability seam. The ledger stays pure: it never imports `node:fs` and never learns where its journal lives.
// The composition root injects a JournalSink; `post()` writes THROUGH it before mutating memory, so in-memory
// state is always a subset of what is durable ("book-or-neither"). On boot the root replays the journal into a
// fresh ledger with `hydrate()`, which reconstructs the same seq numbering and the same duplicate-ref set — so
// `nativeBalance('USDC_POOL')`, the baseline `detectDrift` compares against the chain, survives a restart
// instead of silently resetting to zero and hiding whatever moved while the process was down.
// ---------------------------------------------------------------------------------------------------------

/** A synchronous durable sink for journal entries. Throws on I/O failure; a throw must leave nothing booked. */
export interface JournalSink {
  append(payload: string): void;
}

const NOOP_SINK: JournalSink = { append() {} };

const RECORD_VERSION = 1;
/** Canonical non-negative decimal, no sign, no exponent, no leading zeros, no whitespace. `BigInt()` alone is
 *  far too permissive: it accepts '', ' 1 ', '-1' and '0x10', and it THROWS on '1e+21' — the exact string a
 *  stray `Number()` hop would have produced. Pin the grammar instead of trusting the parser. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function corrupt(what: string): never {
  throw new LedgerError('CorruptJournal', `journal record is not decodable: ${what}`);
}

function encodeLeg(l: Leg): Record<string, string> {
  return { account: l.account, native: String(l.native), kurus: String(l.kurus) };
}

/** JSON.stringify THROWS on a raw bigint, and a JSON number silently rounds past 2^53 — so every amount is a
 *  base-10 string. Key order is fixed so a record's bytes are a pure function of its value. */
export function encodeJournalEntry(e: JournalEntry): string {
  return JSON.stringify({
    v: RECORD_VERSION,
    seq: e.seq,
    ref: e.ref,
    kind: e.kind,
    debits: e.debits.map(encodeLeg),
    credits: e.credits.map(encodeLeg),
  });
}

function decodeLegs(raw: unknown, side: string): Leg[] {
  if (!Array.isArray(raw) || raw.length === 0) corrupt(`${side} must be a non-empty array`);
  return raw.map((l): Leg => {
    if (typeof l !== 'object' || l === null) corrupt(`${side} leg is not an object`);
    const { account, native, kurus } = l as Record<string, unknown>;
    if (typeof account !== 'string' || !(account in ACCOUNT_CURRENCY)) corrupt(`unknown account`);
    if (typeof native !== 'string' || !DECIMAL.test(native)) corrupt(`non-canonical native amount`);
    if (typeof kurus !== 'string' || !DECIMAL.test(kurus)) corrupt(`non-canonical kurus amount`);
    return { account: account as Account, native: BigInt(native), kurus: BigInt(kurus) };
  });
}

/** Fail-CLOSED: a record whose bytes are intact but whose shape, version or amounts are wrong means format
 *  drift or tampering, never something to skip. Skipping one record would renumber every later seq. */
export function decodeJournalEntry(payload: string): JournalEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    corrupt('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) corrupt('not an object');
  const { v, seq, ref, kind, debits, credits } = raw as Record<string, unknown>;
  if (v !== RECORD_VERSION) corrupt(`unsupported version ${String(v)}`);
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) corrupt('bad seq');
  if (typeof ref !== 'string' || ref.length === 0) corrupt('bad ref');
  if (kind !== 'SETTLEMENT' && kind !== 'TOPUP') corrupt(`bad kind ${String(kind)}`);
  return Object.freeze({
    seq,
    ref,
    kind,
    debits: frozenLegs(decodeLegs(debits, 'debits')),
    credits: frozenLegs(decodeLegs(credits, 'credits')),
  });
}

export class Ledger {
  private readonly entries: JournalEntry[] = [];
  private readonly refs = new Set<string>();
  private readonly sink: JournalSink;

  /** Pure by default. Pass a sink to make every posted entry durable BEFORE it is visible in memory. */
  constructor(sink: JournalSink = NOOP_SINK) {
    this.sink = sink;
  }

  /**
   * Validate and append a balanced entry (fail-closed). Rejects: an empty side, any non-positive leg, a
   * TRY-native leg whose functional value differs from its native amount, an unbalanced entry, or a
   * duplicate ref. Nothing that fails validation is ever appended.
   */
  post(input: PostInput): JournalEntry {
    const { ref, kind, debits, credits } = input;
    this.validateBalanced(debits, credits);
    if (this.refs.has(ref)) {
      throw new LedgerError('DuplicateRef', `entry ref already recorded: ${ref}`);
    }
    const entry: JournalEntry = Object.freeze({
      seq: this.entries.length,
      ref,
      kind,
      debits: frozenLegs(debits),
      credits: frozenLegs(credits),
    });
    // DURABLE FIRST. A sink throw leaves seq unconsumed and `refs` untouched, so nothing is booked and a retry
    // recomputes the identical entry. There is no await between here and the push, so on Node's single thread
    // the pair is atomic — two posts can never interleave and emit a duplicate seq or a duplicate ref line.
    this.sink.append(encodeJournalEntry(entry));
    this.entries.push(entry);
    this.refs.add(ref);
    return entry;
  }

  /** The immutable double-entry laws, applied identically to a live post and to a replayed record. */
  private validateBalanced(debits: readonly Leg[], credits: readonly Leg[]): void {
    if (debits.length === 0 || credits.length === 0) {
      throw new LedgerError('EmptyEntry', 'an entry needs at least one debit and one credit');
    }
    for (const leg of [...debits, ...credits]) {
      if (leg.native <= 0n || leg.kurus <= 0n) {
        throw new LedgerError(
          'NonPositiveAmount',
          `leg amounts must be > 0 (account ${leg.account})`,
        );
      }
      // For a TRY-native account the functional currency IS its native currency, so the two must agree.
      // (USDC legs deliberately differ: native is stroops, functional is the TRY-at-mid valuation.)
      if (ACCOUNT_CURRENCY[leg.account] === 'TRY' && leg.native !== leg.kurus) {
        throw new LedgerError(
          'ValuationMismatch',
          `TRY account ${leg.account}: native ${leg.native} != functional ${leg.kurus}`,
        );
      }
    }
    if (sumKurus(debits) !== sumKurus(credits)) {
      throw new LedgerError(
        'Unbalanced',
        `debits ${sumKurus(debits)} != credits ${sumKurus(credits)} (kuruş)`,
      );
    }
  }

  /**
   * Replay a journal into a FRESH ledger, in file order. Re-applies the structural double-entry laws (a corrupt
   * record fails closed) and rebuilds the duplicate-ref set, then continues numbering where the file left off.
   *
   * It deliberately does NOT re-run recordSettlement/recordTopUp's business rules (spread < userTry, fee <=
   * userTry): those are write-time gates on an INPUT, and a later tightening of them must never retroactively
   * reject a record that was valid when it was booked. It replays the posted legs verbatim; history is history.
   *
   * A seq gap, a reorder, or a duplicate ref is fatal — a synchronous single writer cannot produce one, so their
   * presence means corruption or tampering, and skipping would renumber every later entry into a different ledger.
   */
  hydrate(entries: readonly JournalEntry[]): void {
    if (this.entries.length > 0) {
      throw new LedgerError('CorruptJournal', 'hydrate() requires a fresh ledger');
    }
    for (const e of entries) {
      this.validateBalanced(e.debits, e.credits);
      if (e.seq !== this.entries.length) {
        throw new LedgerError(
          'CorruptJournal',
          `journal seq gap: expected ${this.entries.length}, got ${e.seq}`,
        );
      }
      if (this.refs.has(e.ref)) {
        throw new LedgerError('DuplicateRef', `journal replays a duplicate ref: ${e.ref}`);
      }
      this.entries.push(
        Object.freeze({
          seq: e.seq,
          ref: e.ref,
          kind: e.kind,
          debits: frozenLegs(e.debits),
          credits: frozenLegs(e.credits),
        }),
      );
      this.refs.add(e.ref);
    }
  }

  /**
   * Book one settled order, balanced by construction: fiat_in == crypto_out(at mid) + spread, with any
   * PSP fee split out of the cash leg as an expense. The USDC value at mid is derived (userTryKurus -
   * spreadKurus) so the identity cannot be violated by an inconsistent caller. Zero-valued legs (no
   * spread / no fee) are omitted so every leg stays strictly positive.
   */
  recordSettlement(input: SettlementInput): JournalEntry {
    const { orderId, usdcStroops, userTryKurus } = input;
    const spreadKurus = input.spreadKurus;
    const feeKurus = input.feeKurus ?? 0n;

    if (usdcStroops <= 0n) throw new LedgerError('InvalidSettlement', 'usdcStroops must be > 0');
    if (userTryKurus <= 0n) throw new LedgerError('InvalidSettlement', 'userTryKurus must be > 0');
    if (spreadKurus < 0n) throw new LedgerError('InvalidSettlement', 'spreadKurus must be >= 0');
    if (feeKurus < 0n) throw new LedgerError('InvalidSettlement', 'feeKurus must be >= 0');
    if (spreadKurus >= userTryKurus) {
      throw new LedgerError(
        'InvalidSettlement',
        'spreadKurus must be < userTryKurus (base would be <= 0)',
      );
    }
    if (feeKurus > userTryKurus) {
      throw new LedgerError('InvalidSettlement', 'feeKurus must be <= userTryKurus');
    }

    const baseKurus = userTryKurus - spreadKurus; // TRY value of the USDC sent (at oracle mid)
    const netCashKurus = userTryKurus - feeKurus; // TRY actually landing in our custody

    const debits: Leg[] = [{ account: 'FIAT_CASH', native: netCashKurus, kurus: netCashKurus }];
    if (feeKurus > 0n) debits.push({ account: 'PSP_FEE', native: feeKurus, kurus: feeKurus });

    const credits: Leg[] = [{ account: 'USDC_POOL', native: usdcStroops, kurus: baseKurus }];
    if (spreadKurus > 0n)
      credits.push({ account: 'SPREAD_REVENUE', native: spreadKurus, kurus: spreadKurus });

    return this.post({ ref: orderId, kind: 'SETTLEMENT', debits, credits });
  }

  /** Fund the pool: debit USDC_POOL (native USDC up) against EXTERNAL_FUNDING. */
  recordTopUp(input: TopUpInput): JournalEntry {
    const { ref, usdcStroops, valueKurus } = input;
    if (usdcStroops <= 0n) throw new LedgerError('InvalidSettlement', 'usdcStroops must be > 0');
    if (valueKurus <= 0n) throw new LedgerError('InvalidSettlement', 'valueKurus must be > 0');
    return this.post({
      ref,
      kind: 'TOPUP',
      debits: [{ account: 'USDC_POOL', native: usdcStroops, kurus: valueKurus }],
      credits: [{ account: 'EXTERNAL_FUNDING', native: valueKurus, kurus: valueKurus }],
    });
  }

  /** A snapshot copy — the internal journal is never handed out, so callers can't splice it. */
  all(): readonly JournalEntry[] {
    return [...this.entries];
  }

  /**
   * Has this ref already been booked? Because the journal is durable and replayed at boot, this answers "did a
   * PREVIOUS life already do this?" — which is the only way a worker can avoid repeating a side effect that
   * happened before a crash. Asking the ledger AFTER the effect is too late; the effect already ran twice.
   */
  hasRef(ref: string): boolean {
    return this.refs.has(ref);
  }

  /** Functional-currency balance: Σ debit.kurus − Σ credit.kurus. Assets positive, income/equity negative. */
  balanceKurus(account: Account): bigint {
    let bal = 0n;
    for (const e of this.entries) {
      for (const d of e.debits) if (d.account === account) bal += d.kurus;
      for (const c of e.credits) if (c.account === account) bal -= c.kurus;
    }
    return bal;
  }

  /** Native-currency balance: Σ debit.native − Σ credit.native. For USDC_POOL this is the live pool USDC. */
  nativeBalance(account: Account): bigint {
    let bal = 0n;
    for (const e of this.entries) {
      for (const d of e.debits) if (d.account === account) bal += d.native;
      for (const c of e.credits) if (c.account === account) bal -= c.native;
    }
    return bal;
  }

  /** Total transparent margin booked, in kuruş (SPREAD_REVENUE is a credit-normal account). */
  totalSpreadRevenueKurus(): bigint {
    return -this.balanceKurus('SPREAD_REVENUE');
  }

  /** Sum of every account's functional balance. Always exactly zero when every entry balances. */
  trialBalanceKurus(): bigint {
    let bal = 0n;
    for (const e of this.entries) bal += sumKurus(e.debits) - sumKurus(e.credits);
    return bal;
  }

  /**
   * Compare the ledger's expected pool USDC against the on-chain balance (the source of truth). A nonzero
   * drift means the two disagree — an unrecorded payout/top-up or an external movement — and must alarm.
   */
  detectDrift(observedPoolStroops: bigint): DriftReport {
    const expected = this.nativeBalance('USDC_POOL');
    const drift = observedPoolStroops - expected;
    return {
      expectedPoolStroops: expected,
      observedPoolStroops,
      driftStroops: drift,
      inSync: drift === 0n,
    };
  }
}

// Re-exported so downstream code (backend, reconciler) can total legs without re-deriving the shape.
export { sumKurus, sumNative };
