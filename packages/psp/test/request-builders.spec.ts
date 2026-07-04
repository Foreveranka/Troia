import { describe, expect, it } from 'vitest';
import {
  buildCancelRequest,
  buildInitializeCheckoutFormRequest,
  buildPostAuthRequest,
  buildPreAuthRequest,
  buildRefundRequest,
  buildRetrieveCheckoutFormRequest,
  formatPrice,
} from '../src/request-builders.js';
import { PspBuildError } from '../src/errors.js';
import type { Address, BasketItem, Buyer, PaymentCard } from '../src/types.js';

const BUYER: Buyer = {
  id: 'b1', name: 'Ada', surname: 'Lovelace', identityNumber: '11111111111',
  email: 'a@b.co', registrationAddress: 'Addr 1', city: 'Istanbul', country: 'Turkey', ip: '1.2.3.4',
};
const ADDR: Address = { contactName: 'Ada Lovelace', city: 'Istanbul', country: 'Turkey', address: 'Addr 1' };
const ITEMS: BasketItem[] = [
  { id: 'i1', name: 'Item', category1: 'General', itemType: 'VIRTUAL', price: 10 },
];
const CARD: PaymentCard = {
  cardHolderName: 'Ada Lovelace', cardNumber: '5528790000000008', expireMonth: '12', expireYear: '2030', cvc: '123',
};

describe('formatPrice — matches the SDK on valid numbers, fails closed on invalid', () => {
  it('normalizes integers to .0 and preserves decimals', () => {
    expect(formatPrice(10)).toBe('10.0');
    expect(formatPrice(100)).toBe('100.0');
    expect(formatPrice(10.5)).toBe('10.5');
    expect(formatPrice('10.99')).toBe('10.99');
    expect(formatPrice('5.00')).toBe('5.0');
    expect(formatPrice(0.1)).toBe('0.1');
  });
  it('fails closed on a non-numeric OR empty/whitespace price (never emits a garbage amount)', () => {
    expect(() => formatPrice('abc')).toThrow(PspBuildError);
    expect(() => formatPrice(Number.NaN)).toThrow(PspBuildError);
    expect(() => formatPrice('')).toThrow(PspBuildError); // Number('')===0 but parseFloat('')===NaN
    expect(() => formatPrice('   ')).toThrow(PspBuildError);
    expect(() => formatPrice(Number.POSITIVE_INFINITY)).toThrow(PspBuildError);
  });

  it('fails closed on partial-numeric / non-decimal strings (no parseFloat prefix-salvage / truncation)', () => {
    // parseFloat would silently salvage these to a WRONG amount; the canonical guard rejects them.
    for (const bad of ['10abc', '12.34.56', '1,5', '10 50', '0x10', '5 TRY', '-5', '.5', '1e3', '1_000']) {
      expect(() => formatPrice(bad), `formatPrice(${JSON.stringify(bad)}) must throw`).toThrow(PspBuildError);
    }
  });
});

describe('builders reject an empty conversationId (the dedupe key)', () => {
  it('throws PspBuildError on an empty/blank conversationId', () => {
    expect(() => buildPostAuthRequest({ conversationId: '', paymentId: 'p1', paidPrice: 10, currency: 'TRY', ip: '1.2.3.4' })).toThrow(PspBuildError);
    expect(() => buildCancelRequest({ conversationId: '  ', paymentId: 'p1', ip: '1.2.3.4' })).toThrow(PspBuildError);
  });
});

describe('request builders — golden shape + sign-the-sent-string', () => {
  it('buildPostAuthRequest: exact body, path, formatPrice, and json === JSON.stringify(body)', () => {
    const req = buildPostAuthRequest({ conversationId: 'c1', paymentId: 'p1', paidPrice: 10, currency: 'TRY', ip: '1.2.3.4' });
    expect(req.path).toBe('/payment/postauth');
    expect(req.body).toEqual({ locale: 'tr', conversationId: 'c1', paymentId: 'p1', paidPrice: '10.0', currency: 'TRY', ip: '1.2.3.4' });
    expect(req.json).toBe(JSON.stringify(req.body));
  });

  it('cancel keys off paymentId; refund keys off paymentTransactionId — never swapped', () => {
    const cancel = buildCancelRequest({ conversationId: 'c1', paymentId: 'pay-1', ip: '1.2.3.4' });
    expect(cancel.path).toBe('/payment/cancel');
    expect(cancel.body).toHaveProperty('paymentId', 'pay-1');
    expect(cancel.body).not.toHaveProperty('paymentTransactionId');

    const refund = buildRefundRequest({ conversationId: 'c1', paymentTransactionId: 'txn-9', price: 5, currency: 'TRY', ip: '1.2.3.4' });
    expect(refund.path).toBe('/payment/refund');
    expect(refund.body).toHaveProperty('paymentTransactionId', 'txn-9');
    expect(refund.body).not.toHaveProperty('paymentId');
    expect(refund.body).toHaveProperty('price', '5.0');
  });

  it('checkout initialize uses the DIRECT-SALE (immediate-capture) path, not the preauth (block) path', () => {
    const init = buildInitializeCheckoutFormRequest({
      conversationId: 'c1', price: 10, paidPrice: 10, currency: 'TRY', basketId: 'B1', paymentGroup: 'PRODUCT',
      callbackUrl: 'https://x/cb', buyer: BUYER, shippingAddress: ADDR, billingAddress: ADDR, basketItems: ITEMS,
    });
    expect(init.path).toBe('/payment/iyzipos/checkoutform/initialize/ecom');
    expect(init.body).toHaveProperty('price', '10.0');
    // basket item prices are normalized too
    expect((init.body.basketItems as { price: string }[])[0]!.price).toBe('10.0');
    expect(init.json).toBe(JSON.stringify(init.body));
  });

  it('retrieve uses the detail path; preauth uses /payment/preauth; all emit json === JSON.stringify(body)', () => {
    const retrieve = buildRetrieveCheckoutFormRequest({ conversationId: 'c1', token: 'tok' });
    expect(retrieve.path).toBe('/payment/iyzipos/checkoutform/auth/ecom/detail');
    expect(retrieve.json).toBe(JSON.stringify(retrieve.body));

    const preauth = buildPreAuthRequest({
      conversationId: 'c1', price: 10, paidPrice: 10, currency: 'TRY', installment: 1, basketId: 'B1',
      paymentGroup: 'PRODUCT', paymentCard: CARD, buyer: BUYER, shippingAddress: ADDR, billingAddress: ADDR, basketItems: ITEMS,
    });
    expect(preauth.path).toBe('/payment/preauth');
    expect(preauth.body).toHaveProperty('paymentCard');
    expect(preauth.json).toBe(JSON.stringify(preauth.body));
  });
});
