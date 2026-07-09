import { describe, expect, it } from 'vitest';
import { testnetConfig } from '@troia/config';
import type { NetworkConfig } from '@troia/config';
import { buildEngineConfig, createServer } from '../src/composition.js';
import type { EngineExtras } from '../src/composition.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryPendingSettlementStore } from '../src/settlement/pending-settlement-store.js';
import { TryDrivenRebalancePolicy } from '../src/settlement/rebalance-policy.js';
import type { TopUpRequest } from '../src/settlement/rebalance-policy.js';
import {
  FakeClock,
  FakePspPort,
  FakeStellarPort,
  FakeStore,
  makeConfig,
  makeCtx,
} from './fakes/harness.js';
import { intentBody, quote, signV3, WEBHOOK_SECRET, webhookEvent } from './http/http-harness.js';

const UNIT = 10_000_000n;

const network: NetworkConfig = testnetConfig({
  usdcIssuer: 'GISSUER',
  usdcSacContractId: 'CSACCONTRACTIDPLACEHOLDER000000000000000000000000',
  troyPool: 'CTROYPOOLCONTRACTIDPLACEHOLDER00000000000000000000',
  operatorPublic: 'GOPERATORPUBLICKEYPLACEHOLDER000000000000000000',
  adminPublic: 'GADMINPUBLICKEYPLACEHOLDER00000000000000000000',
});

function extras(): EngineExtras {
  const mc = makeConfig();
  return { feeStroops: '100', timeboundsSecs: 45, psp: mc.psp, policy: mc.policy };
}

describe('buildEngineConfig — NetworkConfig -> EngineConfig, secret-free', () => {
  it('sources every field correctly (network vs deploy/merchant extras)', () => {
    const e = extras();
    const cfg = buildEngineConfig(network, e);
    expect(cfg.stellar.operatorPublic).toBe(network.operatorPublic);
    expect(cfg.stellar.troyPool).toBe(network.contracts.troyPool);
    expect(cfg.stellar.passphrase).toBe(network.passphrase);
    expect(cfg.stellar.usdcIssuer).toBe(network.usdc.issuer);
    expect(cfg.stellar.feeStroops).toBe(e.feeStroops);
    expect(cfg.stellar.timeboundsSecs).toBe(e.timeboundsSecs);
    expect(cfg.psp).toBe(e.psp);
    expect(cfg.policy).toBe(e.policy);
    // money-first policy shape: the reversal/pool fields replace the removed capture/preauth ones.
    expect(cfg.policy.maxReversalRetries).toBe(e.policy.maxReversalRetries);
    expect(cfg.policy.poolLowWatermarkStroops).toBe(e.policy.poolLowWatermarkStroops);
    expect(cfg.policy).not.toHaveProperty('maxCaptureRetries');
    expect(cfg.policy).not.toHaveProperty('maxVoidRetries');
    expect(cfg.policy).not.toHaveProperty('preauthValidityUnix');
  });

  it('carries NO secret (no apiKey / secretKey anywhere)', () => {
    // poolLowWatermarkStroops is a bigint under the money-first policy, so serialize with a bigint replacer.
    const bigintSafe = (_k: string, v: unknown): unknown =>
      typeof v === 'bigint' ? v.toString() : v;
    const json = JSON.stringify(buildEngineConfig(network, extras()), bigintSafe);
    expect(json).not.toMatch(/secretKey|apiKey|secret/i);
    expect(Object.keys(buildEngineConfig(network, extras()))).toEqual(['stellar', 'psp', 'policy']);
  });
});

