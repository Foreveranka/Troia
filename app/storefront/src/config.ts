// Store payment config + a realistic crypto-gateway model. This store receives USDC natively on Stellar at
// MERCHANT. The crypto checkout mimics a real gateway (choose coin -> choose network -> pay to an address), and
// when the shopper picks USDC on Stellar it renders a standard SEP-7 request that a browser extension can act on.

import { USDC_ISSUER } from './deployment.generated';

export const STORE = {
  name: 'STORE',
  // This shop's own payee. Troia never records it: the shop declares its destination in the SEP-7 request.
  merchant: 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX',
  usdcCode: 'USDC',
  usdcIssuer: USDC_ISSUER,
} as const;

/** A short, human order reference — used as the on-chain payment memo. */
export function orderRef(): string {
  return (
    'ST-' +
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Math.random().toString(36).slice(2, 4).toUpperCase()
  );
}

/** Build a SEP-7 (`web+stellar:pay`) payment request URI. Defaults to a USDC payment; pass 'native' for XLM. */
export function buildSep7(
  amount: string,
  memo: string,
  asset: 'native' | { code: string; issuer: string } = {
    code: STORE.usdcCode,
    issuer: STORE.usdcIssuer,
  },
): string {
  const params = new URLSearchParams({
    destination: STORE.merchant,
    amount,
    memo,
    memo_type: 'text',
  });
  if (asset !== 'native') {
    params.set('asset_code', asset.code);
    params.set('asset_issuer', asset.issuer);
  }
  return `web+stellar:pay?${params.toString()}`;
}

export function shortAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

// ---- crypto gateway model ----
export interface CryptoNetwork {
  readonly id: string;
  readonly name: string;
  readonly addr: string;
  readonly needsMemo?: boolean;
}
export interface Coin {
  readonly code: string;
  readonly name: string;
  readonly color: string;
  readonly rate: number; // mock USD price per unit (for the demo conversion)
  readonly networks: readonly CryptoNetwork[];
}

// Demo deposit addresses (stub for non-Stellar chains; the real store merchant for Stellar).
const A = {
  btc: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  eth: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  sol: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  tron: 'TQn9Y2khDD95J42FQtQTdwVVR93bxg3jd3',
  xlm: STORE.merchant,
};

export const COINS: readonly Coin[] = [
  {
    code: 'BTC',
    name: 'Bitcoin',
    color: '#f7931a',
    rate: 95000,
    networks: [{ id: 'bitcoin', name: 'Bitcoin', addr: A.btc }],
  },
  {
    code: 'ETH',
    name: 'Ethereum',
    color: '#627eea',
    rate: 3400,
    networks: [{ id: 'ethereum', name: 'Ethereum', addr: A.eth }],
  },
  {
    code: 'USDT',
    name: 'Tether',
    color: '#26a17b',
    rate: 1,
    networks: [
      { id: 'ethereum', name: 'Ethereum (ERC-20)', addr: A.eth },
      { id: 'tron', name: 'Tron (TRC-20)', addr: A.tron },
      { id: 'bsc', name: 'BNB Smart Chain', addr: A.eth },
      { id: 'solana', name: 'Solana', addr: A.sol },
    ],
  },
  {
    code: 'USDC',
    name: 'USD Coin',
    color: '#2775ca',
    rate: 1,
    networks: [
      { id: 'ethereum', name: 'Ethereum', addr: A.eth },
      { id: 'solana', name: 'Solana', addr: A.sol },
      { id: 'polygon', name: 'Polygon', addr: A.eth },
      { id: 'base', name: 'Base', addr: A.eth },
      { id: 'stellar', name: 'Stellar', addr: A.xlm, needsMemo: true },
    ],
  },
  {
    code: 'SOL',
    name: 'Solana',
    color: '#14f195',
    rate: 185,
    networks: [{ id: 'solana', name: 'Solana', addr: A.sol }],
  },
  {
    code: 'XLM',
    name: 'Stellar',
    color: '#7d5cff',
    rate: 0.38,
    networks: [{ id: 'stellar', name: 'Stellar', addr: A.xlm, needsMemo: true }],
  },
  {
    code: 'BNB',
    name: 'BNB',
    color: '#f3ba2f',
    rate: 620,
    networks: [{ id: 'bsc', name: 'BNB Smart Chain', addr: A.eth }],
  },
];

/** The crypto amount for a USD total, formatted per coin. */
export function cryptoAmount(usdTotal: number, rate: number): string {
  const a = usdTotal / rate;
  if (rate === 1) return a.toFixed(2); // stablecoin
  return a.toFixed(a >= 1 ? 5 : 6).replace(/\.?0+$/, '');
}
