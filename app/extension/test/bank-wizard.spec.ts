import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from './fakes/chrome';

vi.mock('../src/lib/derive-memo', () => ({ deriveMemoHex: vi.fn(async () => 'a'.repeat(64)) }));
const demoMode = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  get BANK_TRANSFER_DEMO() {
    return demoMode.enabled;
  },
}));
const html = readFileSync('src/wizard/index.html', 'utf8');
const merchant = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const details = {
  providerId: 'test-only',
  transferId: 'test-transfer',
  orderId: 'resume-order',
  reference: 'TEST-REF',
  iban: 'TR330006100519786457841326',
  beneficiary: 'Test Provider',
  amountTry: '100.00',
  currency: 'TRY' as const,
  expiresAtUnix: 4_000_000_000,
};
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
let stub: ChromeStub;

beforeEach(() => {
  demoMode.enabled = false;
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = html
    .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  const cache = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, value: string) => cache.set(key, value),
      removeItem: (key: string) => cache.delete(key),
    },
  });
  window.history.replaceState({}, '', '/#bank-transfer');
  stub = installChromeStub();
});
afterEach(() => {
  stub?.uninstall();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function confirm() {
  await import('../src/wizard/wizard');
  get<HTMLInputElement>('destination').value = merchant;
  get<HTMLInputElement>('amount').value = '2';
  get<HTMLButtonElement>('continue').click();
  await flush();
}

describe('bank payment side panel', () => {
  it('shows test account details immediately, keeps one code per test and never calls payment APIs', async () => {
    demoMode.enabled = true;
    await import('../src/wizard/wizard');
    const preview = get<HTMLElement>('bank-preview');
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('Troia Test Hesabı');
    expect(preview.textContent).toContain('TR000000000000000000000000');
    expect(preview.textContent).toContain('Para göndermeyin');
    const firstCode = preview.querySelectorAll('dd')[3].textContent;
    get<HTMLInputElement>('amount').value = '2';
    get<HTMLInputElement>('amount').dispatchEvent(new Event('input'));
    expect(preview.querySelectorAll('dd')[3].textContent).toBe(firstCode);
    expect(preview.textContent).toContain('90.00 test TL');
    get<HTMLInputElement>('destination').value = merchant;
    get<HTMLButtonElement>('continue').click();
    await flush();
    get<HTMLButtonElement>('pay').click();
    await flush();
    expect(get<HTMLElement>('status-text').textContent).toContain('Gerçek ödeme beklenmiyor');
    await vi.advanceTimersByTimeAsync(9000);
    expect(stub.sendMessage).not.toHaveBeenCalled();
    get<HTMLButtonElement>('again').click();
    expect(preview.querySelectorAll('dd')[3].textContent).not.toBe(firstCode);
  });
  it('opens with IBAN selected, shows provider-unavailable without instructions, and lets the customer go back', async () => {
    stub.script.intent = { ok: false, status: 503, error: 'BankTransferUnavailable' };
    await confirm();
    expect(document.querySelector<HTMLInputElement>('input[value="bank_transfer"]')!.checked).toBe(
      true,
    );
    get<HTMLButtonElement>('pay').click();
    await flush();
    expect(get<HTMLElement>('confirm-error').textContent).toContain('havale yapmayın');
    expect(get<HTMLElement>('bank-instructions').children.length).toBe(0);
    expect(get<HTMLButtonElement>('back').disabled).toBe(false);
  });
  it('reuses the same order after an unknown creation outcome', async () => {
    stub.script.intent = { ok: false, status: null, error: 'timeout' };
    await confirm();
    get<HTMLButtonElement>('pay').click();
    await flush();
    get<HTMLButtonElement>('pay').click();
    await flush();
    const calls = stub.sendMessage.mock.calls.filter((call) => call[0].type === 'TROIA_INTENT');
    expect(calls).toHaveLength(2);
    expect(calls[1][0].body.orderId).toBe(calls[0][0].body.orderId);
    expect(calls[0][0].body.paymentMethod).toBe('bank_transfer');
    expect(get<HTMLButtonElement>('back').disabled).toBe(true);
  });
  it('resumes saved instructions without creating a transfer and does not offer a second purchase while under review', async () => {
    window.localStorage.setItem('troia-bank-checkout-v1', JSON.stringify(details));
    stub.script.statuses = ['review'];
    await import('../src/wizard/wizard');
    expect(get<HTMLElement>('step-status').hidden).toBe(false);
    expect(get<HTMLElement>('bank-instructions').textContent).toContain(details.reference);
    await vi.advanceTimersByTimeAsync(3000);
    expect(get<HTMLButtonElement>('again').textContent).toContain('Durumu tekrar');
    get<HTMLButtonElement>('again').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      stub.sendMessage.mock.calls.filter((call) => call[0].type === 'TROIA_INTENT'),
    ).toHaveLength(0);
    expect(window.localStorage.getItem('troia-bank-checkout-v1')).not.toBeNull();
  });
  it('clears payable bank details and the resume cache after confirmed settlement', async () => {
    window.localStorage.setItem('troia-bank-checkout-v1', JSON.stringify(details));
    stub.script.statuses = ['completed'];
    await import('../src/wizard/wizard');
    await vi.advanceTimersByTimeAsync(3000);
    expect(window.localStorage.getItem('troia-bank-checkout-v1')).toBeNull();
    expect(get<HTMLElement>('bank-instructions').children.length).toBe(0);
    expect(get<HTMLButtonElement>('again').textContent).toContain('Yeni bir ödeme');
  });
});
