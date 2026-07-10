// Public, non-secret parameters the adapter checks a SEP-7 request against.
//
// The ONE on-chain identifier here is Troia's USDC issuer, and it comes from `deployment.generated.ts`, which
// `just fund` rewrites from the deployment record. There is deliberately no merchant: which shop is being paid
// is the shop's business, and the shop declares it in its own payment request. The extension settles USDC — it
// does not keep a guest list.

import {
  BACKEND_BASE_URL as GENERATED_BACKEND,
  STOREFRONT_ORIGINS,
  USDC_ISSUER,
} from './deployment.generated';

export const BACKEND_BASE_URL = GENERATED_BACKEND;

/** The storefront origins the background worker will accept a message from. Enforced in `background.ts`; the
 *  manifest's port-less `matches` pattern is the coarser first gate, and this is the exact one. */
export const ALLOWED_ORIGINS = STOREFRONT_ORIGINS;

export const USDC_ASSET_CODE = 'USDC';

// The canonical USDC issuer(s) the extension is willing to settle. A SEP-7 whose asset_issuer is not in this
// list is NOT treated as payable (fail-closed): it blocks a spoofed "USDC" minted by a look-alike issuer.
export const USDC_ISSUER_ALLOWLIST: readonly string[] = [USDC_ISSUER];
