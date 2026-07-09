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
