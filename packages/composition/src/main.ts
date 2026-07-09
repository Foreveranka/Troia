// The server bootstrap — the ONLY entrypoint that reads secrets from the environment (the composition root). It
// loads the testnet deployment + env secrets, builds the live spot oracle + daily-close history, assembles the
// ServerDeps, stands up the Fastify app, and schedules the poll/recovery worker. Run via `just serve`
// (node --env-file=.env). NEVER imported — importing @troia/composition does not boot a server, so nothing reads
// process.env except a real serve. Env parsing/validation lives in env.ts (unit-tested); this file is the thin,
// side-effecting boot: every bad value fails closed (throw -> process.exit(1)), never a silent degrade.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '@troia/backend';
import { INITIAL_DRIFT_STATE, isDurableLogFailure, observeDrift } from '@troia/backend';
import { LiveCexOracle, YahooUsdTryHistory } from '@troia/oracle';
import { intEnv, parseDeployment, requireEnv } from './env.js';
import { buildTestnetServerDeps } from './testnet-deps.js';
import type { TestnetSecrets } from './testnet-deps.js';

/** A poisoned durable log means nothing can be booked any more: every later tick would re-run the effects that
 *  precede the write — including on-chain mints — and record none of them. There is no safe way to continue, so
 *  the tick loops take the process down. A restart re-runs the boot-time write probe, which either finds a healed
 *  disk or refuses to start. Anything else is this tick's problem and is logged. */
function tickFailed(what: string, err: unknown): void {
  console.error(`${what} failed`, err);
  if (isDurableLogFailure(err)) {
    console.error(
      `FATAL: the durable log rejected a write — refusing to keep running unrecorded. ${what}`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const deploymentPath = env.TROIA_DEPLOYMENT_PATH ?? 'deployment.testnet.json';
  const deployment = parseDeployment(
    JSON.parse(readFileSync(deploymentPath, 'utf8')),
    deploymentPath,
  );

  const iyzicoSecretKey = requireEnv(env, 'IYZICO_SECRET_KEY');
  const secrets: TestnetSecrets = {
    operatorSecret: requireEnv(env, 'TROIA_OPERATOR_SECRET'),
    // the USDC SAC admin key — signs the rebalance mint. SEPARATE from the operator payout key.
    issuerSecret: requireEnv(env, 'TROIA_ISSUER_SECRET'),
    iyzicoApiKey: requireEnv(env, 'IYZICO_API_KEY'),
    iyzicoSecretKey,
    // the webhook HMAC key; iyzico signs the callback with the account secretKey unless a distinct key is issued.
    webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET?.trim() || iyzicoSecretKey,
  };
  // the PUBLIC url iyzico redirects the customer's browser to after payment — point it at the /return landing
  // page (a tunnel on testnet, e.g. https://<tunnel>/return). Settlement is the poll worker's pull, not this URL.
  const callbackUrl = requireEnv(env, 'TROIA_CALLBACK_URL');
  const port = intEnv(env, 'PORT', 3000, 1, 65535);
  const host = env.HOST ?? '0.0.0.0';
  const pollIntervalMs = intEnv(env, 'POLL_INTERVAL_MS', 5000, 1000); // >= 1s; fail-closed on a bad value
  const settlementTickMs = intEnv(env, 'SETTLEMENT_TICK_MS', 5000, 1000); // rebalance sim cadence; fail-closed
  // Solvency-drift cadence. It must exceed the settlement tick: a payout lands on chain before the settlement
  // worker books it, and reading inside that window reports a drift that is only bookkeeping in flight.
  const reconTickMs = intEnv(env, 'RECON_INTERVAL_MS', 30_000, settlementTickMs + 1000);
  // the COMPRESSED settlement valör for the demo (real iyzico valör is ~21 days). Default 30s.
  const demoValorSecs = intEnv(env, 'DEMO_VALOR_SECS', 30, 1);

  // Where the append-only journal + evidence logs live. Everything that must outlive a restart goes here.
  //
  // Scoped per POOL. The journal exists to say what THIS pool should be holding, and `just fund` deploys a
  // brand-new TroyPool with a fresh seed. One shared directory would carry the old pool's balance into the new
  // books and make the drift alarm scream about money that is not missing — it is in a contract nobody uses.
  const dataDir = join(env.TROIA_DATA_DIR?.trim() || 'data', deployment.troyPool);

  const deps = await buildTestnetServerDeps({
    deployment,
    secrets,
    callbackUrl,
    demoValorSecs,
    dataDir,
    // Settlement-rate oracle: sources must agree within 0.5% AND a genuine 3-source majority must be present
    // (minQuorum 3), so a single compromised in-band source cannot move the median — the money-safe default the
    // oracle doc demands. A CEX outage fails a quote CLOSED (retry) rather than settling on a 2-source mid.
    spotOracle: new LiveCexOracle({
      policy: { maxAgeMs: 60_000, deviationThresholdBps: 50, minQuorum: 3 },
    }),
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
      .catch((err: unknown) => tickFailed('pollTick', err))
      .finally(() => {
        polling = false;
      });
  }, pollIntervalMs);

  // TRY-driven rebalance loop, with its OWN in-flight guard (same shape as the poll loop): each tick arms
  // money-good orders and refills the pool for any whose compressed valör has elapsed. A slow tick or a fast
  // interval can never STACK mints. Present only when the settlement bundle was wired.
  const settleTick = server.settleTick;
  if (settleTick !== undefined) {
    let settling = false;
    setInterval(() => {
      if (settling) return;
      settling = true;
      void settleTick()
        .catch((err: unknown) => tickFailed('settleTick', err))
        .finally(() => {
          settling = false;
        });
    }, settlementTickMs);
    console.log(
      `troia rebalance bot armed — demo valör ${demoValorSecs}s, tick ${settlementTickMs}ms`,
    );
  }

  // The solvency tripwire. It reads only; it corrects nothing, and it re-seeds nothing. A drift that closes by
  // itself was the booking lag that follows every payout; one that persists is value that moved without being
  // recorded, and it pages exactly once — a page repeated every tick is a page people learn to ignore.
  const reconTick = server.reconTick;
  if (reconTick !== undefined) {
    let driftState = INITIAL_DRIFT_STATE;
    let checking = false;
    setInterval(() => {
      if (checking) return;
      checking = true;
      void reconTick()
        .then((r) => {
          const o = observeDrift(driftState, r);
          driftState = o.state;
          const amounts = `expected ${r.expectedPoolStroops}, on chain ${r.observedPoolStroops}, drift ${r.driftStroops}`;
          if (o.alarm) {
            console.error(
              `SOLVENCY ALARM: the pool has disagreed with the ledger for ${o.state.consecutiveOutOfSync} ` +
                `consecutive checks — ${amounts}. USDC moved without being recorded. Nothing was re-seeded.`,
            );
          } else if (o.settling) {
            console.warn(`[solvency] drift observed, may still be settling — ${amounts}`);
          } else if (o.recovered) {
            console.log(
              `[solvency] drift closed — the books and the chain agree again (${amounts})`,
            );
          }
        })
        // A read failure is NOT "in sync". Say so, keep the episode counter, and look again next tick.
        .catch((err: unknown) => console.error('reconTick could not read the pool balance', err))
        .finally(() => {
          checking = false;
        });
    }, reconTickMs);
    console.log(`troia solvency tripwire armed — tick ${reconTickMs}ms`);
  }
}

main().catch((err: unknown) => {
  console.error('fatal: server failed to start', err);
  process.exit(1);
});
