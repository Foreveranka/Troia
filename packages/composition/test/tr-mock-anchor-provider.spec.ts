import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testnetConfig, TR_MOCK_ANCHOR } from '@troia/config';
import { TrMockAnchorProvider } from '../src/tr-mock-anchor-provider.js';

const secret = Keypair.random().secret();
const account = Keypair.fromSecret(secret).publicKey();
const network = testnetConfig({
  usdcIssuer: TR_MOCK_ANCHOR.issuer,
  usdcSacContractId: 'test-sac',
  troyPool: 'test-pool',
  operatorPublic: Keypair.random().publicKey(),
  adminPublic: Keypair.random().publicKey(),
});
const asset = `stellar:USDC:${TR_MOCK_ANCHOR.issuer}`;
const expiry = Math.floor(Date.now() / 1000) + 900;
const request = {
  orderId: 'bank-1',
  idempotencyKey: 'a'.repeat(64),
  reference: 'TROIA-A',
  amountTry: '49.71',
  currency: 'TRY' as const,
  expiresAtUnix: expiry,
  minimumUsdcStroops: '10000000',
};
const transaction = {
  id: 'sep_test',
  kind: 'deposit',
  quote_id: 'q-1',
  to: account,
  external_transaction_id: 'TRMA-TEST-1',
  status: 'completed',
  amount_in: '49.71',
  amount_in_asset: 'iso4217:TRY',
  amount_out: '1.0001000',
  amount_out_asset: asset,
  stellar_transaction_id: 'a'.repeat(64),
  refunded: false,
  instructions: {
    bank_account_number: { value: 'TR050009900000000000000001' },
    external_transfer_memo: { value: 'TRMA-TEST-1' },
  },
};
const dirs: string[] = [];
const providers: TrMockAnchorProvider[] = [];
afterEach(() => {
  providers.splice(0).forEach((p) => p.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'troia-anchor-'));
  dirs.push(dir);
  let tx = { ...transaction };
  let chainSuccess = true;
  let ambiguous = false;
  let delivered = false;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/sep38/quote')
      return Response.json({
        id: 'q-1',
        sell_asset: 'iso4217:TRY',
        buy_asset: asset,
        sell_amount: request.amountTry,
        buy_amount: '1.0001000',
        expires_at: new Date((expiry + 900) * 1000).toISOString(),
      });
    if (path === '/sep38/price')
      return Response.json({ sell_amount: '49.7010000', buy_amount: '1.0000000' });
    if (path === '/sep6/deposit-exchange') {
      delivered = true;
      if (ambiguous) throw new Error('response lost');
      return Response.json(tx);
    }
    if (path === '/sep6/transactions')
      return Response.json({ transactions: delivered ? [tx] : [] });
    if (path === '/sep6/transaction') return Response.json({ transaction: tx });
    if (path.endsWith('/operations'))
      return Response.json({
        _embedded: {
          records: [
            {
              type: 'payment',
              transaction_successful: chainSuccess,
              from: TR_MOCK_ANCHOR.treasury,
              to: account,
              asset_code: 'USDC',
              asset_issuer: TR_MOCK_ANCHOR.issuer,
              amount: '1.0001000',
            },
          ],
        },
      });
    if (path.includes('/transactions/'))
      return Response.json({
        successful: chainSuccess,
        hash: transaction.stellar_transaction_id,
        created_at: new Date().toISOString(),
      });
    if (path.endsWith('/simulate-bank-transfer')) return Response.json({ ok: true });
    throw new Error('Unexpected URL ' + path);
  });
  const config = { network, secret, journalPath: join(dir, 'anchor.db') };
  const make = () => {
    const p = new TrMockAnchorProvider(config, fetcher as typeof fetch);
    (p as unknown as { token: string }).token = 'test-only';
    providers.push(p);
    return p;
  };
  return {
    make,
    fetcher,
    setTransaction: (patch: Partial<typeof transaction>) => {
      tx = { ...tx, ...patch };
    },
    setChain: (ok: boolean) => {
      chainSuccess = ok;
    },
    loseResponse: () => {
      ambiguous = true;
    },
  };
}
describe('TR Mock Anchor merchant adapter', () => {
  it('rejects mainnet, wrong assets and payout-operator key reuse', () => {
    const h = harness();
    const invalids = [
      { ...network, network: 'mainnet' as const },
      { ...network, usdc: { ...network.usdc, issuer: 'wrong' } },
      { ...network, operatorPublic: account },
    ];
    for (const n of invalids)
      expect(
        () => new TrMockAnchorProvider({ network: n, secret, journalPath: ':memory:' }),
      ).toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('rounds the live quote upward to kuruş and uses bank provider price', async () => {
    const h = harness();
    const p = h.make();
    expect((await p.quote(10000000n)).paidPriceTry).toBe('49.71');
  });
  it('uses the anchor reference, correct exchange asset codes and a durable sandbox capability', async () => {
    const h = harness();
    const p = h.make();
    const d = await p.create(request);
    expect(d.reference).toBe('TRMA-TEST-1');
    expect(d.sandboxToken).toMatch(/^[a-f0-9]{64}$/);
    const url = String(
      h.fetcher.mock.calls.find(([u]) => String(u).includes('/deposit-exchange'))![0],
    );
    expect(new URL(url).searchParams.get('destination_asset')).toBe('USDC');
    expect(await h.make().create(request)).toEqual(d);
    expect(
      h.fetcher.mock.calls.filter(([u]) => String(u).includes('/deposit-exchange')),
    ).toHaveLength(1);
  });
  it('recovers a lost create response by quote ID after restart, never creating another deposit', async () => {
    const h = harness();
    h.loseResponse();
    await expect(h.make().create(request)).rejects.toThrow('response lost');
    const d = await h.make().create(request);
    expect(d.transferId).toBe('sep_test');
    expect(
      h.fetcher.mock.calls.filter(([u]) => String(u).includes('/deposit-exchange')),
    ).toHaveLength(1);
  });
  it('requires exact anchor and chain proof before payment, and never fakes a refund', async () => {
    const h = harness();
    const p = h.make();
    const d = await p.create(request);
    h.setTransaction({ status: 'pending_anchor' });
    expect((await p.retrieve(d)).status).toBe('pending');
    h.setTransaction({ status: 'completed' });
    h.setChain(false);
    expect((await p.retrieve(d)).status).toBe('review');
    h.setChain(true);
    expect((await p.retrieve(d)).status).toBe('received');
    h.setTransaction({ amount_in: '49.70' });
    expect((await p.retrieve(d)).status).toBe('review');
    expect(await p.refund(d)).toBe('pending');
  });
  it('blocks modified instructions, late simulation and insufficient conversion', async () => {
    const h = harness();
    const p = h.make();
    const d = await p.create(request);
    await expect(p.simulate({ ...d, orderId: 'other' })).rejects.toThrow(/binding/);
    await expect(p.create({ ...request, amountTry: '1.00' })).rejects.toThrow(/conflict/);
    await expect(
      p.create({ ...request, orderId: 'other', minimumUsdcStroops: '20000000' }),
    ).rejects.toThrow(/cover merchant/);
  });
  it('will not authorize two orders with one onchain credit', async () => {
    const h = harness();
    const p = h.make();
    const first = await p.create(request);
    expect((await p.retrieve(first)).status).toBe('received');
    const second = await p.create({ ...request, orderId: 'second' });
    expect((await p.retrieve(second)).status).toBe('review');
  });
});
