// The demo-storefront adapter: it locates a SEP-7 request in the page DOM and scores it against a set of
// checks. The banner is offered ONLY when every REQUIRED check passes (fail-closed) — the soft "known
// merchant" check just raises the confidence number. This is deliberately per-gateway: another store would
// get its own adapter with its own DOM locator, while the money-safety checks below stay the same.

import { parseSep7, type Sep7Pay } from './sep7';
import { isValidStellarPublicKey } from './strkey';
import { USDC_ASSET_CODE, USDC_ISSUER_ALLOWLIST, DEMO_MERCHANT } from './config';

export interface DetectionCheck {
  readonly id: string;
  readonly label: string;
  readonly pass: boolean;
  readonly required: boolean;
}

export interface Detection {
  readonly sep7: Sep7Pay;
  readonly checks: readonly DetectionCheck[];
  readonly confidence: number; // fraction of all checks that passed, 0..1
  readonly payable: boolean; // every REQUIRED check passed — the fail-closed gate for showing the banner
}

/** Locate the SEP-7 pay URI on the page, if present. The storefront renders it as the "Open in wallet"
 *  anchor on the USDC-on-Stellar pay step; we read that href and never the QR image. */
export function findSep7Uri(root: ParentNode = document): string | null {
  const anchor = root.querySelector<HTMLAnchorElement>('a[href^="web+stellar:pay"]');
  return anchor?.getAttribute('href') ?? null;
}

/** Parse + score a SEP-7 URI. Returns null only when the string is not a SEP-7 pay request at all. */
export function evaluate(uri: string): Detection | null {
  const sep7 = parseSep7(uri);
  if (sep7 === null) return null;

  const amountNum = Number(sep7.amount);
  const checks: readonly DetectionCheck[] = [
    { id: 'op', label: 'SEP-7 pay operation', pass: sep7.operation === 'pay', required: true },
    { id: 'asset', label: 'Asset is USDC', pass: sep7.assetCode === USDC_ASSET_CODE, required: true },
    {
      id: 'issuer',
      label: 'Issuer is trusted',
      pass: sep7.assetIssuer !== null && USDC_ISSUER_ALLOWLIST.includes(sep7.assetIssuer),
      required: true,
    },
    {
      id: 'destination',
      label: 'Destination is a valid Stellar address',
      pass: isValidStellarPublicKey(sep7.destination),
      required: true,
    },
    { id: 'amount', label: 'Amount is positive', pass: Number.isFinite(amountNum) && amountNum > 0, required: true },
    { id: 'memo', label: 'Payment reference present', pass: sep7.memo !== null && sep7.memo.length > 0, required: true },
    { id: 'merchant', label: 'Known merchant', pass: sep7.destination === DEMO_MERCHANT, required: false },
  ];

  const passed = checks.filter((c) => c.pass).length;
  const confidence = passed / checks.length;
  const payable = checks.every((c) => !c.required || c.pass);
  return { sep7, checks, confidence, payable };
}
