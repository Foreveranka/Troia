import { describe, expect, it } from 'vitest';
import {
  chargeEvent,
  classifyIyzicoResult,
  reversalEvent,
  TERMINAL_DECLINE_WHITELIST,
} from '../src/classify.js';
import type { PspOp, RawIyzicoResult } from '../src/outcomes.js';

const body = (b: Record<string, unknown>): RawIyzicoResult => ({ kind: 'body', body: b });
const CHARGE_OPS: PspOp[] = ['preauth', 'checkout', 'capture', 'sale'];

describe('classifyIyzicoResult — the money-safety oracle (UNKNOWN is the safe default)', () => {
  it('never SUCCESS on ambiguity: transport/parse failures and empty envelopes are UNKNOWN for every op', () => {
    const ambiguous: RawIyzicoResult[] = [
      { kind: 'timeout' },
      { kind: 'malformed', reason: '5xx' },
      body({}), // missing status
      body({ status: 'weird' }), // unknown status value
      body({ status: 123 as unknown as string }), // wrong-typed status
    ];
    for (const op of ['preauth', 'capture', 'void', 'refund', 'checkout'] as PspOp[]) {
      for (const raw of ambiguous) expect(classifyIyzicoResult(raw, op)).toBe('UNKNOWN');
    }
  });

  it('SUCCESS only on the exact terminal-success shape per op', () => {
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }),
        'preauth',
      ),
    ).toBe('SUCCESS');
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }),
        'checkout',
      ),
    ).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success', paymentId: 'p1' }), 'capture')).toBe(
      'SUCCESS',
    );
    expect(classifyIyzicoResult(body({ status: 'success' }), 'void')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ status: 'success' }), 'refund')).toBe('SUCCESS');
  });

  it('a success envelope with a non-terminal / fraud-review payment is UNKNOWN, not SUCCESS', () => {
    // 'FAILURE' is UNKNOWN too (not a charge FAILURE): iyzico's hosted form allows a retry on the SAME token, so a
    // failed attempt is not terminal — keeping it UNKNOWN lets a retry-success settle the order (see the dedicated
    // retry-safety test below).
    for (const paymentStatus of [
      'INIT_THREEDS',
      'CALLBACK_THREEDS',
      'BKM_POS_SELECTED',
      'PENDING_CREDIT',
      'FAILURE',
    ]) {
      expect(
        classifyIyzicoResult(body({ status: 'success', paymentStatus, fraudStatus: 1 }), 'preauth'),
      ).toBe('UNKNOWN');
    }
    // fraud not approved (0 = manual review, -1 = reject) is UNKNOWN even with paymentStatus SUCCESS
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 0 }),
        'preauth',
      ),
    ).toBe('UNKNOWN');
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: -1 }),
        'preauth',
      ),
    ).toBe('UNKNOWN');
    // capture success envelope but no paymentId, or an error present -> UNKNOWN
    expect(classifyIyzicoResult(body({ status: 'success' }), 'capture')).toBe('UNKNOWN');
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentId: 'p1', errorCode: '10051' }),
        'capture',
      ),
    ).toBe('UNKNOWN');
  });

  it('capture never reads a PRE_AUTH (uncaptured hold) or a numeric-error body as captured', () => {
    // a PRE_AUTH payment-detail is a live, UNCAPTURED hold -> must be UNKNOWN, never captured
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentId: 'p1', phase: 'PRE_AUTH' }),
        'capture',
      ),
    ).toBe('UNKNOWN');
    // a real capture (phase POST_AUTH, or phase absent) is SUCCESS
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentId: 'p1', phase: 'POST_AUTH' }),
        'capture',
      ),
    ).toBe('SUCCESS');
    // an error field of ANY type (numeric, not just string) blocks SUCCESS
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentId: 'p1', errorCode: 10051 as unknown as string }),
        'capture',
      ),
    ).toBe('UNKNOWN');
  });

  it('sale (direct charge) is SUCCESS only on a captured shape with a paymentId, and NEVER on a PRE_AUTH hold', () => {
    const captured = {
      status: 'success',
      paymentId: 'pay-1',
      paymentStatus: 'SUCCESS',
      fraudStatus: 1,
    };
    // a completed direct sale (phase absent or AUTH) with a paymentId is a real captured charge
    expect(classifyIyzicoResult(body(captured), 'sale')).toBe('SUCCESS');
    expect(classifyIyzicoResult(body({ ...captured, phase: 'AUTH' }), 'sale')).toBe('SUCCESS');
    // the money-safety shield: a still-live PRE_AUTH hold must NEVER read as charged (would send USDC vs a hold)
    expect(classifyIyzicoResult(body({ ...captured, phase: 'PRE_AUTH' }), 'sale')).toBe('UNKNOWN');
    // a SUCCESS shape with NO paymentId must read UNKNOWN — a chargeOk we could not later void is money-unsafe
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }),
        'sale',
      ),
    ).toBe('UNKNOWN');
    // intermediate paymentStatus or fraud-review -> UNKNOWN
    expect(
      classifyIyzicoResult(body({ ...captured, paymentStatus: 'CALLBACK_THREEDS' }), 'sale'),
    ).toBe('UNKNOWN');
    expect(classifyIyzicoResult(body({ ...captured, fraudStatus: 0 }), 'sale')).toBe('UNKNOWN');
  });

  it('a paymentStatus FAILURE stays UNKNOWN (retry-safe) — never a fail-clean that could strand a retry capture', () => {
    // MONEY-SAFETY (live-smoke lesson): iyzico's hosted form lets the customer retry on the SAME token, so a
    // success-envelope paymentStatus 'FAILURE' (e.g. a failed 3DS, mdStatus 0) is NOT terminal — a later attempt
    // may CAPTURE. Classifying it FAILURE would fail-clean the order, and a subsequent retry-success would then be
    // stranded (charged TRY, no USDC, no void = LOSS). So it must read UNKNOWN: the order stays open and a
    // retry-success settles it (chargeUnknown, re-driven by the recovery worklist). A genuinely abandoned order's
    // sequence is freed by late seq allocation, NOT by fail-cleaning a possibly-retryable charge.
    const failed = { status: 'success', paymentStatus: 'FAILURE', mdStatus: 0, paymentId: 'p1' };
    for (const op of ['sale', 'checkout', 'preauth'] as PspOp[]) {
      expect(classifyIyzicoResult(body(failed), op)).toBe('UNKNOWN');
    }
    expect(chargeEvent(body(failed))).toEqual({ type: 'chargeUnknown' });
  });

  it('an out-of-enum op fails safe to UNKNOWN', () => {
    expect(
      classifyIyzicoResult(
        body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }),
        'bogus' as PspOp,
      ),
    ).toBe('UNKNOWN');
  });

  it('FAILURE for a charge only on the CLOSED terminal-decline whitelist; unlisted codes are UNKNOWN', () => {
    for (const code of TERMINAL_DECLINE_WHITELIST) {
      for (const op of CHARGE_OPS) {
        expect(classifyIyzicoResult(body({ status: 'failure', errorCode: code }), op)).toBe(
          'FAILURE',
        );
      }
    }
    // an unlisted / transient / missing code must NOT be a FAILURE (fail-safe -> UNKNOWN)
    expect(classifyIyzicoResult(body({ status: 'failure', errorCode: '99999' }), 'preauth')).toBe(
      'UNKNOWN',
    );
    expect(classifyIyzicoResult(body({ status: 'failure' }), 'preauth')).toBe('UNKNOWN');
    expect(
      classifyIyzicoResult(body({ status: 'failure', errorCode: 'SYSTEM_ERROR' }), 'capture'),
    ).toBe('UNKNOWN');
  });

  it('void/refund failure is a definitive (retry-safe) FAILURE, independent of the charge whitelist', () => {
    expect(classifyIyzicoResult(body({ status: 'failure', errorCode: 'anything' }), 'void')).toBe(
      'FAILURE',
    );
    expect(classifyIyzicoResult(body({ status: 'failure' }), 'refund')).toBe('FAILURE');
  });

  it('property: SUCCESS is emitted ONLY on a whitelisted success shape, never on ambiguity', () => {
    // garbled success envelopes with random extra/missing fields never yield SUCCESS for a charge unless
    // the exact (paymentStatus===SUCCESS && fraudStatus===1) holds.
    const junk = [
      body({ status: 'success' }),
      body({ status: 'success', paymentStatus: 'SUCCESS' }), // no fraudStatus
      body({ status: 'success', fraudStatus: 1 }), // no paymentStatus
      body({ status: 'success', paymentStatus: 'success', fraudStatus: 1 }), // lowercase != 'SUCCESS'
      body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: '1' as unknown as number }),
    ];
    for (const raw of junk) expect(classifyIyzicoResult(raw, 'preauth')).toBe('UNKNOWN');
  });
});

