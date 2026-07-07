import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// End-to-end wiring of the content script's initial pass: seed the page DOM, import the module (which runs its
// synchronous initial scan on load), and assert the banner is/ isn't injected. This exercises the whole Phase 1
// pipeline together — adapter locator + confidence gate + banner — without touching money or the backend.

const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const ISSUER = 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W';
const HOST_ID = 'troia-pay-banner-host';
const PAYABLE = `web+stellar:pay?destination=${MERCHANT}&amount=62.00&memo=ST-AB12CD&memo_type=text&asset_code=USDC&asset_issuer=${ISSUER}`;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  document.getElementById(HOST_ID)?.remove();
});

afterEach(() => {
  document.getElementById(HOST_ID)?.remove();
});

describe('content script pipeline (initial scan)', () => {
  it('injects the banner when a payable request is already on the page at load', async () => {
    document.body.innerHTML = `<a href="${PAYABLE}">Open in wallet</a>`;
    await import('../src/content');
    const h = document.getElementById(HOST_ID);
    expect(h).not.toBeNull();
    expect(h!.shadowRoot!.textContent).toContain('62.00');
  });

  it('shows no banner when the on-page request is not payable (native XLM)', async () => {
    document.body.innerHTML = `<a href="web+stellar:pay?destination=${MERCHANT}&amount=1&memo=X&memo_type=text">Open in wallet</a>`;
    await import('../src/content');
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('shows no banner on a page with no SEP-7 at all', async () => {
    document.body.innerHTML = `<a href="https://example.com">x</a>`;
    await import('../src/content');
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});