describe('createServer — app + poll worker over ONE shared order lock', () => {
  function makeServer() {
    const trace: string[] = [];
    const stellar = new FakeStellarPort(trace);
    const psp = new FakePspPort(trace);
    const clock = new FakeClock();
    const store = new InMemoryStore({ balanceStroops: 100n * UNIT, baseSeq: 1000n });
    const server = createServer({
      network,
      extras: extras(),
      ports: { stellar, psp, store, clock },
      quote,
      webhookSigningSecret: WEBHOOK_SECRET,
    });
    return { server, stellar, trace };
  }

  it('crash-recovery flow: webhook leaves the order UsdcPending; a poll tick resumes it to completed', async () => {
    const { server, stellar } = makeServer();

    // 1) intent -> hosted checkout
    const intent = await server.app.inject({
      method: 'POST',
      url: '/intent',
      payload: intentBody('order-1'),
    });
    expect(intent.statusCode).toBe(200);

    // 2) webhook while the USDC tx is still in flight -> parks in the USDC durable wait
    stellar.observeVerdict = 'STILL_PENDING';
    const event = webhookEvent('order-1');
    const wh = await server.app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-iyz-signature-v3': signV3(WEBHOOK_SECRET, event) },
      payload: event,
    });
    expect(wh.json()).toMatchObject({ status: 'ok' });
    const mid = await server.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(mid.json()).toEqual({ orderId: 'order-1', status: 'processing' }); // never leaks 'UsdcPending'

    // 3) the tx has now landed; the poll/recovery worker resumes the parked order to settlement
    stellar.observeVerdict = 'LANDED_SUCCESS';
    const report = await server.pollTick();
    expect(report).toMatchObject({ polled: 1, advanced: 1 });

    const done = await server.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(done.json()).toEqual({ orderId: 'order-1', status: 'completed' });
  });

  it('a poll tick with no in-flight orders is a no-op', async () => {
    const { server } = makeServer();
    expect(await server.pollTick()).toEqual({
      polled: 0,
      advanced: 0,
      escalated: 0,
      quarantined: 0,
    });
  });

  it('a server built without a settlement bundle exposes no settleTick', () => {
    const { server } = makeServer();
    expect(server.settleTick).toBeUndefined();
  });

  it('the SHARED order lock serializes concurrent poll ticks (the second blocks until the first releases)', async () => {
    const { server, stellar } = makeServer();
    // drive one order into the USDC durable wait
    await server.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    stellar.observeVerdict = 'STILL_PENDING';
    const event = webhookEvent('order-1');
    await server.app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-iyz-signature-v3': signV3(WEBHOOK_SECRET, event) },
      payload: event,
    });

    // gate observe so the first tick parks INSIDE the order lock
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let observeCount = 0;
    stellar.observe = async (s) => {
      observeCount += 1;
      await gate;
      return { next: s, action: 'none', verdict: 'STILL_PENDING' };
    };

    const t1 = server.pollTick();
    const t2 = server.pollTick();
    await new Promise((r) => setTimeout(r, 0)); // let both ticks reach the lock
    // with a SHARED lock the second tick is blocked -> only ONE observe has run; with SEPARATE locks it would be 2
    expect(observeCount).toBe(1);
    release();
    await Promise.all([t1, t2]);
    expect(observeCount).toBe(2); // both ran, strictly serialized
  });
});

describe('createServer — settleTick wires the TRY-driven rebalance over the SAME shared lock', () => {
  class FakeRebalance {
    readonly minted: string[] = [];
    async topUp(req: TopUpRequest): Promise<{ usdcStroops: bigint; txHash: string }> {
      this.minted.push(req.ref);
      return { usdcStroops: req.usdcStroops, txHash: `tx_${req.ref}` };
    }
  }
  class FakeRate {
    async liveRateStroops(): Promise<bigint> {
      return 340_000_000n; // 34.0 TRY/USDC
    }
  }
  class FakeBook {
    readonly booked: { ref: string; usdcStroops: bigint; valueKurus: bigint }[] = [];
    recordTopUp(input: { ref: string; usdcStroops: bigint; valueKurus: bigint }): void {
      this.booked.push(input);
    }
  }

  function makeServerWithSettlement() {
    const clock = new FakeClock(1_000);
    const store = new InMemoryStore({ balanceStroops: 100n * UNIT, baseSeq: 1000n });
    const rebalance = new FakeRebalance();
    const ledger = new FakeBook();
    const server = createServer({
      network,
      extras: extras(),
      ports: { stellar: new FakeStellarPort([]), psp: new FakePspPort([]), store, clock },
      quote,
      webhookSigningSecret: WEBHOOK_SECRET,
      settlement: {
        pending: new InMemoryPendingSettlementStore(),
        policy: new TryDrivenRebalancePolicy(),
        rebalance,
        ledger,
        rate: new FakeRate(),
        demoValorSecs: 45,
      },
    });
    return { server, store, rebalance, ledger, clock };
  }

  it('arms a UsdcConfirmed order, then refills the pool once after the demo valör (gate rises)', async () => {
    const { server, store, rebalance, ledger, clock } = makeServerWithSettlement();
    server.registry.put(makeCtx(new FakeStore([]), { orderId: 'ord-x' }), 'UsdcConfirmed');
    const before = store.availableStroops();

    const armReport = await server.settleTick!(); // arm at 1000 -> settlesAt 1045
    expect(armReport).toMatchObject({ armed: 1, settled: 0 });
    expect(rebalance.minted).toEqual([]); // arming mints nothing

    clock.now = 1_045; // valör reached
    const settleReport = await server.settleTick!();
    expect(settleReport).toMatchObject({ settled: 1 });
    expect(rebalance.minted).toEqual(['topup:ord-x']); // exactly one mint, deterministic ref
    expect(ledger.booked).toHaveLength(1);
    expect(store.availableStroops()).toBeGreaterThan(before); // creditPool lifted the /intent gate

    // a re-tick is a no-op (exactly-once)
    await server.settleTick!();
    expect(rebalance.minted).toEqual(['topup:ord-x']);
  });
});
