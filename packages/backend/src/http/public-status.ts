// The customer-facing status map. The internal settlement State (which leaks the USDC/crypto leg) is NEVER
// exposed on /status — the storefront only ever learns a coarse payment status (Track E rule: "settling /
// settled are not shown to the user"). Total over every State.

import type { State } from '@troia/core';

export type PublicStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'review';

export function toPublicStatus(state: State): PublicStatus {
  switch (state) {
    case 'Reserved':
    case 'SolvencyReserved':
      // reserving / awaiting the customer's payment on the hosted form — nothing charged, nothing settled yet.
      return 'pending';
    case 'UsdcSubmitted':
    case 'UsdcPending':
    case 'UsdcDead':
    case 'UsdcReverted':
      // charged; the USDC leg is in flight / being resolved.
      return 'processing';
    case 'UsdcConfirmed':
    case 'Reconciled':
      // USDC landed at the merchant (the charge was already taken) — done from the customer's view.
      return 'completed';
    case 'ChargeReversing':
    case 'ChargeReversed':
    case 'FailedClean':
      // the payment did not go through (declined, or USDC failed and the sale is being/was voided).
      return 'failed';
    case 'LossReview':
      return 'review';
  }
}