describe('per-op mappers onto core §3 events', () => {
  it('chargeEvent maps SUCCESS/FAILURE/UNKNOWN -> chargeOk/Rejected/Unknown (captured shape only)', () => {
    expect(
      chargeEvent(
        body({ status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1 }),
      ),
    ).toEqual({ type: 'chargeOk' });
    expect(chargeEvent(body({ status: 'failure', errorCode: '10051' }))).toEqual({
      type: 'chargeRejected',
    });
    expect(chargeEvent({ kind: 'timeout' })).toEqual({ type: 'chargeUnknown' });
    // a PRE_AUTH hold is never a completed charge -> Unknown (re-driven by the recovery worklist, no USDC)
    expect(
      chargeEvent(
        body({
          status: 'success',
          paymentId: 'pay-1',
          paymentStatus: 'SUCCESS',
          fraudStatus: 1,
          phase: 'PRE_AUTH',
        }),
      ),
    ).toEqual({ type: 'chargeUnknown' });
    // a SUCCESS shape with NO paymentId -> chargeUnknown (never a chargeOk we could not unwind)
    expect(
      chargeEvent(body({ status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 })),
    ).toEqual({ type: 'chargeUnknown' });
  });

  it('LATE-ALLOCATION SAFETY: a success-envelope charge NEVER classifies as chargeRejected (only status:failure does)', () => {
    // Load-bearing invariant behind Approach B (late sequence allocation): the operator seq is handed out ONLY
    // on chargeOk, and the clean-failure edges (chargeRejected / checkoutInitFailed -> FailedClean) drop the old
    // releaseSeq because they PROVABLY never hold a seq. That proof rests on iyzico retrieve monotonicity: a sale
    // that once produced chargeOk (a captured success-envelope) can only re-retrieve as chargeOk or chargeUnknown
    // — NEVER chargeRejected. chargeRejected requires status:'failure' + a whitelisted decline code; a
    // status:'success' body can never satisfy it (status is one field). So no completed charge can slip onto a
    // seq-freeing FailedClean edge while holding a late-allocated seq. This test pins that asymmetry.
    const successEnvelopes: Record<string, unknown>[] = [
      { status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 1 }, // the captured chargeOk shape
      { status: 'success', paymentId: 'pay-1', paymentStatus: 'SUCCESS', fraudStatus: 0 }, // fraud review -> Unknown
      { status: 'success', paymentId: 'pay-1', paymentStatus: 'FAILURE', mdStatus: 0 }, // failed 3DS attempt (retry-safe)
      { status: 'success', paymentStatus: 'INIT_THREEDS', fraudStatus: 1 }, // intermediate -> Unknown
      { status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1 }, // no paymentId -> Unknown
      { status: 'success' }, // bare success envelope
      {
        status: 'success',
        paymentId: 'pay-1',
        paymentStatus: 'SUCCESS',
        fraudStatus: 1,
        phase: 'PRE_AUTH',
      }, // live hold
    ];
    for (const env of successEnvelopes) {
      expect(chargeEvent(body(env)).type, JSON.stringify(env)).not.toBe('chargeRejected');
    }
    // and the converse: chargeRejected ONLY ever comes from a status:'failure' + a whitelisted decline code.
    for (const code of TERMINAL_DECLINE_WHITELIST) {
      expect(chargeEvent(body({ status: 'failure', errorCode: code }))).toEqual({
        type: 'chargeRejected',
      });
    }
    expect(chargeEvent(body({ status: 'failure', errorCode: '99999' }))).toEqual({
      type: 'chargeUnknown',
    }); // non-whitelisted -> Unknown
  });

  it('reversalEvent: only SUCCESS confirms; FAILURE and UNKNOWN both re-drive within budget (no reversalUnknown-stay)', () => {
    expect(reversalEvent(body({ status: 'success' }), true)).toEqual({ type: 'reversalConfirmed' });
    expect(reversalEvent(body({ status: 'failure' }), true)).toEqual({
      type: 'reversalNotDone',
      retriesRemaining: true,
    });
    expect(reversalEvent(body({ status: 'failure' }), false)).toEqual({
      type: 'reversalNotDone',
      retriesRemaining: false,
    });
    // an UNKNOWN (timeout) void re-drives within budget too — a same-day void is idempotent, so it must NEVER
    // become a bare observe-only stay that strands a charged order (adversarial finding #1).
    expect(reversalEvent({ kind: 'timeout' }, true)).toEqual({
      type: 'reversalNotDone',
      retriesRemaining: true,
    });
  });
});

