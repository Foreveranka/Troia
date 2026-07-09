// PURE mapping from a Horizon account response into the @troia/core AccountSnapshot that PayoutIntent.build
// consumes. Keeping it pure lets the destination-preflight (trustline check) run offline against a fixture.
// A null response (account not found) maps to a fail-closed snapshot (exists:false, no trustlines).

import type { AccountSnapshotJson } from './ports.js';

/** Structural mirror of @troia/core's AccountSnapshot (not imported to keep the package dependency-light;
 *  the account-snapshot test asserts it feeds PayoutIntent.build without a type error). */
export interface CoreAccountSnapshot {
  readonly exists: boolean;
  readonly trustlines: readonly { readonly assetCode: string; readonly assetIssuer: string }[];
}

const CREDIT_ASSET_TYPES: ReadonlySet<string> = new Set(['credit_alphanum4', 'credit_alphanum12']);

export function toAccountSnapshot(json: AccountSnapshotJson | null): CoreAccountSnapshot {
  if (json === null) return { exists: false, trustlines: [] };

  const trustlines = json.balances
    .filter(
      (b) => CREDIT_ASSET_TYPES.has(b.asset_type) && b.asset_code != null && b.asset_issuer != null,
    )
    .map((b) => ({ assetCode: b.asset_code as string, assetIssuer: b.asset_issuer as string }));

  return { exists: true, trustlines };
}
