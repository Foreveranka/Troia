import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeBanner, showBanner } from '../src/lib/banner';

const HOST_ID = 'troia-pay-banner-host';
const host = (): HTMLElement | null => document.getElementById(HOST_ID);

afterEach(() => {
  removeBanner();
  document.body.innerHTML = '';
});

describe('banner', () => {
  it('injects a single host with an open shadow root showing the amount', () => {
    showBanner({ amount: '62.00', assetCode: 'USDC', onPay: () => {} });
    const h = host();
    expect(h).not.toBeNull();
    expect(h!.shadowRoot).not.toBeNull();
    expect(h!.shadowRoot!.textContent).toContain('62.00');
    expect(h!.shadowRoot!.textContent).toContain('USDC');
  });

  it('is idempotent — showing twice leaves exactly one host with the latest content', () => {
    showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    showBanner({ amount: '2', assetCode: 'USDC', onPay: () => {} });
    expect(document.querySelectorAll(`#${HOST_ID}`).length).toBe(1);
    expect(host()!.shadowRoot!.textContent).toContain('2');
  });

  it('fires onPay exactly once when the pay button is clicked', () => {
    const onPay = vi.fn();
    showBanner({ amount: '1', assetCode: 'USDC', onPay });
    host()!.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!.click();
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('removes the banner on dismiss', () => {
    showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    host()!.shadowRoot!.querySelector<HTMLButtonElement>('.x')!.click();
    expect(host()).toBeNull();
  });

  it('removeBanner is a safe no-op when nothing is shown', () => {
    expect(() => removeBanner()).not.toThrow();
    expect(host()).toBeNull();
  });

  it('HTML-escapes untrusted values so a crafted amount cannot inject an element', () => {
    showBanner({ amount: '<img src=x onerror=alert(1)>', assetCode: 'USDC', onPay: () => {} });
    const sr = host()!.shadowRoot!;
    expect(sr.querySelector('img')).toBeNull();
    expect(sr.innerHTML).toContain('&lt;img');
  });

  it('handle.setBusy disables the pay button and relabels it', () => {
    const h = showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const btn = host()!.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!;
    h.setBusy(true);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Processing');
    h.setBusy(false);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Pay with Troy card');
  });

  it('handle.setStatus reveals the status line with the given kind', () => {
    const h = showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const status = host()!.shadowRoot!.querySelector<HTMLElement>('.status')!;
    expect(status.hidden).toBe(true);
    h.setStatus('you were not charged.', 'error');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('not charged');
    expect(status.dataset.kind).toBe('error');
  });

  it('handle.remove removes the banner', () => {
    const h = showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    h.remove();
    expect(host()).toBeNull();
  });

  it('handle.setApproxTry reveals the ≈₺ line and hides it again on null (data, never markup)', () => {
    const h = showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const approx = host()!.shadowRoot!.querySelector<HTMLElement>('.approx')!;
    expect(approx.hidden).toBe(true);
    h.setApproxTry('≈ 2,650.00 TL');
    expect(approx.hidden).toBe(false);
    expect(approx.textContent).toBe('≈ 2,650.00 TL');
    // a crafted TL string is treated as text, never HTML (parallel to the amount-escape test above)
    h.setApproxTry('<img src=x onerror=alert(1)>');
    expect(host()!.shadowRoot!.querySelector('.approx img')).toBeNull();
    h.setApproxTry(null);
    expect(approx.hidden).toBe(true);
    expect(approx.textContent).toBe('');
  });

  it('shows the Troia identity and a pre-jump iyzico note (not an anonymous money bar)', () => {
    showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const text = host()!.shadowRoot!.textContent!.toLowerCase();
    expect(text).toContain('troia');
    expect(text).toContain('iyzico');
    expect(text).toContain('secure');
  });

  it('the status line is an aria-live region that flips assertive for errors', () => {
    const h = showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const status = host()!.shadowRoot!.querySelector<HTMLElement>('.status')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    h.setStatus('Payment could not be completed.', 'error');
    expect(status.getAttribute('aria-live')).toBe('assertive');
    h.setStatus('Payment received — confirming…', 'info');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('gives the action buttons a keyboard focus ring (happy-dom cannot match :focus-visible, so assert the CSS)', () => {
    showBanner({ amount: '1', assetCode: 'USDC', onPay: () => {} });
    const css = host()!.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain('.pay:focus-visible');
    expect(css).toContain('.x:focus-visible');
    expect(css).toContain('outline');
  });
});
