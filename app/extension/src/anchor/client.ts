import {
  Asset,
  Horizon,
  Memo,
  Operation,
  StellarToml,
  StrKey,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk';
import { ANCHOR } from './config';

export type Direction = 'deposit' | 'withdraw';
export type Signer = (xdr: string) => Promise<string>;
export interface Quote {
  id: string;
  expires_at: string;
  sell_amount: string;
  buy_amount: string;
  sell_asset: string;
  buy_asset: string;
  total_price: string;
  fee: { total: string; asset: string };
}
export interface AnchorTransaction {
  id: string;
  kind: string;
  status: string;
  amount_in?: string;
  amount_out?: string;
  amount_in_asset?: string;
  amount_out_asset?: string;
  message?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  more_info_url?: string;
  claimable_balance_id?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  started_at?: string;
  deposit_memo?: string;
  instructions?: Record<string, { value: string; description: string }>;
}
export interface Instructions {
  id: string;
  account_id?: string;
  memo?: string;
  memo_type?: string;
  how?: string;
  more_info_url?: string;
  instructions?: Record<string, { value: string; description: string }>;
}
interface Capability {
  enabled: boolean;
  min_amount?: number;
  max_amount?: number;
}
interface Discovery {
  auth: string;
  transfer: string;
  quote: string;
  kyc: string;
  signingKey: string;
}
export class AnchorError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}
export function units(value: string, decimals: number): bigint {
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error('Enter a valid amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}
export function checkedAmount(value: string, decimals: number): string {
  const normalized = value.trim().replace(',', '.');
  if (units(normalized, decimals) <= 0n) throw new Error('Amount must be greater than zero.');
  return normalized;
}
export function quoteIsLive(q: Quote, now = Date.now()): boolean {
  return Number.isFinite(Date.parse(q.expires_at)) && Date.parse(q.expires_at) > now + 5000;
}
export function trustedLink(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === ANCHOR.domain && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function statusLabel(s: string): string {
  return (
    (
      {
        pending_user_transfer_start: 'Waiting for your transfer',
        pending_anchor: 'Processing at anchor',
        pending_stellar: 'Confirming on Stellar',
        pending_external: 'Bank payout pending',
        pending_trust: 'USDC trustline required',
        pending_customer_info_update: 'Customer information required',
        pending_transaction_info_update: 'Transfer information required',
        pending_user: 'Action required',
        on_hold: 'Under review',
        incomplete: 'Setup incomplete',
        completed: 'Completed',
        refunded: 'Refunded',
        expired: 'Expired',
        error: 'Failed',
        no_market: 'Conversion unavailable',
        too_small: 'Below minimum',
        too_large: 'Above maximum',
      } as Record<string, string>
    )[s] ?? `Awaiting update (${s})`
  );
}
export class AnchorClient {
  readonly horizon = new Horizon.Server(ANCHOR.horizon);
  readonly asset = new Asset('USDC', ANCHOR.issuer);
  private discovery!: Discovery;
  private token = '';
  private refreshing: Promise<void> | undefined;
  capabilities: Record<string, Record<string, Capability>> = {};
  readonly account: string;
  private readonly sign: Signer;
  constructor(account: string, sign: Signer) {
    this.account = account;
    this.sign = sign;
    if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('Invalid Stellar account.');
  }
  private async http<T>(url: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const request = () =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20000),
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
          ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
    let r = await request();
    if (r.status === 401 && authenticated) {
      await this.authenticate();
      r = await request();
    }
    const body = await r.json();
    if (!r.ok)
      throw new AnchorError(
        typeof body.error === 'string'
          ? body.error
          : (body.error?.message ?? `Anchor request failed (${r.status}).`),
        r.status,
      );
    return body as T;
  }
  async connect(): Promise<void> {
    const toml = await StellarToml.Resolver.resolve(ANCHOR.domain, { timeout: 15000 });
    if (toml.NETWORK_PASSPHRASE !== ANCHOR.passphrase)
      throw new Error('Only Stellar testnet is supported.');
    if (!toml.CURRENCIES?.some((c) => c.code === 'USDC' && c.issuer === ANCHOR.issuer))
      throw new Error('Anchor USDC issuer mismatch.');
    const endpoint = (s: unknown): string => {
      if (typeof s !== 'string' || !trustedLink(s)) throw new Error('Untrusted anchor endpoint.');
      return s.replace(/\/$/, '');
    };
    if (!toml.SIGNING_KEY || !StrKey.isValidEd25519PublicKey(toml.SIGNING_KEY))
      throw new Error('Invalid anchor signing key.');
    this.discovery = {
      auth: endpoint(toml.WEB_AUTH_ENDPOINT),
      transfer: endpoint(toml.TRANSFER_SERVER),
      quote: endpoint(toml.ANCHOR_QUOTE_SERVER),
      kyc: endpoint(toml.KYC_SERVER),
      signingKey: toml.SIGNING_KEY,
    };
    this.capabilities = await this.http(`${this.discovery.transfer}/info`, {}, false);
    await this.authenticate();
  }
  private async authenticate(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const d = this.discovery;
      const ch = await this.http<{ transaction: string; network_passphrase: string }>(
        `${d.auth}?${new URLSearchParams({ account: this.account, home_domain: ANCHOR.domain })}`,
        {},
        false,
      );
      if (ch.network_passphrase !== ANCHOR.passphrase)
        throw new Error('Authentication network mismatch.');
      const parsed = WebAuth.readChallengeTx(
        ch.transaction,
        d.signingKey,
        ANCHOR.passphrase,
        ANCHOR.domain,
        new URL(d.auth).hostname,
      );
      if (parsed.clientAccountID !== this.account)
        throw new Error('Authentication account mismatch.');
      const signed = await this.sign(ch.transaction);
      const original = TransactionBuilder.fromXDR(ch.transaction, ANCHOR.passphrase);
      const returned = TransactionBuilder.fromXDR(signed, ANCHOR.passphrase);
      if (!original.hash().every((byte, i) => byte === returned.hash()[i]))
        throw new Error('Wallet changed the authentication challenge.');
      // The challenge is never submitted to Horizon.
      const result = await this.http<{ token: string }>(
        d.auth,
        { method: 'POST', body: JSON.stringify({ transaction: signed }) },
        false,
      );
      if (!result.token) throw new Error('Anchor returned no session.');
      this.token = result.token;
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  async balances() {
    const a = await this.horizon.loadAccount(this.account);
    const b = a.balances.find(
      (x) => 'asset_code' in x && x.asset_code === 'USDC' && x.asset_issuer === ANCHOR.issuer,
    );
    return {
      usdc: b?.balance ?? '0.0000000',
      trusted: !!b,
      xlm: a.balances.find((x) => x.asset_type === 'native')?.balance ?? '0',
    };
  }
  async submit(
    build: (builder: TransactionBuilder) => TransactionBuilder,
    beforeBroadcast?: () => void,
  ) {
    const account = await this.horizon.loadAccount(this.account);
    const tx = build(
      new TransactionBuilder(account, { fee: '10000', networkPassphrase: ANCHOR.passphrase }),
    )
      .setTimeout(120)
      .build();
    const signed = TransactionBuilder.fromXDR(await this.sign(tx.toXDR()), ANCHOR.passphrase);
    if (!tx.hash().every((byte, i) => byte === signed.hash()[i]))
      throw new Error('Wallet changed the transaction.');
    beforeBroadcast?.();
    return this.horizon.submitTransaction(signed);
  }
  async prepareWallet(): Promise<void> {
    try {
      await this.horizon.loadAccount(this.account);
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status !== 404) throw e;
      const r = await fetch(`${ANCHOR.friendbot}?addr=${this.account}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error('Test XLM funding unavailable. Try again shortly.');
    }
    if (!(await this.balances()).trusted)
      await this.submit((b) => b.addOperation(Operation.changeTrust({ asset: this.asset })));
  }
  async quote(direction: Direction, rawAmount: string): Promise<Quote> {
    if (!this.capabilities[direction]?.USDC?.enabled)
      throw new Error('This anchor flow is currently disabled.');
    const amount = checkedAmount(rawAmount, direction === 'deposit' ? 2 : 7);
    const usdc = `stellar:USDC:${ANCHOR.issuer}`;
    const q = await this.http<Quote>(`${this.discovery.quote}/quote`, {
      method: 'POST',
      body: JSON.stringify({
        sell_asset: direction === 'deposit' ? 'iso4217:TRY' : usdc,
        buy_asset: direction === 'deposit' ? usdc : 'iso4217:TRY',
        sell_amount: amount,
        context: 'sep6',
        ...(direction === 'deposit'
          ? { sell_delivery_method: 'bank_account' }
          : { buy_delivery_method: 'bank_account' }),
      }),
    });
    const expectedSell = direction === 'deposit' ? 'iso4217:TRY' : usdc;
    const expectedBuy = direction === 'deposit' ? usdc : 'iso4217:TRY';
    if (
      q.sell_asset !== expectedSell ||
      q.buy_asset !== expectedBuy ||
      units(q.sell_amount, 7) !== units(amount, 7) ||
      !quoteIsLive(q)
    )
      throw new Error('Invalid or expired quote. Request a new quote.');
    return q;
  }
  async start(direction: Direction, q: Quote): Promise<Instructions> {
    if (!quoteIsLive(q)) throw new Error('Quote expired. Request a new quote.');
    // Exchange endpoints bind the SEP-38 quote; ordinary deposit/withdraw may reprice it.
    const params = new URLSearchParams({
      asset_code: 'USDC',
      asset_issuer: ANCHOR.issuer,
      account: this.account,
      amount: q.sell_amount,
      quote_id: q.id,
      source_asset: q.sell_asset,
      destination_asset: q.buy_asset,
      funding_method: 'bank_account',
      type: 'bank_account',
      claimable_balance_supported: 'false',
    });
    if (direction === 'withdraw') {
      const balance = await this.balances();
      if (units(balance.usdc, 7) < units(q.sell_amount, 7))
        throw new Error('Insufficient testnet USDC.');
    }
    return this.http(`${this.discovery.transfer}/${direction}-exchange?${params}`);
  }
  async history(): Promise<AnchorTransaction[]> {
    const r = await this.http<{ transactions: AnchorTransaction[] }>(
      `${this.discovery.transfer}/transactions?asset_code=USDC&limit=30`,
    );
    return r.transactions;
  }
  async transaction(id: string): Promise<AnchorTransaction> {
    const r = await this.http<{ transaction: AnchorTransaction }>(
      `${this.discovery.transfer}/transaction?${new URLSearchParams({ id })}`,
    );
    return r.transaction;
  }
  async simulate(id: string, amount: string): Promise<void> {
    const current = await this.transaction(id);
    if (!current.kind.startsWith('deposit') || current.status !== 'pending_user_transfer_start')
      throw new Error('This deposit is not waiting for a bank transfer. Refresh its status.');
    await this.http(
      `${this.discovery.transfer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`,
      { method: 'POST', body: JSON.stringify({ amount }) },
    );
  }
  async payWithdrawal(i: Instructions, amount: string, beforeBroadcast?: () => void) {
    const current = await this.transaction(i.id);
    if (!current.kind.startsWith('withdraw') || current.status !== 'pending_user_transfer_start')
      throw new Error('Withdrawal already processing. Refresh its status.');
    if (
      !i.account_id ||
      !StrKey.isValidEd25519PublicKey(i.account_id) ||
      i.memo_type !== 'id' ||
      !/^\d+$/.test(String(i.memo))
    )
      throw new Error('Invalid withdrawal destination or memo.');
    return this.submit(
      (b) =>
        b
          .addOperation(
            Operation.payment({
              destination: i.account_id!,
              asset: this.asset,
              amount: checkedAmount(amount, 7),
            }),
          )
          .addMemo(Memo.id(String(i.memo))),
      beforeBroadcast,
    );
  }
}
