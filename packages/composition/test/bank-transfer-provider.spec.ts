import { describe, expect, it, vi } from 'vitest';
import type { OracleProvider, RateHistoryProvider } from '@troia/oracle';
import { HttpBankTransferProvider } from '../src/bank-transfer-provider.js';
import { buildBankTransferConfig } from '../src/bank-transfer-config.js';
import { decodeOrderCtx, encodeOrderCtx } from '../src/order-ctx-codec.js';
import { makeHarness, makePreChargeCtx } from '../../backend/test/fakes/harness.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOrderDb } from '../src/order-db.js';
import { SqliteOrderRegistry } from '../src/sqlite-order-registry.js';
import { SqliteOrderStore } from '../src/sqlite-order-store.js';
import { KeyedMutex, pollInFlight } from '@troia/backend';

const config = {
  baseUrl: 'https://bank-api.example.test/v1',
  providerId: 'test-bank',
  apiKey: 'test-secret',
};
const input = {
  orderId: 'bank-order',
  idempotencyKey: 'stable-key',
  reference: 'TROIA-REF-1',
  amountTry: '3400.00',
  currency: 'TRY' as const,
  expiresAtUnix: 1_700_000_900,
};
const instructions = {
  providerId: 'test-bank',
  transferId: 'transfer-1',
  orderId: input.orderId,
  reference: 'TROIA-REF-1',
  iban: 'TR330006100519786457841326',
  beneficiary: 'Test Provider',
  amountTry: input.amountTry,
  currency: 'TRY' as const,
  expiresAtUnix: input.expiresAtUnix,
};
const sources = { spot: {} as OracleProvider, history: {} as RateHistoryProvider };

describe('private bank API adapter', () => {
  it('sends credentials only server-side, freezes idempotency and strips extra fields', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ...instructions, secret: 'must-not-leak' }),
    );
    const provider = new HttpBankTransferProvider(config, fetchImpl);
    expect(await provider.create(input)).toEqual(instructions);
    expect(fetchImpl.mock.calls[0]).toEqual([
      `${config.baseUrl}/transfers`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(input),
        headers: expect.objectContaining({
          Authorization: 'Bearer test-secret',
          'Idempotency-Key': 'stable-key',
        }),
      }),
    ]);
  });
  it('rejects insecure transport, malformed IBANs and the wrong provider', async () => {
    expect(
      () => new HttpBankTransferProvider({ ...config, baseUrl: 'http://bank.test' }),
    ).toThrow();
    for (const invalid of [{ iban: 'TR000006100519786457841326' }, { providerId: 'other' }]) {
      const provider = new HttpBankTransferProvider(config, async () =>
        Response.json({ ...instructions, ...invalid }),
      );
      await expect(provider.create(input)).rejects.toThrow();
    }
  });
  it('does not follow credential-bearing redirects or accept error/oversized bodies', async () => {
    const provider = new HttpBankTransferProvider(
      config,
      async () => new Response('x'.repeat(65537)),
    );
    await expect(provider.create(input)).rejects.toThrow(/too large/);
    const denied = new HttpBankTransferProvider(
      config,
      async () => new Response('private provider detail', { status: 403 }),
    );
    await expect(denied.create(input)).rejects.toThrow('Bank provider unavailable');
  });
  it('accepts only a matching final refund and keeps refund retries idempotent', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...instructions, status: 'pending' }));
    const provider = new HttpBankTransferProvider(config, fetchImpl);
    expect(await provider.refund(instructions)).toBe('pending');
    expect(fetchImpl.mock.calls[0]).toEqual([
      `${config.baseUrl}/transfers/transfer-1/refund`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'refund:transfer-1' }),
      }),
    ]);
    const ok = new HttpBankTransferProvider(config, async () =>
      Response.json({ ...instructions, status: 'refunded' }),
    );
    expect(await ok.refund(instructions)).toBe('refunded');
    const bad = new HttpBankTransferProvider(config, async () =>
      Response.json({ ...instructions, amountTry: '1.00', status: 'refunded' }),
    );
    expect(await bad.refund(instructions)).toBe('pending');
  });
});

