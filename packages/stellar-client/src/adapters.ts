// The composition-root barrel for the CONCRETE, SDK-carrying stellar-client implementations. Exposed via the
// package's "./adapters" export ONLY — never re-exported from index.ts, which stays SDK-free per the keyless
// boundary (no @stellar/stellar-sdk Server type crosses the main surface). The composition root imports these to
// build a live StellarClient; nothing else should reach for them.

export { SorobanRpcAdapter } from './rpc-adapter.js';
export { HorizonAdapter } from './horizon-adapter.js';
export { LocalKeySigner } from './signer.js';