describe('live iyzico sandbox ground truth (Phase 4.5 success-shape calibration)', () => {
  // The exact money-safety-relevant fields retrieveCheckoutFormResult returned for a REAL sandbox direct-sale
  // charge (Troy test card 9792072000017956, paymentId 36418597, 2026-07-07). This pins the OBSERVED shape so
  // our synthetic fixtures cannot silently drift from reality: paymentStatus is UPPERCASE 'SUCCESS', fraudStatus
  // is the NUMBER 1, phase is 'AUTH' (a captured sale, not a PRE_AUTH hold), and a real paymentId is present.
  const LIVE_SALE_SUCCESS = {
    status: 'success',
    paymentStatus: 'SUCCESS',
    fraudStatus: 1,
    phase: 'AUTH',
    paymentId: '36418597',
    errorCode: null,
  };

  it('classifies the real sandbox charge as SUCCESS -> chargeOk (backend advances to the USDC leg)', () => {
    expect(classifyIyzicoResult(body(LIVE_SALE_SUCCESS), 'sale')).toBe('SUCCESS');
    expect(chargeEvent(body(LIVE_SALE_SUCCESS))).toEqual({ type: 'chargeOk' });
  });

  it('the real response types match the classifier assumptions (regression guard against a shape drift)', () => {
    // if iyzico ever returned fraudStatus as a string, paymentStatus lowercase, or a PRE_AUTH phase, the
    // classifier would (correctly) fall to UNKNOWN — these assertions pin the real shape we calibrated against.
    expect(typeof LIVE_SALE_SUCCESS.fraudStatus).toBe('number');
    expect(LIVE_SALE_SUCCESS.paymentStatus).toBe('SUCCESS');
    expect(LIVE_SALE_SUCCESS.phase).not.toBe('PRE_AUTH');
    expect(typeof LIVE_SALE_SUCCESS.paymentId).toBe('string');
  });

  // The exact shape retrieveCheckoutFormResult returned for a REAL sandbox failed 3DS (paymentStatus 'FAILURE',
  // mdStatus 0). A later live Troy run (order 3480449, card 9792072000017956) proved this is NOT terminal: the
  // SAME order read 'FAILURE' at one poll, then 'SUCCESS' / mdStatus 1 with the money CAPTURED after the customer
  // retried the 3DS. So a 'FAILURE' retrieve MUST stay UNKNOWN (keep the order open for the retry), never a
  // fail-clean that would strand the eventual capture.
  const LIVE_SALE_FAILURE = {
    status: 'success',
    paymentStatus: 'FAILURE',
    mdStatus: 0,
    fraudStatus: 1,
    paymentId: '36434664',
    errorMessage: null,
  };

  it('classifies the real sandbox failed 3DS as UNKNOWN -> chargeUnknown (retry-safe; a retry may still capture)', () => {
    expect(classifyIyzicoResult(body(LIVE_SALE_FAILURE), 'sale')).toBe('UNKNOWN');
    expect(chargeEvent(body(LIVE_SALE_FAILURE))).toEqual({ type: 'chargeUnknown' });
  });
});

