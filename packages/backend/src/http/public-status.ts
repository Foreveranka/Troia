// The customer-facing status map. The internal settlement State (which leaks the USDC/crypto leg) is NEVER
// exposed on /status — the storefront only ever learns a coarse payment status (Track E rule: "settling /
// settled are not shown to the user"). Total over every State.

import type { State } from '@troia/core';

export type PublicStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'review';

export function toPublicStatus(state: State): PublicStatus {
  switch (state) {
    case 'Reserved':
    case 'TryPreauthed':
      return 'pending';
    case 'UsdcSubmitted':
    case 'UsdcPending':
    case 'UsdcConfirmed':
    case 'UsdcDead':
    case 'UsdcReverted':
    case 'CaptureSubmitted':
      return 'processing';
    case 'TryCaptured':
    case 'Reconciled':
      return 'completed';
    case 'FailedClean':
    case 'TryHoldVoided':
    case 'SolvencyRejected':
    case 'AbandonedSeqReturned':
      return 'failed';
    case 'LossReview':
      return 'review';
  }
}
