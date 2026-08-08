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
  INITIAL_RECONCILE_ALARMS,
  INITIAL_TAIL_HEALTH,
  isDurableLogFailure,
  observeDrift,
  observeReconcile,
  observeTailHealth,
} from '@troia/backend';
import { LiveCexOracle, YahooUsdTryHistory } from '@troia/oracle';
import { intEnv, parseDeployment, requireEnv } from './env.js';
import { buildTestnetServerDeps } from './testnet-deps.js';
import type { TestnetSecrets } from './testnet-deps.js';
import {
  MetricsRegistry,
  metricsExposition,
  NULL_ALERT_SINK,
  WebhookAlertNotifier,
} from './observability.js';
import type { AlertSink } from './observability.js';

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

  // CHANNEL MODE (A-5): comma/whitespace-separated channel S-keys. Optional; absent => single operator.
  // Created + funded by `just add-channels N`. Channels hold fee XLM only — never USDC, never authority.
  const channelSecrets = (env.TROIA_CHANNEL_SECRETS ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const deps = await buildTestnetServerDeps({
    deployment,
    secrets,
    callbackUrl,
    demoValorSecs,
    dataDir,
    ...(channelSecrets.length > 0 ? { channelSecrets } : {}),
    // Settlement-rate oracle: sources must agree within 0.5% AND a genuine 3-source majority must be present
    // (minQuorum 3), so a single compromised in-band source cannot move the median — the money-safe default the
    // oracle doc demands. A CEX outage fails a quote CLOSED (retry) rather than settling on a 2-source mid.
    spotOracle: new LiveCexOracle({
      policy: { maxAgeMs: 60_000, deviationThresholdBps: 50, minQuorum: 3 },
    }),
    history: new YahooUsdTryHistory(),
  });

  const server = createServer(deps);

  // D-17: metrics + alerting. GET /metrics serves the Prometheus text format; TROIA_ALERT_WEBHOOK_URL
  // (optional, Slack-style incoming webhook) gets the SAME edge-triggered alarms the console gets. Neither can
  // touch the money path: gauges are reads, the notifier is fire-and-forget with a per-key cooldown.
  const metrics = new MetricsRegistry();
  const alertUrl = env.TROIA_ALERT_WEBHOOK_URL?.trim();
  const alerts: AlertSink =
    alertUrl !== undefined && alertUrl.length > 0
      ? new WebhookAlertNotifier(alertUrl)
      : NULL_ALERT_SINK;
  server.app.get('/metrics', async (_request, reply) => {
    const e = metricsExposition(metrics);
    return reply.type(e.contentType).send(e.body);
  });
  // The store's read-side surface the gauges sample. lossRecords is on both concrete stores but not on the
  // Store port (it is an ops read, not a money method) — probe it structurally.
  const store = deps.ports.store;
  const lossCount = (): number =>
    'lossRecords' in store && typeof store.lossRecords === 'function'
      ? (store.lossRecords() as readonly unknown[]).length
      : 0;
  let lastLossCount = 0;

  await server.app.listen({ port, host });
  console.log(`troia backend listening on ${host}:${port} — webhook -> ${callbackUrl}`);
  if (alertUrl) console.log('troia alert webhook armed');

  // Poll/recovery loop with an in-flight guard: skip a new tick while the previous one is still running, so
  // neither a fast interval nor a slow tick can STACK passes (which would storm iyzico + Stellar RPC).
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    const startedAt = Date.now();
    void server
      .pollTick()
      .then((r) => {
        metrics.setGauge(
          'troia_poll_tick_duration_ms',
          Date.now() - startedAt,
          'wall-clock duration of the last poll/recovery pass',
        );
        metrics.addCounter(
          'troia_poll_polled_total',
          r.polled,
          'orders examined by the poll worker',
        );
        metrics.addCounter(
          'troia_poll_advanced_total',
          r.advanced,
          'orders advanced by the poll worker',
        );
        metrics.addCounter(
          'troia_poll_failed_total',
          r.failed,
          'per-order drive failures (retried next tick)',
        );
        metrics.setGauge(
          'troia_pool_available_stroops',
          store.availableStroops(),
          'pool balance minus held reservations (the /intent gate reads this)',
        );
        const losses = lossCount();
        metrics.setGauge(
          'troia_loss_review_open',
          losses,
          'orders quarantined for human review (LossReview / reversal-exhausted)',
        );
        // The quarantine gauge is also an alarm on its rising edge: an order waiting on a human that nobody
        // hears about is exactly the failure mode D-17 exists to close.
        if (losses > lastLossCount) {
          alerts.alert(
            'loss-review',
            `LOSS REVIEW: ${losses} order(s) are quarantined and waiting for a human decision.`,
          );
        }
        lastLossCount = losses;
      })
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
    let mintBlockAlarmed = false; // page once when blocked refs appear, once when they clear — never every tick
    setInterval(() => {
      if (settling) return;
      settling = true;
      void settleTick()
        .then((r) => {
          metrics.addCounter('troia_settlements_total', r.settled, 'pool refills completed');
          metrics.setGauge(
            'troia_mint_blocked',
            r.mintBlocked,
            'refills refused because a previous life left a mint intent unresolved',
          );
          if (r.mintBlocked > 0 && !mintBlockAlarmed) {
            mintBlockAlarmed = true;
            const msg =
              `MINT BLOCKED: ${r.mintBlocked} pool refill(s) refused because a previous life left their mint ` +
              `intent unresolved — the mint may be on chain unbooked. See the [mint-wal] boot log for the ` +
              `ref(s); book the landed mint or clear the intent. Nothing was minted twice.`;
            console.error(msg);
            alerts.alert('mint-blocked', msg);
          } else if (r.mintBlocked === 0 && mintBlockAlarmed) {
            mintBlockAlarmed = false;
            console.log('[mint-wal] blocked refill(s) resolved — settlement is flowing again');
          }
        })
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
          metrics.setGauge(
            'troia_pool_expected_stroops',
            r.expectedPoolStroops,
            'the double-entry ledger expectation of the pool balance',
          );
          metrics.setGauge(
            'troia_pool_observed_stroops',
            r.observedPoolStroops,
            'the live on-chain pool balance',
          );
          metrics.setGauge(
            'troia_pool_drift_stroops',
            r.driftStroops,
            'observed minus expected; a persistent nonzero is the solvency alarm',
          );
          const o = observeDrift(driftState, r);
          driftState = o.state;
          metrics.setGauge(
            'troia_drift_consecutive_out_of_sync',
            o.state.consecutiveOutOfSync,
            'consecutive drift checks that disagreed',
          );
          const amounts = `expected ${r.expectedPoolStroops}, on chain ${r.observedPoolStroops}, drift ${r.driftStroops}`;
          if (o.alarm) {
            const msg =
              `SOLVENCY ALARM: the pool has disagreed with the ledger for ${o.state.consecutiveOutOfSync} ` +
              `consecutive checks — ${amounts}. USDC moved without being recorded. Nothing was re-seeded.`;
            console.error(msg);
            alerts.alert('solvency-drift', msg);
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
            metrics.setGauge(
              'troia_tail_stalled',
              1,
              'the payout tail cannot reach its RPC (1 = stalled)',
            );
            if (o.alarm) {
              const msg =
                `TAIL STALLED: the payout tail has not reached its RPC for ${o.state.consecutiveStalls} ` +
                `consecutive checks (${r.reason}). It is not scanning; the solvency drift tripwire is the ` +
                `only cover until it recovers.`;
              console.error(msg);
              alerts.alert('tail-stalled', msg);
            } else {
              console.warn(`[payout-tail] stalled — ${r.reason}`);
            }
            return;
          }
          const o = observeTailHealth(health, false);
          health = o.state;
          metrics.setGauge(
            'troia_tail_stalled',
            0,
            'the payout tail cannot reach its RPC (1 = stalled)',
          );
          if (o.recovered) console.log('[payout-tail] reached its RPC again, scanning resumed');

          if (r.kind === 'blindSpot') {
            // Latched, and never auto-cleared. Those ledgers are unreadable now — by us and by anyone else.
            const msg =
              `TAIL BLIND SPOT: the checkpoint at ledger ${r.fromLedger} fell below the RPC's retention floor ` +
              `(${r.toLedger}). Outflows in [${r.fromLedger}, ${r.toLedger}) can never be fetched again and ` +
              `were never attributed. Re-anchored at head (${r.latestLedger}). The solvency drift tripwire is ` +
              `the only cover for that interval.`;
            console.error(msg);
            alerts.alert('tail-blind-spot', msg);
            return;
          }

          if (r.coldStartFromLedger !== null) {
            console.log(
              `[payout-tail] cold start at ledger ${r.coldStartFromLedger} — nothing before it was examined; ` +
                `the solvency drift tripwire covers earlier history`,
            );
          }
          if (r.rogue.length > 0) {
            metrics.addCounter(
              'troia_rogue_payouts_total',
              r.rogue.length,
              'outflows the pre-broadcast journal never authorized',
            );
          }
          for (const s of r.rogue) {
            const msg =
              `ROGUE PAYOUT: ${s.amountStroops} stroops of USDC left the pool to ${s.to} in transaction ` +
              `${s.txHash} (ledger ${s.ledger}), which this operator never authorized — its hash was never ` +
              `written to the pre-broadcast journal. Nothing was reversed; a human must look.`;
            console.error(msg);
            alerts.alert(`rogue:${s.txHash}`, msg);
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
    let alarms = INITIAL_RECONCILE_ALARMS;
    let auditing = false;
    setInterval(() => {
      if (auditing) return;
      auditing = true;
      void reconcileTick()
        .then((r) => {
          if (r.upgrades.length > 0 && !upgradeAlarmed) {
            upgradeAlarmed = true; // latched: this never becomes true again on its own
            const msg =
              `POOL CODE REPLACED: the TroyPool contract was upgraded at ledger ${r.upgrades[0]?.ledger ?? 0} ` +
              `(tx ${r.upgrades[0]?.txHash ?? '?'}). Everything it announces about its own settlements from now ` +
              `on is a claim, not a proof. No order will be reconciled against it. A human must look.`;
            console.error(msg);
            alerts.alert('pool-upgrade', msg);
          }
          if (r.reconciled.length > 0) {
            metrics.addCounter(
              'troia_orders_reconciled_total',
              r.reconciled.length,
              'orders the live audit closed (the chain agrees)',
            );
          }
          metrics.setGauge(
            'troia_reconcile_waiting',
            r.waiting,
            'payouts still awaiting their settlement on chain',
          );
          for (const orderId of r.reconciled) {
            console.log(`[reconcile] ${orderId}: the chain agrees — reconciled`);
          }
          // The audit restates every open problem on every tick. Page each one once, when it appears or when it
          // changes character; a wall of identical alarms is read as noise and then not read at all.
          const observed = observeReconcile(alarms, r);
          alarms = observed.state;
          for (const orderId of observed.resolved) {
            console.log(`[reconcile] ${orderId}: the earlier alarm no longer holds — cleared`);
          }
          for (const p of observed.fresh) {
            if (p.kind === 'diverged') {
              const msg =
                `RECONCILIATION FAILED for ${p.orderId}: ${p.verdict} — ${p.detail}` +
                (p.fieldDiff.length > 0
                  ? ` (${p.fieldDiff.map((d) => `${d.field}: local ${d.local_value} != chain ${d.chain_value}`).join('; ')})`
                  : '');
              console.error(msg);
              alerts.alert(`reconcile-diverged:${p.orderId}`, msg);
            } else if (p.kind === 'unobservable') {
              const msg =
                `SETTLEMENT UNOBSERVABLE for ${p.orderId}: its pay() was witnessed ${p.ageSecs}s ago, inside the ` +
                `window the payout tail has been watching, and the pool has still announced no settlement for it ` +
                `on chain. The solvency drift tripwire is the only remaining cover.`;
              console.error(msg);
              alerts.alert(`reconcile-unobservable:${p.orderId}`, msg);
            } else if (p.kind === 'blind') {
              console.warn(
                p.reason === 'never-watched'
                  ? `[reconcile] ${p.orderId}: its pay() was witnessed ${p.ageSecs}s ago, before the payout tail ` +
                      `began watching, so its settlement was never scanned. Nothing can be concluded about it here; ` +
                      `drift is the cover. Not an accusation.`
                  : `[reconcile] ${p.orderId}: the pool's settlement announcement is in our log, but the chain will ` +
                      `no longer return the transaction (retention, a reset, or it never landed — RPC cannot tell ` +
                      `them apart), so it can never be re-confirmed. Not an accusation.`,
              );
            }
          }
          for (const p of r.problems) {
            // Deliberately unlatched and never an alarm: a chain we cannot reach must not page, and must not clear.
            if (p.kind === 'unreachable')
              console.warn(`[reconcile] ${p.orderId}: could not reach the chain (${p.reason})`);
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
