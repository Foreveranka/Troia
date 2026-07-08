// Offline test harness: fakes for the four injected ports + a shared ordered call TRACE (so tests can assert
// money-law ordering: reserve before submitPay, submit/observe before capture, evidence last). The Store fake
// wraps a REAL SequenceAllocator so all seq math (allocate/reuseOnDead/reallocate/confirmBurned/release) is
// exercised for real, not stubbed. All scriptable outputs default to the happy path and are overridable.

import { InMemorySequenceStore, SequenceAllocator, deriveIds } from '@troia/core';
import type { SequenceProvider } from '@troia/core';
import type {
  CoreAccountSnapshot,
  ObserveResult,
  PayRequest,
  ReducerState,
  SendOutcome,
  SubmitResult,
} from '@troia/stellar-client';
import type { PollVerdict } from '@troia/stellar-client';
import type { RawIyzicoResult, RetrieveCheckoutFormParams } from '@troia/psp';
import type { OrderCtx } from '../../src/ctx.js';
import type { EngineConfig } from '../../src/engine/config.js';
import type { EngineDeps } from '../../src/engine/events.js';
import type {
  Clock,
  EvidenceRecord,
  InFlightPatch,
  LossBucket,
  PspPort,
  ReleaseReason,
  ReserveOutcome,
  StellarPort,
  Store,
} from '../../src/ports.js';
import type { State } from '@troia/core';

export type Trace = string[];

export class FakeClock implements Clock {
  constructor(public now = 1_700_000_000) {}
  nowUnix(): number {
    return this.now;
  }
}

export function body(fields: Record<string, unknown>): RawIyzicoResult {
  return { kind: 'body', body: fields };
}
export const TIMEOUT: RawIyzicoResult = { kind: 'timeout' };

export class FakeStore implements Store {
  readonly sequences: SequenceProvider;
  readonly created = new Set<string>();
  readonly persisted: { orderId: string; state: State; patch: InFlightPatch }[] = [];
  readonly releases: { orderId: string; reason: ReleaseReason }[] = [];
  readonly losses: { orderId: string; bucket: LossBucket; usdcTxHash: string | null }[] = [];
  readonly evidence: { orderId: string; record: EvidenceRecord }[] = [];
  readonly deadRetries = new Map<string, number>();
  readonly reversalRetries = new Map<string, number>();
  reserveResult: ReserveOutcome = { kind: 'reserved', reservationId: 'res-1' };
  availableResult = 1_000_000_000_000n; // large by default (gate passes); scriptable for circuit-breaker tests

  constructor(
    private readonly trace: Trace,
    baseSeq = 1000n,
  ) {
    this.sequences = new SequenceAllocator(new InMemorySequenceStore(), baseSeq);
  }

  async createIfAbsent(orderId: string): Promise<'created' | 'exists'> {
    this.trace.push('store.createIfAbsent');
    if (this.created.has(orderId)) return 'exists';
    this.created.add(orderId);
    return 'created';
  }
  async persistState(orderId: string, next: State, patch: InFlightPatch): Promise<void> {
    this.trace.push(`store.persistState:${next}`);
    this.persisted.push({ orderId, state: next, patch });
  }
  async reserve(): Promise<ReserveOutcome> {
    this.trace.push('store.reserve');
    return this.reserveResult;
  }
  async releaseReservation(orderId: string, reason: ReleaseReason): Promise<void> {
    this.trace.push(`store.releaseReservation:${reason}`);
    this.releases.push({ orderId, reason });
  }
  async flagLoss(orderId: string, bucket: LossBucket, usdcTxHash: string | null): Promise<void> {
    this.trace.push(`store.flagLoss:${bucket}`);
    this.losses.push({ orderId, bucket, usdcTxHash });
  }
  async markWebhookSeen(): Promise<'first' | 'duplicate'> {
    return 'first';
  }
  async appendEvidence(orderId: string, record: EvidenceRecord): Promise<void> {
    this.trace.push('store.appendEvidence');
    this.evidence.push({ orderId, record });
  }
  async bumpDeadRetries(orderId: string): Promise<number> {
    const n = (this.deadRetries.get(orderId) ?? 0) + 1;
    this.deadRetries.set(orderId, n);
    return n;
  }
  async bumpReversalRetries(orderId: string): Promise<number> {
    const n = (this.reversalRetries.get(orderId) ?? 0) + 1;
    this.reversalRetries.set(orderId, n);
    return n;
  }
  readonly credits: bigint[] = [];
  async creditPool(stroops: bigint): Promise<void> {
    this.trace.push('store.creditPool');
    this.credits.push(stroops);
    this.availableResult += stroops; // reflect the landed top-up so a later gate read sees it
  }
  availableStroops(): bigint {
    return this.availableResult;
  }
}

