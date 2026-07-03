// PURE: a landed-and-reverted USDC tx's on-chain result -> the core revert-cause event. The exact TroyPool
// contract error codes are confirmed against the deployed contract in Phase 4.4/4.5; offline fakes feed the
// code directly and this classifier is table-tested. Contract Error enum (contracts/troy_pool/src/lib.rs):
//   AlreadyProcessed=1, InsufficientBalance=2, Paused=3, NotAuthorized=4, InvalidAmount=5.

export type RevertCause = 'AlreadyProcessed' | 'BalanceGuard' | 'Other';

export type RevertEvent =
  | { readonly type: 'revertAlreadyProcessed' }
  | { readonly type: 'revertBalanceGuard' }
  | { readonly type: 'revertOther' };

export function classifyRevertCause(contractErrorCode: number | null): RevertCause {
  switch (contractErrorCode) {
    case 1:
      // Processed(tx_id) replay guard fired -> a PRIOR pay() already sent the USDC. Capture the TRY (D2a).
      return 'AlreadyProcessed';
    case 2:
      // InsufficientBalance guard -> clean, no USDC moved; seq already burned (D2b).
      return 'BalanceGuard';
    default:
      // paused / unauthorized / invalid-amount / unknown -> NEW seq + resubmit (D2c). Fail toward re-drive.
      return 'Other';
  }
}

export function revertEvent(cause: RevertCause): RevertEvent {
  switch (cause) {
    case 'AlreadyProcessed':
      return { type: 'revertAlreadyProcessed' };
    case 'BalanceGuard':
      return { type: 'revertBalanceGuard' };
    case 'Other':
      return { type: 'revertOther' };
  }
}
