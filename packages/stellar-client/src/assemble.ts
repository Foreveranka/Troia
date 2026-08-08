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

import { Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-base';
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

/**
 * CHANNEL MODE (A-5): assemble with EXPLICITLY SIGNED auth entries instead of the simulation's raw ones.
 *
 * When the tx source is a channel account, `pay()`'s `require_auth(operator)` comes back from simulation as
 * an ADDRESS-credential entry (nonce, no signature yet) — the shape `assembleFromSimulation` deliberately
 * fails closed on, because in single-operator mode it can only mean a mis-built tx. Here it is the expected
 * shape, and the caller has already had the operator sign each entry (Signer.signAuthEntry). This function
 * verifies — fail-closed, before anything is hashed or persisted — that every entry is:
 *   1. an ADDRESS credential (a source-account entry here would authorize the CHANNEL, which holds no
 *      contract authority — accepting it would build a tx that can only revert on-chain),
 *   2. for the OPERATOR address (nobody else's authority belongs in a pay()),
 *   3. actually SIGNED (a void signature would burn a channel seq on a tx doomed to fail auth).
 * The fee/sorobanData arithmetic is identical to assembleFromSimulation.
 */
export function assembleWithSignedAuth(
  unprepared: UnpreparedTx,
  sim: SimResult,
  signedEntriesB64: readonly string[],
  operatorPublic: string,
): SubmittableTx {
  if (signedEntriesB64.length !== sim.authXdr.length) {
    throw new SimulationError(
      `signed auth entries (${signedEntriesB64.length}) do not match the simulation's (${sim.authXdr.length})`,
    );
  }
  const authEntries = signedEntriesB64.map((b64) =>
    xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64'),
  );
  for (const entry of authEntries) {
    if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') {
      throw new SimulationError(
        'channel mode requires ADDRESS-credential auth entries (a source-account entry would authorize the channel, not the operator)',
      );
    }
    const creds = entry.credentials().address();
    const addr = xdrAddressToStrkey(creds.address());
    if (addr !== operatorPublic) {
      throw new SimulationError(
        `auth entry authorizes ${addr}, not the operator — refusing to assemble`,
      );
    }
    if (creds.signature().switch().name === 'scvVoid') {
      throw new SimulationError('auth entry is unsigned — refusing to assemble an auth-doomed tx');
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
    fee: unprepared.fee,
    sorobanData,
  });
  builder.clearOperations();
  builder.addOperation(
    op.source === undefined
      ? Operation.invokeHostFunction({ func: op.func, auth: authEntries })
      : Operation.invokeHostFunction({ source: op.source, func: op.func, auth: authEntries }),
  );
  return builder.build();
}

/** The G-address of an ScAddress account credential (contract credentials cannot authorize pay()). */
function xdrAddressToStrkey(address: xdr.ScAddress): string {
  if (address.switch().name !== 'scAddressTypeAccount') {
    return `<contract:${address.switch().name}>`; // never equals a G-address -> fails the operator check
  }
  return StrKey.encodeEd25519PublicKey(address.accountId().ed25519());
}
