// Public surface of @troia/backend (composition layer). Phase 4.3a: the pure decision core (plan / mutation
// guard / revert classifier) + the impure engine (perform + driver). HTTP shell, Store impl, and composition
// root arrive in 4.3b-d.
export { initialState, transition } from '@troia/core';
export type { Effect, Event, State } from '@troia/core';

export { planEffect } from './engine/plan.js';
export type { EffectPlan, Port, FeedsEventVia } from './engine/plan.js';
export { classifyRevertCause, revertEvent } from './engine/classify-revert.js';
export type { RevertCause, RevertEvent } from './engine/classify-revert.js';
export {
  isObserveOnlyEvent,
  containsMutation,
  assertNoMutationOnUnknown,
} from './engine/mutation-guard.js';

export { perform } from './engine/perform.js';
export { run, start, advance, applyEscalate } from './engine/driver.js';
export type { RunResult, Quiescence } from './engine/driver.js';
export { decisionEvent, flagLossBucket, releaseReason } from './engine/events.js';
export type { EngineDeps, PerformResult, SideOutput } from './engine/events.js';
export { EngineError } from './engine/errors.js';

export type { EngineConfig, EngineStellarConfig, EnginePspConfig } from './engine/config.js';
export type { OrderCtx } from './ctx.js';
export type { PolicyConfig } from './policy.js';
export { OFFLINE_DEFAULT_POLICY } from './policy.js';
export type { PricingPolicy, PricingCommissionPolicy, PricingPspPolicy } from './pricing-policy.js';
export { OFFLINE_DEFAULT_PRICING_POLICY } from './pricing-policy.js';
export type {
  StellarPort,
  PspPort,
  Clock,
  Store,
  ReserveOutcome,
  ReleaseReason,
  LossBucket,
  InFlightPatch,
  EvidenceRecord,
  EvidenceRow,
  DurableLog,
} from './ports.js';

export { isDurableLogFailure } from './ports.js';

export {
  encodeEvidenceRow,
  decodeEvidenceRow,
  dedupeEvidence,
  EvidenceCodecError,
} from './store/evidence-codec.js';

export { Mutex, KeyedMutex } from './store/mutex.js';
export type { Lock } from './store/mutex.js';
export { ReservationLedger } from './store/reservation-ledger.js';
export type { Reservation } from './store/reservation-ledger.js';
export { InMemoryStore } from './store/in-memory-store.js';
export type { InMemoryStoreOptions } from './store/in-memory-store.js';

export { createApp } from './http/app.js';
export type { AppDeps, Quote, QuoteFn } from './http/app.js';
export { InMemoryOrderRegistry } from './http/order-registry.js';
export type { OrderRegistry, OrderRecord } from './http/order-registry.js';
export { toPublicStatus } from './http/public-status.js';
export type { PublicStatus } from './http/public-status.js';

export { pollInFlight } from './worker/poll-worker.js';
export type { PollReport } from './worker/poll-worker.js';

// TRY-driven rebalance (settlement-sim). The pure/impure pieces are here; the mint provider + the live-rate
// reader are concretes wired at the composition root.
export { InMemoryPendingSettlementStore } from './settlement/pending-settlement-store.js';
export type {
  PendingSettlementStore,
  PendingSettlement,
  PendingSettlementInput,
  SettlementStatus,
} from './settlement/pending-settlement-store.js';
export { TryDrivenRebalancePolicy } from './settlement/rebalance-policy.js';
export type { RebalancePolicy, TopUpRequest } from './settlement/rebalance-policy.js';
export { settleAndRebalance, tryToKurus } from './settlement/settlement-worker.js';
export type {
  SettleReport,
  SettlementDeps,
  TopUpExecution,
} from './settlement/settlement-worker.js';

export { buildEngineConfig, createServer } from './composition.js';
export type {
  EngineExtras,
  ServerDeps,
  ServerPorts,
  Server,
  SettlementBundle,
} from './composition.js';

export {
  checkDrift,
  observeDrift,
  INITIAL_DRIFT_STATE,
  DEFAULT_DRIFT_ALARM_AFTER,
} from './settlement/drift-worker.js';
export type {
  DriftTickReport,
  DriftMonitorState,
  DriftObservation,
} from './settlement/drift-worker.js';
