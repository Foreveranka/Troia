// EngineConfig — the INJECTED, secret-free network + psp-template facts the engine's perform() needs to
// assemble a PayRequest (Stellar leg) and the iyzico request params (fiat leg). Everything here comes from
// NetworkConfig (@troia/config) at the composition root (4.3d); NO apiKey/secretKey (those live only inside
// the psp adapter). Per-order money fields (price/paidPrice/amounts/destination/memo) come from OrderCtx,
// NEVER from here — this holds only the network-fixed and merchant-fixed template.

import type { Address, BasketItem, Buyer, Locale } from '@troia/psp';
import type { PolicyConfig } from '../policy.js';

export interface EngineStellarConfig {
  /** operator G-address — the pay() tx SOURCE. */
  readonly operatorPublic: string;
  /** TroyPool contract C-address. */
  readonly troyPool: string;
  readonly passphrase: string;
  /** the USDC issuer G-address; the allowlist PayoutIntent.build validates the destination trustline against. */
  readonly usdcIssuer: string;
  /** classic inclusion fee (stroops, string); the Soroban resource fee is added later at assemble. */
  readonly feeStroops: string;
  /** tx validity window in seconds; maxTime = clock.nowUnix() + this (finite — never TimeoutInfinite). */
  readonly timeboundsSecs: number;
}

/** The merchant/buyer TEMPLATE for the hosted checkout form + postauth/cancel. Per-order price and basket
 *  amount are filled from ctx.paidPriceTry at perform time; only fixed identity/address metadata lives here.
 *  (The buyer is a KYC-stub for the settlement-bridge PoC — the real cardholder data never leaves iyzico's
 *  hosted form.) */
export interface EnginePspConfig {
  readonly callbackUrl: string;
  readonly currency: string;
  readonly paymentGroup: string;
  readonly locale: Locale;
  readonly buyer: Buyer;
  readonly shippingAddress: Address;
  readonly billingAddress: Address;
  /** single-item basket metadata; its price is set per-order to ctx.paidPriceTry. */
  readonly basketItemTemplate: Pick<BasketItem, 'id' | 'name' | 'category1' | 'itemType'>;
}

export interface EngineConfig {
  readonly stellar: EngineStellarConfig;
  readonly psp: EnginePspConfig;
  readonly policy: PolicyConfig;
}
