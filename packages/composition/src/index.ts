// Public surface of @troia/composition — the composition root that binds the real adapters + the PSP-inclusive
// quote into one runnable system (Phase 4.5). Kept separate from @troia/backend so the backend takes no
// pricing/oracle/stellar-sdk dependency; everything network- and money-model-specific is wired HERE.

export { makeQuoteFn } from './quote.js';
export type { QuoteSources } from './quote.js';

export { wrapStellarPort } from './stellar-port.js';
export type { SorobanReads, StellarPortWiring } from './stellar-port.js';

export { buildStellarPort } from './build-stellar-port.js';
export type { BuildStellarPortOptions } from './build-stellar-port.js';

export { buildTestnetServerDeps, DEFAULT_TESTNET_MERCHANT } from './testnet-deps.js';
export type {
  TestnetSecrets,
  TestnetServerConfig,
  MerchantTemplate,
  BootstrapReads,
} from './testnet-deps.js';

export { runPreflight, buildPreflightProbes } from './preflight.js';
export type {
  PreflightCheck,
  PreflightReport,
  PreflightProbes,
  PreflightThresholds,
  PreflightWiring,
  PreflightIyzicoSecrets,
} from './preflight.js';
export { buildDurableBundle } from './durable-bundle.js';
export type { DurableBundle } from './durable-bundle.js';
export {
  FileAppendLog,
  assertWritableDir,
  DurableLogError,
  DurableLogCorruption,
} from './file-append-log.js';
export type { ReplayResult } from './file-append-log.js';

export { buildOutflowTail } from './outflow-port.js';
export type { OutflowTail } from './outflow-port.js';
export { FileCursorStore, FileSuspectStore, OutflowCodecError } from './outflow-stores.js';
export { FileWriteAheadJournal } from './file-journal.js';

// A-1: the durable order store — SQLite-backed Store + OrderRegistry, so orders, reservations, retry
// counters and the recovery work-list survive a restart (closes KNOWN_ISSUES §1's charge-window gap).
export { OrderDb, openOrderDb, ORDER_DB_FILE } from './order-db.js';
export { SqliteOrderStore } from './sqlite-order-store.js';
export type { SqliteOrderStoreOptions, StoreBootReport } from './sqlite-order-store.js';
export { SqliteOrderRegistry } from './sqlite-order-registry.js';
export type { RegistryBootReport } from './sqlite-order-registry.js';
export { encodeOrderCtx, decodeOrderCtx, OrderCtxCodecError } from './order-ctx-codec.js';
// A-2: the mint write-ahead journal — a durable intent written before every pool-refill mint, so a crash
// between the mint landing and its booking can never turn into a second mint (KNOWN_ISSUES §2).
export { SqliteMintIntentJournal } from './mint-intent-journal.js';

// D-17: observability — the hand-rolled Prometheus registry served on GET /metrics and the webhook alert
// notifier main.ts fires from the same edge-triggered branches that print the alarms.
export {
  MetricsRegistry,
  metricsExposition,
  WebhookAlertNotifier,
  NULL_ALERT_SINK,
  DEFAULT_ALERT_COOLDOWN_MS,
} from './observability.js';
export type { AlertSink } from './observability.js';
