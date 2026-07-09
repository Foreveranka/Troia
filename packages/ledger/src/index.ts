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
  | 'InvalidSettlement';

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

export class Ledger {
  private readonly entries: JournalEntry[] = [];
  private readonly refs = new Set<string>();

  /**
   * Validate and append a balanced entry (fail-closed). Rejects: an empty side, any non-positive leg, a
   * TRY-native leg whose functional value differs from its native amount, an unbalanced entry, or a
   * duplicate ref. Nothing that fails validation is ever appended.
   */
  post(input: PostInput): JournalEntry {
    const { ref, kind, debits, credits } = input;
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
    this.entries.push(entry);
    this.refs.add(ref);
    return entry;
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