describe('Phase 4.5 decline-code calibration (iyzico published taxonomy + declining test cards)', () => {
  // The errorCode each declining iyzico SANDBOX test card returns (docs.iyzico.com test cards) — the real values
  // the whitelist must catch. errorCode is a quoted STRING in the raw body (e.g. "10051"), which readString reads.
  const DECLINE_TEST_CARDS: Array<[string, string]> = [
    ['10051', 'insufficient funds (4111111111111129)'],
    ['10005', 'do not honour (4129111111111111)'],
    ['10012', 'invalid transaction (4128111111111112)'],
    ['10041', 'lost card (4127111111111113)'],
    ['10043', 'stolen card (4126111111111114)'],
    ['10054', 'expired card (4125111111111115)'],
    ['10057', 'not permitted to cardholder (4123111111111117)'],
    ['10034', 'fraud suspect (4121111111111119)'],
  ];

  it('classifies every real declining test card as a definitive charge FAILURE (chargeRejected)', () => {
    for (const [code] of DECLINE_TEST_CARDS) {
      expect(classifyIyzicoResult(body({ status: 'failure', errorCode: code }), 'sale')).toBe(
        'FAILURE',
      );
      expect(chargeEvent(body({ status: 'failure', errorCode: code }))).toEqual({
        type: 'chargeRejected',
      });
    }
  });

  it('MONEY-SAFETY: outcome-UNCERTAIN codes stay UNKNOWN, never wrongly fail-clean a possibly-captured charge', () => {
    // For these the charge MAY have gone through, so the backend must re-retrieve/reconcile — NEVER FailedClean.
    const uncertain = [
      '10202', // general / unknown processing error
      '10230', // request errored at the bank (true state unknown)
      '10058', // terminal not authorized — merchant misconfig (surfaced, not silently failed)
      '10220', // generic DECLINED, "try again"
      '10214', // bank comms / system error
      '10219', // bank request timeout
      '6000', // unverifiable iyzico code (not in any official source)
      '1', // system error
      '2', // system error
    ];
    for (const code of uncertain) {
      expect(classifyIyzicoResult(body({ status: 'failure', errorCode: code }), 'sale')).toBe(
        'UNKNOWN',
      );
      expect(chargeEvent(body({ status: 'failure', errorCode: code }))).toEqual({
        type: 'chargeUnknown',
      });
    }
  });

  it('pins the exact calibrated whitelist (regression: additions must be deliberate + money-safe)', () => {
    expect([...TERMINAL_DECLINE_WHITELIST].sort()).toEqual(
      [
        '10005',
        '10012',
        '10034',
        '10041',
        '10043',
        '10051',
        '10054',
        '10057',
        '10093',
        '10201',
        '10209',
        '10225',
        '6001',
      ].sort(),
    );
  });
});
