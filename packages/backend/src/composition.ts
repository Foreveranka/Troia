// The composition root. buildEngineConfig maps the secret-free NetworkConfig (+ deploy/merchant extras) into
// the EngineConfig the engine consumes; createServer wires the app + the poll worker over ONE shared per-order
// lock. NO secret ever passes through here: NetworkConfig is secret-free by construction (@troia/config), and
// the merchant/psp template is a KYC-stub (no card/PAN). The concrete keyed adapters (SorobanRpcAdapter /
// HorizonAdapter / LocalKeySigner / iyzico provider) are built from NetworkConfig.rpcUrl + env secrets by a
// Phase 4.4/4.5 factory and injected as `ports`; the offline suite injects fakes.

import type { NetworkConfig } from '@troia/config';
import type { FastifyInstance } from 'fastify';
import type { EngineConfig, EnginePspConfig } from './engine/config.js';
import type { EngineDeps } from './engine/events.js';
import { createApp } from './http/app.js';
import type { QuoteFn } from './http/app.js';
import { InMemoryOrderRegistry } from './http/order-registry.js';
import type { OrderRegistry } from './http/order-registry.js';
import type { PolicyConfig } from './policy.js';
import type { Clock, PspPort, StellarPort, Store } from './ports.js';
import { KeyedMutex } from './store/mutex.js';
import { pollInFlight } from './worker/poll-worker.js';
import type { PollReport } from './worker/poll-worker.js';
import { settleAndRebalance } from './settlement/settlement-worker.js';
import { checkDrift } from './settlement/drift-worker.js';
import type { DriftTickReport } from './settlement/drift-worker.js';
import { tailOutflows } from './settlement/outflow-worker.js';
import { advance } from './engine/driver.js';
import { reconcileOrders } from './settlement/reconcile-worker.js';
import type { ReconcileDeps, ReconcileReport } from './settlement/reconcile-worker.js';
import type { ConfirmedOrder } from './settlement/settlement-worker.js';
import type { OutflowTailDeps, OutflowTickReport } from './settlement/outflow-worker.js';
import type { SettleReport, TopUpExecution } from './settlement/settlement-worker.js';
import type { PendingSettlementStore } from './settlement/pending-settlement-store.js';
import type { RebalancePolicy, TopUpRequest } from './settlement/rebalance-policy.js';

/** Deploy + merchant parameters that are NOT network constants (so they live outside NetworkConfig). */
export interface EngineExtras {
  /** classic inclusion fee (stroops, string). */
  readonly feeStroops: string;
  /** pay() tx validity window in seconds. */
  readonly timeboundsSecs: number;
  /** merchant / hosted-form template (KYC-stub buyer; no card data). */
  readonly psp: EnginePspConfig;
  readonly policy: PolicyConfig;
}

/**
 * Map the secret-free NetworkConfig (+ extras) into an EngineConfig. Pure. Network-specific values come from
 * NetworkConfig; fee/timebounds/merchant/policy are deploy/merchant params from extras. Carries NO secret.
 */
export function buildEngineConfig(network: NetworkConfig, extras: EngineExtras): EngineConfig {
  return {
    stellar: {
      operatorPublic: network.operatorPublic,
      troyPool: network.contracts.troyPool,
      passphrase: network.passphrase,
      usdcIssuer: network.usdc.issuer,
      feeStroops: extras.feeStroops,
      timeboundsSecs: extras.timeboundsSecs,
    },
    psp: extras.psp,
    policy: extras.policy,
  };
}

export interface ServerPorts {
  readonly stellar: StellarPort;
  readonly psp: PspPort;
  readonly store: Store;
  readonly clock: Clock;
}

/** The TRY-driven rebalance collaborators, wired at the composition root. OPTIONAL — the offline suite and any
 *  deployment without a rebalance bot still build a server (settleTick is then absent). The registry, the shared
 *  per-order lock, the clock, and the pool-credit store come from createServer/ports; only the rebalance-specific
 *  pieces (the mint provider, the decision policy, the ledger, the live-rate reader) live here. */
/** The narrow slice of the double-entry ledger the server touches: book what enters the pool, book what leaves,
 *  and compare the resulting expectation against the chain. Structural, so @troia/backend takes no ledger dep. */
/** The durable work-list: every payout whose pay() was witnessed on chain, remembered on disk. */
export interface ConfirmedOrders {
  all(): readonly ConfirmedOrder[];
  get(orderId: string): ConfirmedOrder | undefined;
}

export interface SettlementBook {
  /** Did a PREVIOUS life already book this ref? The durable guard against repeating a side effect after a crash. */
  hasRef(ref: string): boolean;
  recordSettlement(input: {
    orderId: string;
    usdcStroops: bigint;
    userTryKurus: bigint;
    spreadKurus: bigint;
    feeKurus?: bigint;
  }): unknown;
  recordTopUp(input: { ref: string; usdcStroops: bigint; valueKurus: bigint }): unknown;
  /** observed − expected. The chain is the source of truth; a nonzero drift is an alarm, never absorbed. */
  detectDrift(observedPoolStroops: bigint): {
    readonly expectedPoolStroops: bigint;
    readonly observedPoolStroops: bigint;
    readonly driftStroops: bigint;
    readonly inSync: boolean;
  };
}

export interface SettlementBundle {
  readonly pending: PendingSettlementStore;
  readonly policy: RebalancePolicy;
  readonly rebalance: { topUp(req: TopUpRequest): Promise<TopUpExecution> };
  readonly ledger: SettlementBook;
  readonly rate: { liveRateStroops(): Promise<bigint> };
  readonly demoValorSecs: number;
}

