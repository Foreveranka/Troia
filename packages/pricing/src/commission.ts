// Commission model — the mathematical pricing of FX (kur) risk (komisyon-modeli.docx).
//
//   Commission(n) = μ·n  +  z·σ·√n  +  margin
//                   (drift)  (shock buffer)  (profit)
//
// It answers one question: if the bridge pays the merchant TODAY and receives its fiat n days later, what
// percent commission covers that wait? μ·n prices the KNOWN TRY-depreciation trend (grows linearly with n);
// z·σ·√n prices the UNEXPECTED daily shocks (grows with √n — independent daily jumps partly cancel, the
// random-walk √-time law); margin is a flat, risk-independent profit, kept separate so risk vs fee is always
// legible. μ and σ are MEASURED from the daily log-returns of the USD/TRY close series (~6 months), so the
// commission cheapens on its own when the market is calm and rises when it tenses (doc §2).
//
// Pure and deterministic — no clock, no network, no AI (the returns / mean / std-dev / √n are plain float
// math). The ONLY value that leaves the model is an integer basis-point spread that pricing.applySpread
// consumes; it is rounded to the nearest bp, which reproduces the model's published table (§4) exactly.

/** Measured daily statistics of the USD/TRY log-return series. Both are FRACTIONAL (0.00055 = 0.055%/day). */
export interface ReturnStats {
  readonly muDaily: number; // mean of the daily log-returns — the known TRY depreciation trend (drift)
  readonly sigmaDaily: number; // sample std-dev of the daily log-returns — the daily volatility
}

/** The pricing knobs: valör days, confidence coefficient, and the fixed margin (in basis points). */
export interface CommissionParams {
  readonly valorDays: number; // n — days the bridge waits for the fiat (T+n). Integer >= 1.
  readonly z: number; // confidence coefficient (z=1 ~ 68%, z=1.65 ~ 95% one-sided). >= 0.
  readonly marginBps: number; // fixed profit, risk-independent, in basis points (30 = 0.30%). Integer >= 0.
}

/** The transparent breakdown — each term as a % of the settlement (so risk vs fee stays legible), plus the
 *  integer bps the spread pricer consumes. */
export interface CommissionBreakdown {
  readonly driftPct: number; // μ·n, as %
  readonly volPct: number; // z·σ·√n, as %
  readonly marginPct: number; // margin, as %
  readonly totalPct: number; // the sum, as %
  readonly bps: number; // round(totalPct × 100) — the integer spread for applySpread (>= 0)
}

function requireFinite(x: number, name: string): void {
  if (typeof x !== 'number' || !Number.isFinite(x))
    throw new RangeError(`${name} must be a finite number`);
}

/**
 * Compute μ (mean) and σ (sample std-dev) from a CHRONOLOGICAL (oldest-first) series of daily USD/TRY closes.
 * Returns are logarithmic: r_i = ln(close_i / close_{i-1}) (they are additive across days, doc §3.2); μ is
 * their arithmetic mean and σ their SAMPLE std-dev (÷ n-1, doc §3.4). Needs at least 3 closes (≥ 2 returns, so
 * the sample variance has ≥ 1 degree of freedom); every close must be finite and > 0 (log-return is otherwise
 * undefined). The production feed (Yahoo USDTRY=X / TCMB) swaps the input — the math is identical (§3.1).
 */
export function computeReturnStats(closes: readonly number[]): ReturnStats {
  if (closes.length < 3) throw new RangeError('computeReturnStats needs at least 3 daily closes');
  for (const c of closes) {
    requireFinite(c, 'close');
    if (c <= 0) throw new RangeError('every close must be > 0 (log-return is undefined otherwise)');
  }
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i]! / closes[i - 1]!));
  const muDaily = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - muDaily) ** 2, 0) / (returns.length - 1);
  return { muDaily, sigmaDaily: Math.sqrt(variance) };
}

/**
 * Price the FX risk of waiting `valorDays` for the fiat: Commission(n) = μ·n + z·σ·√n + margin. Returns the
 * transparent per-term breakdown plus the integer bps (rounded to the nearest bp) that pricing.applySpread
 * consumes. A (degenerate) negative total — e.g. a strongly APPRECIATING TRY with no buffer/margin — clamps to
 * 0 bps: the bridge never applies a negative spread.
 */
export function commission(stats: ReturnStats, params: CommissionParams): CommissionBreakdown {
  requireFinite(stats.muDaily, 'muDaily');
  requireFinite(stats.sigmaDaily, 'sigmaDaily');
  if (stats.sigmaDaily < 0) throw new RangeError('sigmaDaily must be >= 0');
  const { valorDays: n, z, marginBps } = params;
  if (!Number.isInteger(n) || n < 1) throw new RangeError('valorDays must be an integer >= 1');
  requireFinite(z, 'z');
  if (z < 0) throw new RangeError('z must be >= 0');
  if (!Number.isInteger(marginBps) || marginBps < 0) {
    throw new RangeError('marginBps must be a non-negative integer');
  }

  const driftFrac = stats.muDaily * n;
  const volFrac = z * stats.sigmaDaily * Math.sqrt(n);
  const marginFrac = marginBps / 10_000;
  const totalFrac = driftFrac + volFrac + marginFrac;
  const bps = Math.max(0, Math.round(totalFrac * 10_000));
  return {
    driftPct: driftFrac * 100,
    volPct: volFrac * 100,
    marginPct: marginFrac * 100,
    totalPct: totalFrac * 100,
    bps,
  };
}

/** The integer basis-point spread for pricing.applySpread — the only value that leaves the model. */
export function commissionBps(stats: ReturnStats, params: CommissionParams): number {
  return commission(stats, params).bps;
}
