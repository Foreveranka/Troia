// PURE folding of a Soroban simulation result into a submittable transaction. This is the deterministic
// core of what @stellar/stellar-sdk's rpc.assembleTransaction does, reimplemented over stellar-base so the
// SDK never enters the pure core. Given identical (unprepared, sim) it yields byte-identical output, and
// hashOf(assembled) is the value SPIKE-2 persists BEFORE any send. Signing happens afterwards and does not
// change the hash.
//
// AUTH: pay() calls read_operator().require_auth() and the operator IS the tx source, so simulation returns
// a SorobanAuthorizationEntry with SOURCE-ACCOUNT credentials (no nonce, no per-entry signature). Like the
// SDK's assembleTransaction, we INJECT exactly those entries into the op — the tx-level operator signature
// then satisfies them on-chain. Source-account entries are deterministic (no nonce), so the assembled hash
// stays reproducible. A nonce-bearing ADDRESS credential would mean a non-source authorizer (non-reproducible
// and off-design), so we fail closed on it. The reconciler ignores op.auth, so decode/projection is unaffected.

import { Operation, TransactionBuilder, xdr } from '@stellar/stellar-base';
import type { SimResult } from './outcomes.js';
import type { SubmittableTx, UnpreparedTx } from './ports.js';
import { SimulationError } from './errors.js';

/**
 * Attach the simulated footprint + resource fee + source-account auth to the unprepared tx.
 * `cloneFrom({fee, sorobanData})` treats `fee` as the classic inclusion fee and ADDS the sorobanData's
 * resourceFee on top, so the final fee is (inclusion + resourceFee) — exactly the SDK's arithmetic. The op
 * is then rebuilt carrying the simulated source-account auth entries.
 */
export function assembleFromSimulation(unprepared: UnpreparedTx, sim: SimResult): SubmittableTx {
  const authEntries = sim.authXdr.map((b64) =>
    xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64'),
  );
  for (const entry of authEntries) {
    if (entry.credentials().switch().name !== 'sorobanCredentialsSourceAccount') {
      throw new SimulationError(
        'simulation returned a nonce-bearing (address) authorization entry; pay() must authorize via the source account only',
      );
    }
  }

  const sorobanData = xdr.SorobanTransactionData.fromXDR(sim.sorobanDataXdr, 'base64');
  const embeddedResourceFee = sorobanData.resourceFee().toString();
  if (embeddedResourceFee !== sim.minResourceFee) {
    throw new SimulationError(
      `inconsistent simulation: footprint resourceFee ${embeddedResourceFee} != minResourceFee ${sim.minResourceFee}`,
    );
  }

  const op = unprepared.operations[0];
  if (op === undefined || op.type !== 'invokeHostFunction') {
    throw new SimulationError('unprepared tx must be a single invokeHostFunction op');
  }

  const builder = TransactionBuilder.cloneFrom(unprepared, {
    fee: unprepared.fee, // inclusion fee only; cloneFrom adds sorobanData.resourceFee to reach the total
    sorobanData,
  });
  // Rebuild the single op WITH the simulated auth. cloneFrom preserves the original (empty-auth) op, so we
  // replace it; func is copied verbatim, keeping the exact pay() invocation the reconciler decodes. The op
  // source is forwarded verbatim (undefined for pay(), so the op inherits the tx source = operator), exactly
  // as the SDK's assembleTransaction does.
  builder.clearOperations();
  builder.addOperation(
    op.source === undefined
      ? Operation.invokeHostFunction({ func: op.func, auth: authEntries })
      : Operation.invokeHostFunction({ source: op.source, func: op.func, auth: authEntries }),
  );
  return builder.build();
}

/** The hex tx hash of the assembled tx — the value persisted before any send and recorded as evidence. */
export function hashOf(tx: SubmittableTx): string {
  return tx.hash().toString('hex');
}
