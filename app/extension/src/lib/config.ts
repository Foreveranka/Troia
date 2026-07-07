// Public, non-secret parameters the demo-storefront adapter checks a SEP-7 request against. These mirror the
// storefront's STORE config (a merchant address and the USDC issuer are public on-chain identifiers).

export const BACKEND_BASE_URL = 'http://localhost:3000';

export const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

export const USDC_ASSET_CODE = 'USDC';

// The canonical USDC issuer(s) the extension is willing to settle. A SEP-7 whose asset_issuer is not in this
// list is NOT treated as payable (fail-closed): it blocks a spoofed "USDC" minted by a look-alike issuer.
export const USDC_ISSUER_ALLOWLIST: readonly string[] = [
  'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W',
];

// The demo storefront's merchant (the SEP-7 destination we expect). Used only as a soft anti-phishing signal
// by the demo adapter — it raises confidence but is not a hard gate, so other merchants are not blocked.
export const DEMO_MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
