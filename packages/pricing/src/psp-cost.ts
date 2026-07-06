// PSP cost pass-through (gross-up) — recovers the payment provider's cut so the TRY we NET still covers the USDC
// we paid + the FX-risk buffer + margin, never less. Separate legible line (ADR-4): the PSP cost is a fee, not a
// worse exchange rate, so it never hides inside the FX rate.
//
// WHY GROSS-UP, NOT ADDITION. A card PSP (iyzico / bank virtual POS / PayTR …) charges its fee on the FINAL price
// the customer pays, not on our net. So you cannot ADD its percentage. To keep N after a fee of p (fraction) plus
// a fixed f, the customer must pay (N + f) / (1 − p). Simple addition (N·(1+p) + f) systematically UNDER-recovers
// by p·(our own markup) — a leak that GROWS with the PSP rate and with the FX-risk commission, quietly eating
// margin. Gross-up recovers the provider's cut exactly.
//
// PROVIDER-AGNOSTIC. The two knobs (rateBps, fixedKurus) are the only provider-specific values; swapping iyzico →
// bank POS → PayTR is a config change, not a code change (ADR-9). This models the standard card-acquiring case:
// "% of the transaction + fixed, deducted from settlement". A provider that instead charged on the NET, or billed
// out-of-band, would be a different pass-through function — expressible as a sibling of this one, not a rewrite.
//
// Pure, deterministic, fixed-point bigint (kuruş). Rounds the customer price UP (ceil): this is the one place we
// round user-UNfavorably, because it is COST RECOVERY, not margin — rounding down would reintroduce the very leak
// we are closing. The effect is sub-kuruş.

const BPS_DENOM = 10_000n; // basis-point denominator (100% = 10000 bps); mirrors @troia/pricing BPS_DENOM

/** A payment provider's per-transaction cost: a percentage (basis points) of the FINAL price + a fixed fee. */
export interface PspCost {
  /** The provider's percentage cut, in basis points of the final (gross) price. Integer, 0 ≤ rateBps < 10000. */
  readonly rateBps: number;
  /** The provider's fixed per-transaction fee, in kuruş (TRY minor units). >= 0. */
  readonly fixedKurus: bigint;
}

/** The gross-up result: the price the customer pays, and the provider's cost baked into it (a legible line). */
export interface PspPassthrough {
  /** The grossed-up price the customer pays, in kuruş — after the provider's cut, exactly `netKurus` remains. */
  readonly grossKurus: bigint;
  /** The provider's cost, in kuruş = grossKurus − netKurus (the transparent PSP line, ADR-4). */
  readonly pspCostKurus: bigint;
}

/**
 * Gross up `netKurus` (what we must RECEIVE) so that after the provider takes rateBps% of the gross plus a fixed
 * fee, at least `netKurus` remains: grossKurus = ceil((netKurus + fixedKurus) × 10000 / (10000 − rateBps)).
 * `rateBps` must be an integer in [0, 10000) — a 100% fee is unrecoverable. A zero-cost provider (0 bps, 0 fixed)
 * is the identity (grossKurus === netKurus), so the pre-PSP price is unchanged and the pipeline stays backward
 * compatible.
 */
export function applyPspPassthrough(netKurus: bigint, psp: PspCost): PspPassthrough {
  if (netKurus < 0n) throw new RangeError('netKurus must be >= 0');
  if (!Number.isInteger(psp.rateBps) || psp.rateBps < 0 || psp.rateBps >= 10_000) {
    throw new RangeError('rateBps must be an integer in [0, 10000)');
  }
  if (psp.fixedKurus < 0n) throw new RangeError('fixedKurus must be >= 0');

  const denom = BPS_DENOM - BigInt(psp.rateBps); // 10000 − rateBps, in (0, 10000]
  const numer = (netKurus + psp.fixedKurus) * BPS_DENOM;
  // Ceil division for positive operands: (a + b − 1) / b. Rounds the customer price UP so the cut is fully covered.
  const grossKurus = (numer + denom - 1n) / denom;
  return { grossKurus, pspCostKurus: grossKurus - netKurus };
}
