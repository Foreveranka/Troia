// SEP-7 (`web+stellar:pay?...`) parsing. The URI is NOT a standard hierarchical URL (there is no `//`
// authority), so it is parsed by hand: strip the `web+stellar:` scheme, require the `pay` operation, and read
// the query parameters. Read-only and total — malformed input returns null, never throws.

export interface Sep7Pay {
  readonly operation: 'pay';
  readonly destination: string;
  readonly amount: string;
  readonly assetCode: string | null; // null => native (XLM)
  readonly assetIssuer: string | null;
  readonly memo: string | null;
  readonly memoType: string | null;
}

const SCHEME = 'web+stellar:';

export function parseSep7(uri: string): Sep7Pay | null {
  if (!uri.startsWith(SCHEME)) return null;
  const rest = uri.slice(SCHEME.length);
  const q = rest.indexOf('?');
  const operation = q === -1 ? rest : rest.slice(0, q);
  if (operation !== 'pay') return null;

  const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
  const destination = params.get('destination');
  const amount = params.get('amount');
  if (destination === null || destination.length === 0 || amount === null || amount.length === 0)
    return null;

  return {
    operation: 'pay',
    destination,
    amount,
    assetCode: params.get('asset_code'),
    assetIssuer: params.get('asset_issuer'),
    memo: params.get('memo'),
    memoType: params.get('memo_type'),
  };
}