export class FakeStellarPort implements StellarPort {
  readonly submitReqs: PayRequest[] = [];
  observeVerdict: PollVerdict = 'LANDED_SUCCESS';
  revertCode: number | null = null;

  constructor(private readonly trace: Trace) {}

  async submitPay(req: PayRequest): Promise<SubmitResult> {
    this.trace.push('stellar.submitPay');
    this.submitReqs.push(req);
    const hashHex = `hash_${req.orderId}`;
    const outcome: SendOutcome = { kind: 'PENDING', hashHex };
    return { hashHex, signedXdr: `xdr_${req.orderId}`, seq: req.seq, outcome };
  }
  async resendPersisted(): Promise<SendOutcome> {
    return { kind: 'TRY_AGAIN' };
  }
  async observe(state: ReducerState): Promise<ObserveResult> {
    this.trace.push('stellar.observe');
    return { next: state, action: 'none', verdict: this.observeVerdict };
  }
  async loadDestinationSnapshot(): Promise<CoreAccountSnapshot> {
    return { exists: true, trustlines: [{ assetCode: 'USDC', assetIssuer: 'GISSUER' }] };
  }
  async readPoolBalanceStroops(): Promise<bigint> {
    return 0n;
  }
  async readRevertErrorCode(): Promise<number | null> {
    this.trace.push('stellar.readRevertErrorCode');
    return this.revertCode;
  }
}

