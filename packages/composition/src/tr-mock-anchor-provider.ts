/** Sandbox-only SEP-10/38/6 adapter. The collection account is separate from the payout operator,
 * so authentication/preparation never consumes a payout sequence. Pool replenishment stays manual. */
import { randomBytes } from 'node:crypto';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE, TESTNET_HORIZON_URL, TR_MOCK_ANCHOR } from '@troia/config';
import type { NetworkConfig } from '@troia/config';
import type {
  BankTransferProvider,
  BankTransferRequest,
  BankTransferInstructions,
  BankTransferObservation,
  Quote,
} from '@troia/backend';
import { parseBankInstructions } from '@troia/backend';
import { OrderDb } from './order-db.js';

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed anchor response');
  return value as Obj;
}
function units(value: unknown, decimals: number): bigint {
  if (typeof value !== 'string' || !new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error('Invalid anchor amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}
const decimal = (amount: bigint, places: number): string => {
  const scale = 10n ** BigInt(places);
  return `${amount / scale}.${(amount % scale).toString().padStart(places, '0')}`;
};
const asset = `stellar:USDC:${TR_MOCK_ANCHOR.issuer}`;
const PROVIDER = 'tr-mock-anchor';

export class TrMockAnchorProvider implements BankTransferProvider {
  readonly referenceMode = 'provider' as const;
  readonly account: string;
  private readonly key: Keypair;
  private readonly db: OrderDb;
  private token = '';
  private authInFlight: Promise<void> | undefined;
  private readonly creating = new Map<string, Promise<BankTransferInstructions>>();

  constructor(
    config: { network: NetworkConfig; secret: string; journalPath: string },
    private readonly doFetch: typeof fetch = fetch,
  ) {
    if (
      config.network.network !== 'testnet' ||
      config.network.passphrase !== TESTNET_PASSPHRASE ||
      config.network.usdc.issuer !== TR_MOCK_ANCHOR.issuer
    )
      throw new Error('TR Mock Anchor requires Stellar testnet and the test USDC issuer');
    this.key = Keypair.fromSecret(config.secret);
    this.account = this.key.publicKey();
    if ([config.network.operatorPublic, config.network.adminPublic].includes(this.account))
      throw new Error('Use a separate anchor collection account');
    this.db = new OrderDb(config.journalPath);
    this.db
      .run(`CREATE TABLE IF NOT EXISTS anchor_transfers (order_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
      quote_json TEXT, dispatched INTEGER NOT NULL DEFAULT 0, instructions_json TEXT, proof_json TEXT) STRICT`);
  }
  close(): void {
    this.db.close();
  }

  private async raw(url: string, init: RequestInit = {}): Promise<Obj> {
    const res = await this.doFetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Anchor request failed (${res.status})`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty anchor response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 256 * 1024) throw new Error('Anchor response too large');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  private async authenticate(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = (async () => {
      const ch = await this.raw(
        `${TR_MOCK_ANCHOR.baseUrl}/auth?${new URLSearchParams({ account: this.account, home_domain: TR_MOCK_ANCHOR.domain })}`,
      );
      if (ch.network_passphrase !== TESTNET_PASSPHRASE || typeof ch.transaction !== 'string')
        throw new Error('Anchor network mismatch');
      const parsed = WebAuth.readChallengeTx(
        ch.transaction,
        TR_MOCK_ANCHOR.signingKey,
        TESTNET_PASSPHRASE,
        TR_MOCK_ANCHOR.domain,
        TR_MOCK_ANCHOR.domain,
      );
      if (parsed.clientAccountID !== this.account)
        throw new Error('Anchor challenge account mismatch');
      const tx = TransactionBuilder.fromXDR(ch.transaction, TESTNET_PASSPHRASE);
      tx.sign(this.key);
      const result = await this.raw(`${TR_MOCK_ANCHOR.baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: tx.toXDR() }),
      });
      if (typeof result.token !== 'string' || !result.token)
        throw new Error('Missing anchor session');
      this.token = result.token;
    })();
    try {
      await this.authInFlight;
    } finally {
      this.authInFlight = undefined;
    }
  }
  private async request(path: string, body?: unknown): Promise<Obj> {
    if (!this.token) await this.authenticate();
    const send = () =>
      this.raw(`${TR_MOCK_ANCHOR.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'Anchor request failed (401)') throw e;
      await this.authenticate();
      return send();
    }
  }
  /** Startup read gate: no implicit funding/signing. Run the explicit sandbox preparation script first. */
  async checkReady(): Promise<void> {
    const health = await this.raw(`${TR_MOCK_ANCHOR.baseUrl}/health`);
    const a = object(health.asset);
    if (
      health.environment !== 'sandbox' ||
      health.network_passphrase !== TESTNET_PASSPHRASE ||
      a.issuer !== TR_MOCK_ANCHOR.issuer ||
      a.code !== 'USDC'
    )
      throw new Error('Anchor sandbox identity mismatch');
    const account = await this.raw(`${TESTNET_HORIZON_URL}/accounts/${this.account}`);
    if (
      !Array.isArray(account.balances) ||
      !account.balances.some((b) => {
        const row = object(b);
        return (
          row.asset_code === 'USDC' &&
          row.asset_issuer === TR_MOCK_ANCHOR.issuer &&
          row.is_authorized === true
        );
      })
    )
      throw new Error('Prepare the anchor collection account USDC trustline first');
    await this.authenticate();
  }
  async quote(amount: bigint): Promise<Quote> {
    if (amount <= 0n) throw new Error('Invalid bank quote amount');
    const q = await this.request(
      '/sep38/price?' +
        new URLSearchParams({
          sell_asset: 'iso4217:TRY',
          buy_asset: asset,
          buy_amount: decimal(amount, 7),
          context: 'sep6',
          sell_delivery_method: 'bank_account',
        }),
    );
    const sell = units(q.sell_amount, 7);
    const kuruş = (sell + 99999n) / 100000n;
    if (units(q.buy_amount, 7) !== amount || kuruş <= 0n || kuruş > 10000000n)
      throw new Error('Anchor quote mismatch or above sandbox limit');
    const rate = (kuruş * 1000000000000n + amount - 1n) / amount;
    return {
      userTryKurus: kuruş,
      paidPriceTry: decimal(kuruş, 2),
      appliedRateStroops: rate,
      oracleMidE7: rate,
      spreadBps: 0,
      spreadRevenueKurus: 0n,
      pspCostKurus: 0n,
    };
  }
  create(input: BankTransferRequest): Promise<BankTransferInstructions> {
    const existing = this.creating.get(input.orderId);
    if (existing) return existing;
    const work = this.createOnce(input).finally(() => this.creating.delete(input.orderId));
    this.creating.set(input.orderId, work);
    return work;
  }
  private async createOnce(input: BankTransferRequest): Promise<BankTransferInstructions> {
    if (input.expiresAtUnix <= Math.floor(Date.now() / 1000))
      throw new Error('Bank instructions expired');
    this.db.run(
      'INSERT OR IGNORE INTO anchor_transfers(order_id,request_json) VALUES (?,?)',
      input.orderId,
      JSON.stringify(input),
    );
    let row = this.db.get('SELECT * FROM anchor_transfers WHERE order_id=?', input.orderId)!;
    if (row.request_json !== JSON.stringify(input)) throw new Error('Anchor order conflict');
    if (typeof row.instructions_json === 'string')
      return parseBankInstructions(JSON.parse(row.instructions_json));
    if (row.quote_json === null) {
      const q = await this.request('/sep38/quote', {
        sell_asset: 'iso4217:TRY',
        buy_asset: asset,
        sell_amount: input.amountTry,
        context: 'sep6',
        sell_delivery_method: 'bank_account',
      });
      if (
        typeof q.id !== 'string' ||
        q.sell_asset !== 'iso4217:TRY' ||
        q.buy_asset !== asset ||
        units(q.sell_amount, 2) !== units(input.amountTry, 2) ||
        units(q.buy_amount, 7) <= 0n
      )
        throw new Error('Anchor firm quote mismatch');
      const expires = Math.floor(Date.parse(String(q.expires_at)) / 1000);
      if (
        input.minimumUsdcStroops !== undefined &&
        units(q.buy_amount, 7) < BigInt(input.minimumUsdcStroops)
      )
        throw new Error('Anchor rate changed; quoted funds would not cover merchant');
      if (!Number.isSafeInteger(expires) || expires < input.expiresAtUnix)
        throw new Error('Anchor quote expires before payment deadline');
      this.db.run(
        'UPDATE anchor_transfers SET quote_json=? WHERE order_id=? AND quote_json IS NULL',
        JSON.stringify(q),
        input.orderId,
      );
      row = this.db.get('SELECT * FROM anchor_transfers WHERE order_id=?', input.orderId)!;
    }
    const quote = object(JSON.parse(String(row.quote_json)));
    let dep: Obj;
    const claimed = this.db.run(
      'UPDATE anchor_transfers SET dispatched=1 WHERE order_id=? AND dispatched=0',
      input.orderId,
    );
    if (claimed !== 1) {
      // SEP-6 does not promise create idempotency. Recover ONLY by the durable firm quote ID;
      // absence/ambiguous history holds the order, never creates another bank transfer.
      const history = await this.request('/sep6/transactions?asset_code=USDC&limit=100');
      const matches = Array.isArray(history.transactions)
        ? history.transactions.filter((t) => object(t).quote_id === quote.id)
        : [];
      if (matches.length !== 1)
        throw new Error('Anchor create outcome unknown; reconcile before retrying');
      dep = object(matches[0]);
    } else {
      dep = await this.request(
        '/sep6/deposit-exchange?' +
          new URLSearchParams({
            destination_asset: 'USDC',
            source_asset: 'iso4217:TRY',
            asset_code: 'USDC',
            asset_issuer: TR_MOCK_ANCHOR.issuer,
            account: this.account,
            amount: input.amountTry,
            quote_id: String(quote.id),
            funding_method: 'bank_account',
            type: 'bank_account',
            claimable_balance_supported: 'false',
          }),
      );
    }
    const fields = object(dep.instructions);
    const details = parseBankInstructions({
      providerId: PROVIDER,
      transferId: dep.id,
      orderId: input.orderId,
      reference: object(fields.external_transfer_memo).value,
      iban: object(fields.bank_account_number).value,
      beneficiary: TR_MOCK_ANCHOR.beneficiary,
      amountTry: input.amountTry,
      currency: 'TRY',
      expiresAtUnix: input.expiresAtUnix,
      sandboxToken: randomBytes(32).toString('hex'),
    });
    this.db.run(
      'UPDATE anchor_transfers SET instructions_json=? WHERE order_id=? AND instructions_json IS NULL',
      JSON.stringify(details),
      input.orderId,
    );
    return parseBankInstructions(
      JSON.parse(
        String(
          this.db.get(
            'SELECT instructions_json FROM anchor_transfers WHERE order_id=?',
            input.orderId,
          )!.instructions_json,
        ),
      ),
    );
  }
  private bound(details: BankTransferInstructions): Obj {
    const row = this.db.get('SELECT * FROM anchor_transfers WHERE order_id=?', details.orderId);
    if (!row || row.instructions_json !== JSON.stringify(details))
      throw new Error('Anchor transfer binding mismatch');
    return row;
  }
  async simulate(details: BankTransferInstructions): Promise<void> {
    this.bound(details);
    if (details.expiresAtUnix <= Math.floor(Date.now() / 1000))
      throw new Error('Sandbox transfer expired');
    const tx = object(
      (await this.request('/sep6/transaction?id=' + encodeURIComponent(details.transferId)))
        .transaction,
    );
    if (tx.status !== 'pending_user_transfer_start') return; // repeated click never starts another deposit
    await this.request(
      `/sep6/tx/${encodeURIComponent(details.transferId)}/simulate-bank-transfer`,
      { amount: details.amountTry },
    );
  }
  async retrieve(details: BankTransferInstructions): Promise<BankTransferObservation> {
    const row = this.bound(details);
    const q = object(JSON.parse(String(row.quote_json)));
    const t = object(
      (await this.request('/sep6/transaction?id=' + encodeURIComponent(details.transferId)))
        .transaction,
    );
    const observation = (
      status: BankTransferObservation['status'],
      receivedAtUnix?: number,
    ): BankTransferObservation => ({
      providerId: PROVIDER,
      transferId: details.transferId,
      orderId: details.orderId,
      reference: details.reference,
      amountTry: details.amountTry,
      currency: 'TRY',
      status,
      ...(receivedAtUnix === undefined ? {} : { receivedAtUnix }),
    });
    if (
      t.id !== details.transferId ||
      t.kind !== 'deposit' ||
      t.quote_id !== q.id ||
      t.to !== this.account ||
      t.external_transaction_id !== details.reference
    )
      return observation('review');
    if (
      ['pending_user_transfer_start', 'pending_anchor', 'pending_trust'].includes(String(t.status))
    )
      return observation('pending');
    if (
      t.status !== 'completed' ||
      t.amount_in_asset !== 'iso4217:TRY' ||
      t.amount_out_asset !== asset ||
      units(t.amount_in, 2) !== units(details.amountTry, 2) ||
      units(t.amount_out, 7) !== units(q.buy_amount, 7) ||
      t.refunded === true ||
      typeof t.stellar_transaction_id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(t.stellar_transaction_id)
    )
      return observation('review');
    const hash = t.stellar_transaction_id;
    const chain = await this.raw(`${TESTNET_HORIZON_URL}/transactions/${hash}`);
    const payments = object(
      object(await this.raw(`${TESTNET_HORIZON_URL}/transactions/${hash}/operations?limit=100`))
        ._embedded,
    ).records;
    const at = Math.floor(Date.parse(String(chain.created_at)) / 1000);
    const exact =
      Array.isArray(payments) &&
      payments.some((value) => {
        const p = object(value);
        return (
          p.type === 'payment' &&
          p.transaction_successful === true &&
          p.from === TR_MOCK_ANCHOR.treasury &&
          p.to === this.account &&
          p.asset_code === 'USDC' &&
          p.asset_issuer === TR_MOCK_ANCHOR.issuer &&
          units(p.amount, 7) === units(t.amount_out, 7)
        );
      });
    if (
      chain.successful !== true ||
      chain.hash !== hash ||
      !exact ||
      !Number.isSafeInteger(at) ||
      at > details.expiresAtUnix ||
      at > Math.floor(Date.now() / 1000)
    )
      return observation('review');
    // One chain credit cannot authorize two orders, even if the anchor returns inconsistent history.
    this.db.run(
      'CREATE TABLE IF NOT EXISTS anchor_receipts (hash TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE) STRICT',
    );
    this.db.run(
      'INSERT OR IGNORE INTO anchor_receipts(hash,order_id) VALUES (?,?)',
      hash,
      details.orderId,
    );
    if (
      this.db.get('SELECT order_id FROM anchor_receipts WHERE hash=?', hash)?.order_id !==
      details.orderId
    )
      return observation('review');
    this.db.run(
      'UPDATE anchor_transfers SET proof_json=? WHERE order_id=?',
      JSON.stringify({ anchorTransaction: t, stellarHash: hash }),
      details.orderId,
    );
    return observation('received', at);
  }
  async refund(_details: BankTransferInstructions): Promise<'pending'> {
    // The mock has no original-payer refund API. Never label a simulated withdrawal as a refund.
    return 'pending';
  }
}
