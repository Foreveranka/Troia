// PURE: a landed-and-reverted USDC tx's on-chain result -> the core revert-cause event. The exact TroyPool
// contract error codes are confirmed against the deployed contract in Phase 4.4/4.5; offline fakes feed the
// code directly and this classifier is table-tested. Contract Error enum (contracts/troy_pool/src/lib.rs):
//   AlreadyProcessed=1, InsufficientBalance=2, Paused=3, NotAuthorized=4, InvalidAmount=5.

export type RevertCause = 'AlreadyProcessed' | 'BalanceGuard' | 'Indeterminate';

export type RevertEvent =
  | { readonly type: 'revertAlreadyProcessed' }
  | { readonly type: 'revertBalanceGuard' }
  | { readonly type: 'revertIndeterminate'; readonly retriesRemaining: boolean };

export function classifyRevertCause(contractErrorCode: number | null): RevertCause {
  switch (contractErrorCode) {
    case 1:
      // Processed(tx_id) replay guard fired -> a PRIOR pay() already sent the USDC. Capture the TRY (D2a).
      return 'AlreadyProcessed';
    case 2:
      // InsufficientBalance — checked AFTER the on-chain replay guard, so the tx provably PASSED it (no prior
      // settlement) and did not transfer: USDC provably did not move. Clean void of the completed sale (D2b).
      return 'BalanceGuard';
    default:
      // Only codes 1 and 2 are CERTAIN (both are checked at/after the replay guard). EVERYTHING else is
      // Indeterminate: Paused(3)/InvalidAmount(5) are checked BEFORE the replay guard, so they cannot rule out a
      // prior settlement; NotAuthorized surfaces as a host require_auth failure (null); an unreadable code (RPC
      // timeout / non-FAILED status / missing diagnostics) or an unknown code is equally uncertain. We CANNOT
      // confirm USDC did not move, so we NEVER auto-void (that could over-refund a settled order). Retry under a
      // BUDGET (a transient read or an unpause may clear it); on exhaustion the reducer escalates to LossReview (D2c).
      return 'Indeterminate';
  }
}

/** The two CERTAIN, budget-free revert causes → their core events. 'Indeterminate' is budgeted (a retry counter),
 *  so its event is built at the confirmBurnedSeq effect site (perform.ts) where the counter is bumped — not here. */
export function revertEvent(cause: 'AlreadyProcessed' | 'BalanceGuard'): RevertEvent {
  switch (cause) {
    case 'AlreadyProcessed':
      return { type: 'revertAlreadyProcessed' };
    case 'BalanceGuard':
      return { type: 'revertBalanceGuard' };
    default: {
      // Fail-closed: 'Indeterminate' is budgeted and its event is built at the perform site, never here. The
      // `never` binding also makes a future added cause a COMPILE error rather than a silent undefined-return
      // (which the driver would treat as "no event" and strand the order in UsdcReverted).
      const _exhaustive: never = cause;
      throw new Error(
        `revertEvent: budgeted/unknown cause reached the certain-cause factory: ${String(_exhaustive)}`,
      );
    }
  }
}
