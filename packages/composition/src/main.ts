// The server bootstrap — the ONLY entrypoint that reads secrets from the environment (the composition root). It
// loads the testnet deployment + env secrets, builds the live spot oracle + daily-close history, assembles the
// ServerDeps, stands up the Fastify app, and schedules the poll/recovery worker. Run via `just serve`
// (node --env-file=.env). NEVER imported — importing @troia/composition does not boot a server, so nothing reads
// process.env except a real serve. Env parsing/validation lives in env.ts (unit-tested); this file is the thin,
// side-effecting boot: every bad value fails closed (throw -> process.exit(1)), never a silent degrade.

import { readFileSync } from 'node:fs';
import { createServer } from '@troia/backend';
import { LiveCexOracle, YahooUsdTryHistory } from '@troia/oracle';
import { intEnv, parseDeployment, requireEnv } from './env.js';
import { buildTestnetServerDeps } from './testnet-deps.js';
import type { TestnetSecrets } from './testnet-deps.js';

async function main(): Promise<void> {
  const env = process.env;
  const deploymentPath = env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json';
  const deployment = parseDeployment(JSON.parse(readFileSync(deploymentPath, 'utf8')), deploymentPath);

  const iyzicoSecretKey = requireEnv(env, 'IYZICO_SECRET_KEY');
  const secrets: TestnetSecrets = {
    operatorSecret: requireEnv(env, 'TROIA_OPERATOR_SECRET'),
    iyzicoApiKey: requireEnv(env, 'IYZICO_API_KEY'),
    iyzicoSecretKey,
    // the webhook HMAC key; iyzico signs the callback with the account secretKey unless a distinct key is issued.
    webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET?.trim() || iyzicoSecretKey,
  };
  const callbackUrl = requireEnv(env, 'TROIA_CALLBACK_URL'); // the PUBLIC webhook url (a tunnel on testnet)
  const port = intEnv(env, 'PORT', 3000, 1, 65535);
  const host = env.HOST ?? '0.0.0.0';
  const pollIntervalMs = intEnv(env, 'POLL_INTERVAL_MS', 5000, 1000); // >= 1s; fail-closed on a bad value

  const deps = await buildTestnetServerDeps({
    deployment,
    secrets,
    callbackUrl,
    // Settlement-rate oracle: sources must agree within 0.5% AND a genuine 3-source majority must be present
    // (minQuorum 3), so a single compromised in-band source cannot move the median — the money-safe default the
    // oracle doc demands. A CEX outage fails a quote CLOSED (retry) rather than settling on a 2-source mid.
    spotOracle: new LiveCexOracle({ policy: { maxAgeMs: 60_000, deviationThresholdBps: 50, minQuorum: 3 } }),
    history: new YahooUsdTryHistory(),
  });

  const server = createServer(deps);
  await server.app.listen({ port, host });
  console.log(`troia backend listening on ${host}:${port} — webhook -> ${callbackUrl}`);

  // Poll/recovery loop with an in-flight guard: skip a new tick while the previous one is still running, so
  // neither a fast interval nor a slow tick can STACK passes (which would storm iyzico + Stellar RPC).
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void server
      .pollTick()
      .catch((err: unknown) => console.error('pollTick failed', err))
      .finally(() => {
        polling = false;
      });
  }, pollIntervalMs);
}

main().catch((err: unknown) => {
  console.error('fatal: server failed to start', err);
  process.exit(1);
});
