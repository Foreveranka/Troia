// The impure CONDUCTOR. It owns ORDERING only — build -> simulate -> assemble -> hash -> persist -> sign
// -> send -> observe(reducer) -> deadness — and holds NO money-branching of its own (all of that is in the
// pure core). It depends only on the injected ports, so it is fully offline-testable with fakes (see
// write-ahead-ordering and idempotent-resend specs). No @stellar/stellar-sdk type crosses this file.

import { assembleFromSimulation, hashOf } from './assemble.js';
import { buildPayTransaction } from './build.js';
import type { BuildParams } from './build.js';
import { deadnessToVerdict, resolveDeadness } from './deadness.js';
import { toAccountSnapshot } from './account-snapshot.js';
import type { CoreAccountSnapshot } from './account-snapshot.js';
import { SubmitError } from './errors.js';
import type { Clock, HorizonPort, RpcPort, Signer, WriteAheadJournal } from './ports.js';
import type { Deadness, PollVerdict, SendOutcome } from './outcomes.js';
import { step } from './submit-reducer.js';
import type { ReducerAction, ReducerState } from './submit-reducer.js';

export interface StellarClientPorts {
  readonly rpc: RpcPort;
  readonly horizon: HorizonPort;
  readonly signer: Signer;
  readonly journal: WriteAheadJournal;
  readonly clock: Clock;
}

/** A payout request = the build parameters plus the order id used as the write-ahead key. */
export type PayRequest = BuildParams & { readonly orderId: string };

export interface SubmitResult {
  readonly hashHex: string;
  readonly signedXdr: string;
  readonly seq: string;
  readonly outcome: SendOutcome;
}

export interface ObserveResult {
  readonly next: ReducerState;
  readonly action: ReducerAction;
  readonly verdict?: PollVerdict;
  readonly deadness?: Deadness;
}

export interface StellarClient {
  /** build -> simulate -> assemble -> hash -> SIGN -> persist(before send) -> send. Returns the persisted
   *  hash + bytes so the caller records evidence and can drive the poll loop. */
  submitPay(req: PayRequest): Promise<SubmitResult>;
  /** Idempotent recovery: resend the EXACT persisted envelope. Never rebuilds/re-simulates/re-signs. */
  resendPersisted(orderId: string): Promise<SendOutcome>;
  /** One poll cycle: getTransaction -> reducer step; if the step is uncertain, run the authoritative
   *  deadness read (on-chain seq + ledger close time) and return the verdict. */
  observe(state: ReducerState): Promise<ObserveResult>;
  /** Destination preflight snapshot (exists + trustlines) for PayoutIntent.build. */
  loadDestinationSnapshot(destination: string): Promise<CoreAccountSnapshot>;
}

export function createStellarClient(ports: StellarClientPorts): StellarClient {
  const operatorPublic = ports.signer.publicKey();

  return {
    async submitPay(req) {
      const unprepared = buildPayTransaction(req);
      const sim = await ports.rpc.simulate(unprepared);
      const submittable = assembleFromSimulation(unprepared, sim);
      const hashHex = hashOf(submittable);
      const signedXdr = ports.signer.sign(submittable);
      // WRITE-AHEAD: the exact signed bytes + hash are durable BEFORE any send. A crash after this leaves a
      // byte-exact, resubmittable artifact; recovery resends it verbatim (never a fresh build on a live seq).
      await ports.journal.persistPreSubmit(req.orderId, submittable.sequence, hashHex, signedXdr);
      const outcome = await ports.rpc.send(signedXdr);
      return { hashHex, signedXdr, seq: submittable.sequence, outcome };
    },

    async resendPersisted(orderId) {
      const persisted = await ports.journal.loadPersisted(orderId);
      if (persisted === null) {
        throw new SubmitError(`no persisted envelope for order ${orderId} — cannot resend`);
      }
      return ports.rpc.send(persisted.signedXdr);
    },

    async observe(state) {
      const outcome = await ports.rpc.getTransaction(state.hashHex);
      const r = step(state, outcome);
      if (r.action !== 'resolveDeadness') {
        return r.verdict === undefined
          ? { next: r.next, action: r.action }
          : { next: r.next, action: r.action, verdict: r.verdict };
      }
      // Authoritative deadness read: on-chain seq (was our slot burned?) + ledger close time (expired?).
      // Expiry is ledger-sourced, NEVER the local clock, so skew can never free a still-live seq.
      const [seqRead, head] = await Promise.all([
        ports.rpc.readAccountSeq(operatorPublic),
        ports.rpc.latestLedger(),
      ]);
      const timeboundsExpired = state.maxTime > 0 && head.closeTimeUnix > state.maxTime;
      // A live SUCCESS is concluded at the reducer (action 'none') and never reaches here, so in practice
      // this is always NOT_FOUND; the ternary is defensive. An aged-out success is caught fail-closed by
      // the seq-burned branch (accountSeq >= ourSeq -> LOSS_REVIEW), whose authority is the reconciler scan.
      const hashLookup: 'SUCCESS' | 'NOT_FOUND' =
        outcome.kind === 'SUCCESS' ? 'SUCCESS' : 'NOT_FOUND';
      // An unresolvable operator-seq read fails CLOSED (seqKnown:false -> LOSS_REVIEW), never SAFE_TO_REPLACE.
      const deadness = resolveDeadness({
        accountSeq: seqRead.exists ? BigInt(seqRead.seq) : 0n,
        ourSeq: state.ourSeq,
        timeboundsExpired,
        hashLookup,
        seqKnown: seqRead.exists,
      });
      return { next: r.next, action: r.action, verdict: deadnessToVerdict(deadness), deadness };
    },

    async loadDestinationSnapshot(destination) {
      const json = await ports.horizon.loadAccountSnapshot(destination);
      return toAccountSnapshot(json);
    },
  };
}