export class FakePspPort implements PspPort {
  init: RawIyzicoResult = body({ status: 'success', token: 'tok-1', checkoutFormContent: '<html/>', conversationId: 'cid', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com/?token=tok-1' });
  cancelResult: RawIyzicoResult = body({ status: 'success', conversationId: 'cid' });

  constructor(private readonly trace: Trace) {}

  async initializeCheckoutForm(): Promise<RawIyzicoResult> {
    this.trace.push('psp.initializeCheckoutForm');
    return this.init;
  }
  retrievePaymentStatus = 'SUCCESS';
  retrieveFraudStatus: number | undefined = 1; // paymentStatus SUCCESS + fraudStatus 1 => chargeEvent -> chargeOk
  retrievePhase: string | undefined = undefined; // undefined/AUTH => a captured sale; PRE_AUTH would read UNKNOWN
  async retrieveCheckoutFormResult(p: RetrieveCheckoutFormParams): Promise<RawIyzicoResult> {
    this.trace.push('psp.retrieveCheckoutFormResult');
    // echo the backend-issued token + conversationId so the webhook cross-checks pass
    return body({
      status: 'success',
      token: p.token,
      paymentId: 'pay-1',
      paymentStatus: this.retrievePaymentStatus,
      fraudStatus: this.retrieveFraudStatus,
      ...(this.retrievePhase !== undefined ? { phase: this.retrievePhase } : {}),
      conversationId: p.conversationId,
    });
  }
  async cancel(): Promise<RawIyzicoResult> {
    this.trace.push('psp.cancel');
    return this.cancelResult;
  }
}

export interface Harness {
  readonly deps: EngineDeps;
  readonly store: FakeStore;
  readonly stellar: FakeStellarPort;
  readonly psp: FakePspPort;
  readonly clock: FakeClock;
  readonly config: EngineConfig;
  readonly trace: Trace;
}

export function makeConfig(): EngineConfig {
  return {
    stellar: {
      operatorPublic: 'GOPERATORPUBLICKEYPLACEHOLDER000000000000000000',
      troyPool: 'CTROYPOOLCONTRACTIDPLACEHOLDER00000000000000000000',
      passphrase: 'Test SDF Network ; September 2015',
      usdcIssuer: 'GISSUER',
      feeStroops: '100',
      timeboundsSecs: 45,
    },
    psp: {
      callbackUrl: 'https://troia.test/webhook/iyzico',
      currency: 'TRY',
      paymentGroup: 'PRODUCT',
      locale: 'tr',
      buyer: {
        id: 'buyer-stub',
        name: 'Troia',
        surname: 'Buyer',
        identityNumber: '11111111111',
        email: 'buyer@troia.test',
        registrationAddress: 'Test Mah. Test Cad. No:1',
        city: 'Istanbul',
        country: 'Turkey',
        ip: '0.0.0.0',
      },
      shippingAddress: { contactName: 'Troia Buyer', city: 'Istanbul', country: 'Turkey', address: 'Test Mah. No:1' },
      billingAddress: { contactName: 'Troia Buyer', city: 'Istanbul', country: 'Turkey', address: 'Test Mah. No:1' },
      basketItemTemplate: { id: 'item-1', name: 'USDC settlement', category1: 'Settlement', itemType: 'VIRTUAL' },
    },
    policy: {
      maxDeadRetries: 3,
      maxReversalRetries: 3,
      reservationTtlMs: 600_000,
      poolLowWatermarkStroops: 0n,
    },
  };
}

export function makeHarness(): Harness {
  const trace: Trace = [];
  const store = new FakeStore(trace);
  const stellar = new FakeStellarPort(trace);
  const psp = new FakePspPort(trace);
  const clock = new FakeClock();
  const config = makeConfig();
  return { deps: { stellar, psp, store, clock, config }, store, stellar, psp, clock, config, trace };
}

const DESTINATION = 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000';
const AMOUNT = 1_000_000_000n; // 100.0 USDC @ 7 decimals
const RATE = 340_000_000n; // 34.0 TRY/USDC @ 7 decimals

/** A PRE-charge OrderCtx exactly as POST /intent builds it under late allocation (Approach B): activeSeq is
 *  NULL — the operator seq is handed out later, on chargeOk. Allocates NOTHING in the store. Use for
 *  Reserved / SolvencyReserved rows and every no-leak / late-allocation assertion. */
export function makePreChargeCtx(_store: FakeStore, overrides: Partial<OrderCtx> = {}): OrderCtx {
  const orderId = overrides.orderId ?? 'order-001';
  const ids = deriveIds(orderId, DESTINATION, AMOUNT);
  return {
    orderId,
    conversationId: ids.idempotencyKeyHex,
    destination: DESTINATION,
    amountStroops: AMOUNT,
    appliedRateStroops: RATE,
    memoHex: ids.memoHex,
    paymentId: 'pay-1',
    token: null,
    paymentPageUrl: null,
    paidPriceTry: '3400.00',
    currency: 'TRY',
    ip: '1.2.3.4',
    activeSeq: null,
    hashHex: null,
    signedXdr: null,
    payMaxTimeUnix: null,
    deadRetries: 0,
    reversalRetries: 0,
    ...overrides,
  };
}

/** A POST-charge OrderCtx with a REAL allocated seq (the order is past chargeOk — UsdcSubmitted and later),
 *  so submitPay's seq math runs for real. Under late allocation a seq only exists once the charge succeeded,
 *  so this is the honest ctx for any state at/after the USDC leg. Overridable. */
export function makeCtx(store: FakeStore, overrides: Partial<OrderCtx> = {}): OrderCtx {
  const orderId = overrides.orderId ?? 'order-001';
  const seq = store.sequences.allocate(orderId);
  return makePreChargeCtx(store, { activeSeq: seq.toString(), ...overrides });
}
