// Public surface of @troia/stellar-client. Deliberately SDK-free: the pure core, the port interfaces, the
// outcome ADTs, the error taxonomy, and the createStellarClient factory. The concrete network/keyed
// implementations (SorobanRpcAdapter, HorizonAdapter, LocalKeySigner) are imported directly at the
// composition root (the backend, Phase 4.3) — they are NOT re-exported here so no @stellar/stellar-sdk
// Server type ever crosses this module.

export { buildPayTransaction } from './build.js';
export type { BuildParams } from './build.js';
export { assembleFromSimulation, assembleWithSignedAuth, hashOf } from './assemble.js';
export { resolveDeadness, deadnessToVerdict } from './deadness.js';
export type { DeadnessInputs } from './deadness.js';
export { step, verdictToCore } from './submit-reducer.js';
export type {
  ReducerState,
  ReducerAction,
  StepResult,
  CoreEventOut,
  CoreMapping,
} from './submit-reducer.js';
export { toAccountSnapshot } from './account-snapshot.js';
export type { CoreAccountSnapshot } from './account-snapshot.js';

export type {
  SendOutcome,
  GetTxOutcome,
  TimeoutOutcome,
  PollOutcome,
  SimResult,
  LedgerHead,
  AccountSeqRead,
  Deadness,
  PollVerdict,
} from './outcomes.js';

export type {
  RpcPort,
  HorizonPort,
  Signer,
  WriteAheadJournal,
  Clock,
  UnpreparedTx,
  SubmittableTx,
  AccountSnapshotJson,
  HorizonBalanceLine,
} from './ports.js';

export { createStellarClient } from './client.js';
export type {
  StellarClient,
  StellarClientPorts,
  PayRequest,
  SubmitResult,
  ObserveResult,
} from './client.js';

// Concrete PoC seams for the composition root (SDK-free: a Map + Date.now, so they may cross the main surface).
export { buildSacMintTransaction } from './sac-mint.js';
export type { SacMintParams } from './sac-mint.js';
export { createSacMintClient } from './mint-client.js';
export type { SacMintPort, SacMintClientPorts, SacMintClientConfig } from './mint-client.js';

export { InMemoryJournal, SystemClock } from './in-memory-journal.js';

export { BuildError, SimulationError, SubmitError, DeadnessIndeterminate } from './errors.js';

export { cursorLedger } from './outflow-types.js';
export type {
  OutflowEvent,
  PoolFetch,
  PoolActivityPage,
  PoolTailPort,
  PoolUpgrade,
  SettlementObservation,
  TxLiveness,
} from './outflow-types.js';