describe('bank setup and durable recovery', () => {
  it('defaults to disabled; enabling requires provider credentials and an explicit bank fee policy', () => {
    expect(buildBankTransferConfig({}, sources.spot, sources.history)).toBeUndefined();
    expect(() =>
      buildBankTransferConfig({ BANK_TRANSFER_MODE: 'mock' }, sources.spot, sources.history),
    ).toThrow();
    expect(() =>
      buildBankTransferConfig({ BANK_TRANSFER_MODE: 'bridge' }, sources.spot, sources.history),
    ).toThrow(/FEE_BPS/);
    const bundle = buildBankTransferConfig(
      {
        BANK_TRANSFER_MODE: 'bridge',
        BANK_TRANSFER_API_BASE_URL: config.baseUrl,
        BANK_TRANSFER_API_KEY: config.apiKey,
        BANK_TRANSFER_PROVIDER_ID: config.providerId,
        BANK_TRANSFER_FEE_BPS: '50',
        BANK_TRANSFER_FIXED_KURUS: '0',
        BANK_TRANSFER_VALOR_DAYS: '1',
        BANK_TRANSFER_MARGIN_BPS: '50',
      },
      sources.spot,
      sources.history,
    );
    expect(bundle?.provider).toBeInstanceOf(HttpBankTransferProvider);
    expect(bundle?.quote).toBeTypeOf('function');
  });
  it('restores the same instructions, price, expiry and review state after a real SQLite reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-bank-'));
    const h = makeHarness();
    const ctx = makePreChargeCtx(h.store, {
      orderId: input.orderId,
      paymentMethod: 'bank_transfer',
      bankTransfer: instructions,
      bankExpiresAtUnix: input.expiresAtUnix,
      bankReview: true,
      token: instructions.transferId,
    });
    const open = () => {
      const db = openOrderDb(dir);
      const store = new SqliteOrderStore({ db, balanceStroops: 10_000_000_000n, baseSeq: 1000n });
      return { db, store, registry: new SqliteOrderRegistry(db, store) };
    };
    const first = open();
    await first.store.createIfAbsent(ctx.orderId);
    await first.store.reserve(ctx.orderId, ctx.amountStroops, 900_000, h.clock.now * 1000);
    await first.store.persistState(ctx.orderId, 'SolvencyReserved', {});
    first.registry.put(ctx, 'SolvencyReserved');
    first.db.close();
    const second = open();
    try {
      expect(second.registry.getByOrderId(ctx.orderId)?.ctx).toEqual(ctx);
      const create = vi.fn(async () => {
        throw new Error('must not create a second transfer');
      });
      const provider = {
        create,
        retrieve: async () => ({
          ...instructions,
          status: 'received' as const,
          receivedAtUnix: h.clock.now,
        }),
        refund: async () => 'pending' as const,
      };
      const deps = { ...h.deps, store: second.store, bankTransfer: provider };
      await pollInFlight(second.registry, new KeyedMutex(), deps);
      await pollInFlight(second.registry, new KeyedMutex(), deps);
      expect(create).not.toHaveBeenCalled();
      expect(h.stellar.submitReqs).toHaveLength(1);
      expect(second.registry.getByOrderId(ctx.orderId)?.state).toBe('UsdcConfirmed');
    } finally {
      second.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects mismatched or missing bank facts on disk; keeps v1/v2 card orders readable', () => {
    const h = makeHarness();
    const ctx = makePreChargeCtx(h.store, {
      orderId: input.orderId,
      paymentMethod: 'bank_transfer',
      bankTransfer: instructions,
      bankExpiresAtUnix: input.expiresAtUnix,
      token: instructions.transferId,
    });
    const raw = JSON.parse(encodeOrderCtx(ctx));
    expect(() => decodeOrderCtx(JSON.stringify({ ...raw, paidPriceTry: '1.00' }))).toThrow(
      /do not match/,
    );
    expect(() => decodeOrderCtx(JSON.stringify({ ...raw, bankTransfer: {} }))).toThrow();
    expect(() => decodeOrderCtx(JSON.stringify({ ...raw, bankExpiresAtUnix: null }))).toThrow();
    const legacy = JSON.parse(encodeOrderCtx(makePreChargeCtx(h.store)));
    for (const version of [1, 2]) {
      legacy.v = version;
      delete legacy.paymentMethod;
      delete legacy.bankTransfer;
      delete legacy.bankExpiresAtUnix;
      delete legacy.bankReview;
      expect(decodeOrderCtx(JSON.stringify(legacy)).paymentMethod).toBeUndefined();
    }
  });
});