export interface ServerDeps {
  readonly network: NetworkConfig;
  readonly extras: EngineExtras;
  /** injected keyed adapters (real at 4.4/4.5, fakes offline). */
  readonly ports: ServerPorts;
  /** prices an order server-side (commission model + spot mid). Injected so the rate source stays a seam. */
  readonly quote: QuoteFn;
  /** iyzico account secret (env). NEVER from NetworkConfig. */
  readonly webhookSigningSecret: string;
  /** The durable roll of money-good payouts, read from the evidence log. The settlement worker's work-list, and
   *  the reason a crash between confirmation and the next tick no longer strands an order's accounting. */
  readonly confirmed: ConfirmedOrders;
  /** the TRY-driven rebalance bot's collaborators; omit to build a server with no rebalance (no settleTick). */
  readonly settlement?: SettlementBundle;
  /** the rogue-payout tail's collaborators; omit to build a server with no tail (no outflowTick). */
  readonly outflow?: OutflowTailDeps;
  /** the live reconciler's collaborators, minus `advance` — createServer supplies that. */
  readonly reconcile?: Omit<ReconcileDeps, 'advance'>;
}

export interface Server {
  readonly app: FastifyInstance;
  readonly registry: OrderRegistry;
  /** run one poll/recovery pass over the in-flight USDC orders; the deployment schedules this on an interval. */
  readonly pollTick: () => Promise<PollReport>;
  /** run one settlement-sim pass (arm money-good orders, refill the pool for due ones); present only when a
   *  settlement bundle was injected. The deployment schedules this on its own (slower) interval. */
  readonly settleTick?: () => Promise<SettleReport>;
  /** The solvency tripwire: the live pool balance weighed against the ledger's expectation. Present with the
   *  settlement bundle (it needs the ledger). The deployment schedules it on its own, slower interval. */
  readonly reconTick?: () => Promise<DriftTickReport>;
  /** The payout tail: which transaction took USDC out of the pool, and was it one of ours. Present only when an
   *  outflow bundle was injected (it needs an RPC event tail and durable cursor/suspect stores). */
  readonly outflowTick?: () => Promise<OutflowTickReport>;
  /** The live audit: does the chain agree with our books, order by order? Drives UsdcConfirmed -> Reconciled. */
  readonly reconcileTick?: () => Promise<ReconcileReport>;
}

export function createServer(d: ServerDeps): Server {
  const config = buildEngineConfig(d.network, d.extras);
  const engine: EngineDeps = {
    stellar: d.ports.stellar,
    psp: d.ports.psp,
    store: d.ports.store,
    clock: d.ports.clock,
    config,
  };
  const orderLocks = new KeyedMutex(); // ONE lock shared by the app AND the worker(s) (load-bearing per SPIKE-2)
  const registry = new InMemoryOrderRegistry();
  const app = createApp({
    engine,
    registry,
    quote: d.quote,
    webhookSigningSecret: d.webhookSigningSecret,
    orderLocks,
  });
  const pollTick = (): Promise<PollReport> => pollInFlight(registry, orderLocks, engine);

  // The payout tail takes no order lock: it reads the chain and two append-only stores, and accuses nobody the
  // write-ahead journal has vouched for. It is independent of the settlement bundle.
  const outflow = d.outflow;
  const outflowTick =
    outflow === undefined ? undefined : (): Promise<OutflowTickReport> => tailOutflows(outflow);

  // The audit advances an order to Reconciled only when the chain agrees, and only for an order THIS process
  // still knows: a pre-crash order is audited and reported, but its state machine died with the registry, so
  // there is nothing left to advance. The audit itself runs either way — that is the point of it being durable.
  const reconcile = d.reconcile;
  const reconcileTick =
    reconcile === undefined
      ? undefined
      : (): Promise<ReconcileReport> =>
          reconcileOrders({
            ...reconcile,
            advance: async (orderId: string): Promise<void> => {
              await orderLocks.run(orderId, async () => {
                const rec = registry.getByOrderId(orderId);
                if (rec === undefined || rec.state !== 'UsdcConfirmed') return;
                const r = await advance(rec.ctx, rec.state, { type: 'reconciled' }, engine);
                registry.put(r.ctx, r.state);
              });
            },
          });

  const settlement = d.settlement;
  if (settlement === undefined) {
    return {
      app,
      registry,
      pollTick,
      ...(outflowTick && { outflowTick }),
      ...(reconcileTick && { reconcileTick }),
    };
  }
  // The solvency tripwire. It takes no lock: it only READS the chain and the ledger, and a stale-by-one-payout
  // observation cannot manufacture a false alarm that matters — the drift it would report is one order wide and
  // resolves on the next tick, while a real leak keeps growing.
  const reconTick = (): Promise<DriftTickReport> =>
    checkDrift({ stellar: d.ports.stellar, ledger: settlement.ledger });

  // The settlement worker shares the SAME registry + per-order lock + clock + pool-credit store as the app/poll
  // worker, so a rebalance top-up serializes with /intent, /webhook, and poll ticks for any given order.
  const settleTick = (): Promise<SettleReport> =>
    settleAndRebalance({
      confirmed: d.confirmed,
      orderLocks,
      clock: d.ports.clock,
      pending: settlement.pending,
      policy: settlement.policy,
      rebalance: settlement.rebalance,
      store: d.ports.store,
      ledger: settlement.ledger,
      rate: settlement.rate,
      demoValorSecs: settlement.demoValorSecs,
    });
  return {
    app,
    registry,
    pollTick,
    settleTick,
    reconTick,
    ...(outflowTick && { outflowTick }),
    ...(reconcileTick && { reconcileTick }),
  };
}
