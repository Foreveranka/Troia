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

export interface ServerDeps {
  readonly network: NetworkConfig;
  readonly extras: EngineExtras;
  /** injected keyed adapters (real at 4.4/4.5, fakes offline). */
  readonly ports: ServerPorts;
  /** prices an order server-side (commission model + spot mid). Injected so the rate source stays a seam. */
  readonly quote: QuoteFn;
  /** iyzico account secret (env). NEVER from NetworkConfig. */
  readonly webhookSigningSecret: string;
}

export interface Server {
  readonly app: FastifyInstance;
  readonly registry: OrderRegistry;
  /** run one poll/recovery pass over the in-flight USDC orders; the deployment schedules this on an interval. */
  readonly pollTick: () => Promise<PollReport>;
}

export function createServer(d: ServerDeps): Server {
  const config = buildEngineConfig(d.network, d.extras);
  const engine: EngineDeps = { stellar: d.ports.stellar, psp: d.ports.psp, store: d.ports.store, clock: d.ports.clock, config };
  const orderLocks = new KeyedMutex(); // ONE lock shared by the app AND the worker (load-bearing per SPIKE-2)
  const registry = new InMemoryOrderRegistry();
  const app = createApp({ engine, registry, quote: d.quote, webhookSigningSecret: d.webhookSigningSecret, orderLocks });
  const pollTick = (): Promise<PollReport> => pollInFlight(registry, orderLocks, engine);
  return { app, registry, pollTick };
}
