// The server bootstrap — the ONLY entrypoint that reads secrets from the environment (the composition root). It
// loads the testnet deployment + env secrets, builds the live spot oracle + daily-close history, assembles the
// ServerDeps, stands up the Fastify app, and schedules the poll/recovery worker. Run via `just serve`
// (node --env-file=.env). NEVER imported — importing @troia/composition does not boot a server, so nothing reads
// process.env except a real serve. Env parsing/validation lives in env.ts (unit-tested); this file is the thin,
// side-effecting boot: every bad value fails closed (throw -> process.exit(1)), never a silent degrade.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '@troia/backend';
import {
  INITIAL_DRIFT_STATE,
  INITIAL_TAIL_HEALTH,
  isDurableLogFailure,
  observeDrift,
  observeTailHealth,
} from '@troia/backend';
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
  // How often the payout tail asks the chain what left the pool. Slower than the money path on purpose: it is a
  // read-only observer, and its RPC pressure must never compete with the requests that move money.
  const outflowTickMs = intEnv(env, 'OUTFLOW_INTERVAL_MS', 20_000, 5_000);
  // The live audit. Slower than the tail that feeds it: an order cannot be reconciled before its settlement has
  // been observed, so running faster only re-asks a question the chain has not answered yet.
  const reconcileTickMs = intEnv(env, 'RECONCILE_INTERVAL_MS', 30_000, outflowTickMs + 1000);
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

  // The payout tail. It names the transaction, the destination and the amount — attribution the balance-drift
  // tripwire can never give — and pays for it with a window: events older than the RPC's retention are gone for
  // everyone. So it says three different things, and never confuses them: what it saw, what it could not see,
  // and what it could not reach.
  const outflowTick = server.outflowTick;
  if (outflowTick !== undefined) {
    let health = INITIAL_TAIL_HEALTH;
    let tailing = false;
    setInterval(() => {
      if (tailing) return;
      tailing = true;
      void outflowTick()
        .then((r) => {
          if (r.kind === 'stalled') {
            const o = observeTailHealth(health, true);
            health = o.state;
            if (o.alarm) {
              console.error(
                `TAIL STALLED: the payout tail has not reached its RPC for ${o.state.consecutiveStalls} ` +
                  `consecutive checks (${r.reason}). It is not scanning; the solvency drift tripwire is the ` +
                  `only cover until it recovers.`,
              );
            } else {
              console.warn(`[payout-tail] stalled — ${r.reason}`);
            }
            return;
          }
          const o = observeTailHealth(health, false);
          health = o.state;
          if (o.recovered) console.log('[payout-tail] reached its RPC again, scanning resumed');

          if (r.kind === 'blindSpot') {
            // Latched, and never auto-cleared. Those ledgers are unreadable now — by us and by anyone else.
            console.error(
              `TAIL BLIND SPOT: the checkpoint at ledger ${r.fromLedger} fell below the RPC's retention floor ` +
                `(${r.toLedger}). Outflows in [${r.fromLedger}, ${r.toLedger}) can never be fetched again and ` +
                `were never attributed. Re-anchored at head (${r.latestLedger}). The solvency drift tripwire is ` +
                `the only cover for that interval.`,
            );
            return;
          }

          if (r.coldStartFromLedger !== null) {
            console.log(
              `[payout-tail] cold start at ledger ${r.coldStartFromLedger} — nothing before it was examined; ` +
                `the solvency drift tripwire covers earlier history`,
            );
          }
          for (const s of r.rogue) {
            console.error(
              `ROGUE PAYOUT: ${s.amountStroops} stroops of USDC left the pool to ${s.to} in transaction ` +
                `${s.txHash} (ledger ${s.ledger}), which this operator never authorized — its hash was never ` +
                `written to the pre-broadcast journal. Nothing was reversed; a human must look.`,
            );
          }
          if (r.newSuspects > 0 || r.pending > 0) {
            console.warn(
              `[payout-tail] ${r.newSuspects} new unexplained outflow(s), ${r.pending} still within grace`,
            );
          }
        })
        .catch((err: unknown) => tickFailed('outflowTick', err))
        .finally(() => {
          tailing = false;
        });
    }, outflowTickMs);
    console.log(`troia payout tail armed — tick ${outflowTickMs}ms`);
  }

  // The live audit. It reads three things — our local order row, the transaction we signed, and the settlement the
  // pool announced on chain under the order's own identifier — and asks whether they tell the same story. Only
  // when they do is an order advanced to Reconciled, which is terminal and means "the chain agrees".
  const reconcileTick = server.reconcileTick;
  if (reconcileTick !== undefined) {
    let upgradeAlarmed = false;
    let auditing = false;
    setInterval(() => {
      if (auditing) return;
      auditing = true;
      void reconcileTick()
        .then((r) => {
          if (r.upgrades.length > 0 && !upgradeAlarmed) {
            upgradeAlarmed = true; // latched: this never becomes true again on its own
            console.error(
              `POOL CODE REPLACED: the TroyPool contract was upgraded at ledger ${r.upgrades[0]?.ledger ?? 0} ` +
                `(tx ${r.upgrades[0]?.txHash ?? '?'}). Everything it announces about its own settlements from now ` +
                `on is a claim, not a proof. No order will be reconciled against it. A human must look.`,
            );
          }
          for (const orderId of r.reconciled) {
            console.log(`[reconcile] ${orderId}: the chain agrees — reconciled`);
          }
          for (const p of r.problems) {
            if (p.kind === 'diverged') {
              console.error(
                `RECONCILIATION FAILED for ${p.orderId}: ${p.verdict} — ${p.detail}` +
                  (p.fieldDiff.length > 0
                    ? ` (${p.fieldDiff.map((d) => `${d.field}: local ${d.local_value} != chain ${d.chain_value}`).join('; ')})`
                    : ''),
              );
            } else if (p.kind === 'unobservable') {
              console.error(
                `SETTLEMENT UNOBSERVABLE for ${p.orderId}: its pay() was witnessed ${p.ageSecs}s ago and the pool ` +
                  `has still announced no settlement for it on chain. It may have settled inside a retention blind ` +
                  `spot, or not at all. The solvency drift tripwire is the only remaining cover.`,
              );
            } else if (p.kind === 'unreachable') {
              console.warn(`[reconcile] ${p.orderId}: could not reach the chain (${p.reason})`);
            }
          }
          if (r.waiting > 0)
            console.log(`[reconcile] ${r.waiting} payout(s) awaiting their settlement on chain`);
        })
        .catch((err: unknown) => tickFailed('reconcileTick', err))
        .finally(() => {
          auditing = false;
        });
    }, reconcileTickMs);
    console.log(`troia live reconciler armed — tick ${reconcileTickMs}ms`);
  }
}

main().catch((err: unknown) => {
  console.error('fatal: server failed to start', err);
  process.exit(1);
});
