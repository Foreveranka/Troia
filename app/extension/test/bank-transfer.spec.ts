import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bankErrorCopy,
  isBankTransferInstructions,
  renderBankTransfer,
} from '../src/lib/bank-transfer';
import { removeBanner, showBanner } from '../src/lib/banner';
import { intentUiAction } from '../src/lib/intent';

const details = {
  providerId: 'test-only',
  transferId: 'transfer-1',
  orderId: 'order-1',
  reference: 'TROIA-123',
  iban: 'TR330006100519786457841326',
  beneficiary: 'Test Provider',
  amountTry: '100.25',
  currency: 'TRY' as const,
  expiresAtUnix: 4_000_000_000,
};

afterEach(() => {
  removeBanner();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('IBAN extension checkout', () => {
  it('switches the banner action to IBAN and locks the method while the order is starting', () => {
    const onPay = vi.fn();
    const onMethodChange = vi.fn();
    const handle = showBanner({ amount: '2', assetCode: 'USDC', onPay, onMethodChange });
    const root = document.getElementById('troia-pay-banner-host')!.shadowRoot!;
    const select = root.querySelector<HTMLSelectElement>('select')!;
    select.value = 'bank_transfer';
    select.dispatchEvent(new Event('change'));
    expect(onMethodChange).toHaveBeenCalledWith('bank_transfer');
    root.querySelector<HTMLButtonElement>('.pay')!.click();
    expect(onPay).toHaveBeenCalledWith('bank_transfer');
    handle.setBusy(true);
    expect(select.disabled).toBe(true);
    handle.showBankTransfer(details);
    expect(root.querySelector('.troia-bank')!.textContent).toContain(details.reference);
    expect(
      intentUiAction({
        orderId: 'order-1',
        token: 'transfer-1',
        paidPriceTry: '100.25',
        paymentMethod: 'bank_transfer',
        bankTransfer: details,
      }).poll,
    ).toBe(true);
  });
  it('displays exact payment details and copies the canonical IBAN/reference', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const box = renderBankTransfer(details);
    expect(box.textContent).toContain('100.25 TL');
    expect(box.textContent).toContain('Test Provider');
    box.querySelector<HTMLButtonElement>('button[aria-label="IBAN kopyala"]')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(details.iban);
    box.querySelector<HTMLButtonElement>('button[aria-label="Açıklama kopyala"]')!.click();
    expect(writeText).toHaveBeenCalledWith(details.reference);
  });
  it('does not interpolate HTML and disables copy on expired instructions', () => {
    const box = renderBankTransfer({
      ...details,
      beneficiary: '<img src=x onerror=alert(1)>',
      expiresAtUnix: 1,
    });
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img');
    expect(box.textContent).toContain('süresi doldu');
    expect([...box.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });
  it('requires real instructions; an unavailable provider never supplies placeholder IBAN details', () => {
    expect(isBankTransferInstructions(details)).toBe(true);
    expect(isBankTransferInstructions({ ...details, iban: 'Coming soon' })).toBe(false);
    expect(isBankTransferInstructions({ ...details, expiresAtUnix: null })).toBe(false);
    expect(bankErrorCopy('BankTransferUnavailable')).toContain('havale yapmayın');
  });
});

it('labels real anchor instructions as testnet and sends only an order-scoped simulation request', async () => {
  const sendMessage = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const box = renderBankTransfer({
    ...details,
    providerId: 'tr-mock-anchor',
    sandboxToken: 'a'.repeat(64),
  });
  expect(box.textContent).toContain('Gerçek para göndermeyin');
  const button = [...box.querySelectorAll('button')].find(
    (b) => b.textContent === 'Test havalesini simüle et',
  )!;
  button.click();
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TROIA_SIMULATE_BANK',
      orderId: details.orderId,
      sandboxToken: 'a'.repeat(64),
    }),
  );
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain('USDC doğrulanıyor');
  vi.unstubAllGlobals();
});
