// End-to-end composition smoke: the WHOLE stack composes. buildTestnetServerDeps (real ports, injected bootstrap
// reads so no network) -> createServer -> a live Fastify app. We exercise only the FAIL-CLOSED routes that touch
// no network (bad-signature webhook, unknown status, malformed intent) plus an empty poll tick — enough to prove
// the factory produces a createServer-compatible ServerDeps and the guards are wired, without a live RPC/iyzico.
// (The happy path — a real charge driving a real pay() — is the Phase-4.5 live-smoke.)

import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-base';
import { createServer } from '@troia/backend';
import type { Server } from '@troia/backend';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import { buildTestnetServerDeps } from '../src/testnet-deps.js';
import type { BootstrapReads, TestnetServerConfig } from '../src/testnet-deps.js';

const fakeOracle: OracleProvider = {
  getRate: () =>
    Promise.resolve({
      ok: true,
      quote: { midTryPerUsdc: 405_000_000n, sources: ['fake'], asOfMs: 0 },
    } as OracleResult),
};
const fakeHistory: RateHistoryProvider = {
  dailyCloses: () => Promise.resolve([40.0, 40.1, 40.2, 40.3, 40.4]),
};
const bootstrap: BootstrapReads = {
  operatorSeqNum: () => Promise.resolve(1000n),
  poolBalanceStroops: () => Promise.resolve(100_000n * 10_000_000n),
};

async function makeServer(): Promise<Server> {
  const kp = Keypair.random();
  const issuerKp = Keypair.random(); // usdcIssuer DERIVED so the issuer (mint) key check passes offline
  const cfg: TestnetServerConfig = {
    deployment: {
      usdcIssuer: issuerKp.publicKey(),
      usdcSacContractId: 'CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB',
      troyPool: 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ',
      operatorPublic: kp.publicKey(),
      adminPublic: 'GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ',
    },
    secrets: {
      operatorSecret: kp.secret(),
      issuerSecret: issuerKp.secret(),
      iyzicoApiKey: 'ak',
      iyzicoSecretKey: 'sk',
      webhookSigningSecret: 'wh',
    },
    callbackUrl: 'https://troia.example/webhook',
    spotOracle: fakeOracle,
    history: fakeHistory,
  };
  return createServer(await buildTestnetServerDeps(cfg, bootstrap));
}

describe('the composed server boots from buildTestnetServerDeps (offline fail-closed routes)', () => {
  it('GET /status/:unknown -> 404 (app is wired and routing)', async () => {
    const server = await makeServer();
    const r = await server.app.inject({ method: 'GET', url: '/status/nope' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /webhook with a bad signature -> 401 (SPIKE-4 money gate, verify runs first)', async () => {
    const server = await makeServer();
    const r = await server.app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-iyz-signature-v3': 'not-a-valid-signature' },
      payload: {
        iyziEventType: 'CHECKOUT_FORM_AUTH',
        paymentConversationId: 'c',
        token: 't',
        status: 'SUCCESS',
      },
    });
    expect(r.statusCode).toBe(401);
  });

  it('POST /intent without a session token -> 401 (C-13: the gate is ON in the composed server)', async () => {
    const server = await makeServer();
    const r = await server.app.inject({
      method: 'POST',
      url: '/intent',
      payload: { orderId: 'x' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'SessionRequired' });
  });

  it('POST /intent with a session but a malformed body -> 400 (fail-closed before any network call)', async () => {
    const server = await makeServer();
    const session = await server.app.inject({ method: 'POST', url: '/session' });
    expect(session.statusCode).toBe(200);
    const token = (session.json() as { token: string }).token;
    const r = await server.app.inject({
      method: 'POST',
      url: '/intent',
      headers: { 'x-troia-session': token },
      payload: { orderId: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('a poll tick with no in-flight orders is a no-op', async () => {
    const server = await makeServer();
    expect(await server.pollTick()).toMatchObject({ polled: 0, advanced: 0 });
  });

  it('exposes settleTick — the TRY-driven rebalance bot is wired into the composed server', async () => {
    const server = await makeServer();
    expect(typeof server.settleTick).toBe('function');
    // no money-good orders yet -> a settle tick is a clean no-op (touches no network)
    expect(await server.settleTick!()).toMatchObject({ armed: 0, settled: 0 });
  });
});
