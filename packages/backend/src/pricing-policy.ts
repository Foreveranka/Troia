// PricingPolicy — the INJECTED pricing calibration the quote factory consumes at the composition root (Phase
// 4.5), the sibling of PolicyConfig. Like it, the real numbers are locked from live research/sandbox; the
// offline default below is a documented placeholder carrying the CURRENT researched basis. The field shapes are
// declared STRUCTURALLY (not imported from @troia/pricing) so the backend stays decoupled from the pricing math
// package — the shapes are assignable to pricing's CommissionParams / PspCost, so the 4.5 factory feeds this
// straight into quoteUsdcWithPsp(...).
//
// valorDays basis: iyzico single-payment settlement (blokaj / valör) runs 2–21 days (worst ~28), NOT the T+1 that
// third-party blogs claim — iyzico's own help center ties it to volume/contract. We hold the collected TRY that
// whole window before the pool can be rebalanced, so the FX-risk buffer must price ~21 days of drift + shock, not
// 2. 21 is the conservative standard-tier hold; a negotiated shorter valör would lower this knob.
//
// psp basis: iyzico researched single-payment production cost is 4.29% + 0.25 TRY (25 kuruş), the same across
// Troy / Visa / Mastercard. Swappable per ADR-9 — bank virtual POS debit (~1.04%), a high-volume PSP deal, etc.
// are a config change here, never a code change.

/** The commission knobs (FX-risk model, komisyon-modeli.docx) — assignable to @troia/pricing CommissionParams. */
export interface PricingCommissionPolicy {
  /** n — days the bridge waits for the fiat (the real iyzico valör). Integer >= 1. */
  readonly valorDays: number;
  /** confidence coefficient (z=1.65 ~ 95% one-sided). >= 0. */
  readonly z: number;
  /** fixed, risk-independent profit, in basis points. Integer >= 0. */
  readonly marginBps: number;
}

/** The PSP cost knobs — assignable to @troia/pricing PspCost. */
export interface PricingPspPolicy {
  /** the provider's percentage cut, in basis points of the final price. Integer, 0 <= rateBps < 10000. */
  readonly rateBps: number;
  /** the provider's fixed per-transaction fee, in kuruş. >= 0. */
  readonly fixedKurus: bigint;
}

/** The full injected pricing calibration: FX-risk commission + PSP cost. Consumed by the quote factory (4.5). */
export interface PricingPolicy {
  readonly commission: PricingCommissionPolicy;
  readonly psp: PricingPspPolicy;
}

/** Offline placeholder carrying the researched basis (see file header). Real values are locked in Phase 4.5. */
export const OFFLINE_DEFAULT_PRICING_POLICY: PricingPolicy = {
  commission: { valorDays: 21, z: 1.65, marginBps: 50 },
  psp: { rateBps: 429, fixedKurus: 25n },
};
