// The manual-payment wizard page (B-11). Runs in the extension's OWN tab — no storefront, no content script,
// no extra host permissions. All decisions live in lib/wizard-core (unit-tested); this file renders steps and
// relays messages to the background worker, which alone talks to the backend (same protocol as the SEP-7
// flow: TROIA_QUOTE / TROIA_INTENT / TROIA_STATUS / TROIA_RECEIPT — one money path, one set of guards).

import { formatApproxTry, toStroops } from '../lib/amount';
import { BANK_TRANSFER_DEMO } from '../lib/config';
import { newDemoBankTransfer, demoTryAmount } from '../lib/bank-transfer-demo';
import { statusCopy } from '../lib/intent';
import type { PublicStatus } from '../lib/intent';
import {
  bankErrorCopy,
  renderBankTransfer,
  isBankTransferInstructions,
} from '../lib/bank-transfer';
import type {
  ExtensionMessage,
  IntentOutcome,
  QuoteOutcome,
  ReceiptOutcome,
  StatusOutcome,
} from '../lib/messages';
import {
  buildManualIntentBody,
  MANUAL_MAX_USDC,
  newManualOrderId,
  validateWizardInput,
  wizardErrorCopy,
} from '../lib/wizard-core';

const POLL_INTERVAL_MS = 3000;
const PENDING_MAX_POLLS = 400; // ~20 min at 3s — same budget as the storefront flow
const CONFIRM_MAX_POLLS = 80;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`wizard: missing #${id}`);
  return node as T;
}

function send<T>(message: ExtensionMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response as T);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

interface Draft {
  paymentMethod: 'card' | 'bank_transfer';
  destination: string;
  amountStroops: bigint;
  amountText: string;
}
let draft: Draft | null = null;
let attemptOrderId: string | null = null;
let activeBankOrderId: string | null = null;
const BANK_RESUME_KEY = 'troia-bank-checkout-v1';
const bankSelected = (): boolean =>
  document.querySelector<HTMLInputElement>('input[name="payment-method"]:checked')?.value ===
  'bank_transfer';
let demoBank = BANK_TRANSFER_DEMO ? newDemoBankTransfer() : null;
function refreshDemoBankPreview(): void {
  const node = el<HTMLElement>('bank-preview');
  node.hidden = !bankSelected() || demoBank === null;
  if (node.hidden || demoBank === null) return;
  el<HTMLElement>('bank-hint').hidden = true;
  const amount = toStroops(el<HTMLInputElement>('amount').value);
  demoBank = { ...demoBank, amountTry: demoTryAmount(amount ?? 0n) };
  node.replaceChildren(
    renderBankTransfer(demoBank, { demo: true, amountPending: amount === null }),
  );
}
if (location.hash === '#bank-transfer') {
  document.querySelector<HTMLInputElement>('input[value="bank_transfer"]')!.checked = true;
  el<HTMLElement>('bank-hint').hidden = false;
  el<HTMLElement>('wizard-title').textContent = 'IBAN ile ödeme';
}
document.querySelectorAll<HTMLInputElement>('input[name="payment-method"]').forEach((input) => {
  input.addEventListener('change', () => {
    el<HTMLElement>('bank-hint').hidden = !bankSelected();
    el<HTMLElement>('wizard-title').textContent = bankSelected()
      ? 'IBAN ile ödeme'
      : 'Manuel ödeme';
    refreshDemoBankPreview();
  });
});
el<HTMLInputElement>('amount').addEventListener('input', refreshDemoBankPreview);
refreshDemoBankPreview();
const originalConfirmNotice = el<HTMLElement>('confirm-notice').textContent;

const stepDetails = el<HTMLElement>('step-details');
const stepConfirm = el<HTMLElement>('step-confirm');
const stepStatus = el<HTMLElement>('step-status');

function show(step: HTMLElement): void {
  for (const s of [stepDetails, stepConfirm, stepStatus]) s.hidden = s !== step;
}

function setError(id: string, text: string | null): void {
  const node = el<HTMLParagraphElement>(id);
  node.hidden = text === null;
  node.textContent = text ?? '';
}

el<HTMLSpanElement>('cap-hint').textContent = `Ödeme başına en fazla ${MANUAL_MAX_USDC} USDC.`;

// STEP 1 -> 2: validate offline, then fetch the indicative ≈₺ (a failure degrades — the price the customer
// actually pays is fixed server-side at /intent regardless).
el<HTMLButtonElement>('continue').addEventListener('click', () => {
  void (async () => {
    setError('details-error', null);
    const destination = el<HTMLInputElement>('destination').value;
    const amountText = el<HTMLInputElement>('amount').value;
    const checked = validateWizardInput(destination, amountText);
    if (!checked.ok) {
      setError('details-error', wizardErrorCopy(checked.reason));
      return;
    }
    draft = {
      paymentMethod: bankSelected() ? 'bank_transfer' : 'card',
      destination: checked.destination,
      amountStroops: checked.amountStroops,
      amountText: amountText.trim(),
    };
    el<HTMLElement>('c-dest').textContent = checked.destination;
    el<HTMLElement>('c-amount').textContent = `${draft.amountText} USDC`;
    el<HTMLElement>('c-method').textContent =
      draft.paymentMethod === 'bank_transfer' ? 'Banka transferi · IBAN' : 'Troy kartı';
    el<HTMLButtonElement>('pay').textContent =
      draft.paymentMethod === 'bank_transfer' ? 'Havale bilgilerini al' : 'Troy kartınla öde';
    el<HTMLElement>('c-try').textContent = '…';
    show(stepConfirm);
    if (draft.paymentMethod === 'bank_transfer' && BANK_TRANSFER_DEMO) {
      el<HTMLElement>('c-try').textContent = `${demoTryAmount(checked.amountStroops)} test TL`;
      el<HTMLElement>('confirm-notice').textContent =
        'Test gösterimi. Gösterilen kur örnektir; gerçek banka işlemi veya USDC transferi yapılmaz.';
      el<HTMLButtonElement>('pay').textContent = 'Test bilgilerini göster';
      return;
    }
    el<HTMLElement>('confirm-notice').textContent = originalConfirmNotice;
    try {
      const quote = await send<QuoteOutcome>({
        type: 'TROIA_QUOTE',
        amountStroops: checked.amountStroops.toString(),
        paymentMethod: draft.paymentMethod,
      });
      el<HTMLElement>('c-try').textContent = quote.ok
        ? formatApproxTry(quote.paidPriceTry)
        : (bankErrorCopy(quote.error) ?? 'Ödeme başlatılırken hesaplanır');
    } catch {
      el<HTMLElement>('c-try').textContent = 'Ödeme başlatılırken hesaplanır';
    }
  })();
});

el<HTMLButtonElement>('back').addEventListener('click', () => {
  setError('confirm-error', null);
  show(stepDetails);
});

// STEP 2 -> 3: one intent, one new order id per attempt. The backend re-validates everything fail-closed
// (strkey, trustline, SEP-29 memo-required, pool solvency) BEFORE any charge — a refusal here cost nothing.
el<HTMLButtonElement>('pay').addEventListener('click', () => {
  void (async () => {
    if (draft === null) return;
    if (draft.paymentMethod === 'bank_transfer' && BANK_TRANSFER_DEMO && demoBank !== null) {
      demoBank = { ...demoBank, amountTry: demoTryAmount(draft.amountStroops) };
      el<HTMLElement>('bank-instructions').replaceChildren(
        renderBankTransfer(demoBank, { demo: true }),
      );
      el<HTMLElement>('status-text').textContent =
        'Test talimatları hazır. Gerçek ödeme beklenmiyor.';
      el<HTMLSpanElement>('spinner').className = 'spinner done';
      el<HTMLButtonElement>('again').hidden = false;
      el<HTMLButtonElement>('again').textContent = 'Yeni test oluştur';
      show(stepStatus);
      return;
    }
    const payButton = el<HTMLButtonElement>('pay');
    payButton.disabled = true; // double-submit guard: one click, one order
    el<HTMLButtonElement>('back').disabled = draft.paymentMethod === 'bank_transfer';
    setError('confirm-error', null);
    try {
      const orderId =
        attemptOrderId ??
        newManualOrderId(Date.now(), () => {
          const b = new Uint8Array(1);
          crypto.getRandomValues(b);
          return b[0] as number;
        });
      if (draft.paymentMethod === 'bank_transfer') attemptOrderId = orderId;
      const body = await buildManualIntentBody(orderId, draft.destination, draft.amountStroops);
      const outcome = await send<IntentOutcome>({
        type: 'TROIA_INTENT',
        body: { ...body, paymentMethod: draft.paymentMethod },
      });
      if (!outcome.ok) {
        setError('confirm-error', bankErrorCopy(outcome.error) ?? wizardErrorCopy(outcome.error));
        if (
          [
            'BankTransferUnavailable',
            'PoolInsufficient',
            'SnapshotUnavailable',
            'PriceUnavailable',
            'BadAmount',
            'BadRequest',
            'BadPaymentMethod',
            'SessionRequired',
            'SessionBudgetExceeded',
            'RateLimited',
          ].includes(outcome.error)
        ) {
          attemptOrderId = null;
          el<HTMLButtonElement>('back').disabled = false;
        }
        payButton.disabled = false;
        return;
      }
      if (
        outcome.response.bankTransfer !== undefined &&
        outcome.response.paymentMethod === 'bank_transfer'
      ) {
        activeBankOrderId = outcome.response.orderId;
        try {
          window.localStorage.setItem(
            BANK_RESUME_KEY,
            JSON.stringify(outcome.response.bankTransfer),
          );
        } catch {
          /* UI storage may be disabled. */
        }
        el<HTMLElement>('bank-instructions').replaceChildren(
          renderBankTransfer(outcome.response.bankTransfer),
        );
        el<HTMLElement>('status-text').textContent = 'Banka tahsilatı bekleniyor…';
      } else if (typeof outcome.response.paymentPageUrl !== 'string') {
        setError('confirm-error', wizardErrorCopy('CheckoutUnavailable'));
        payButton.disabled = false;
        return;
      }
      show(stepStatus);
      pollStatus(orderId, draft.paymentMethod);
    } catch {
      setError('confirm-error', wizardErrorCopy('internal'));
      payButton.disabled = false;
    }
  })();
});

el<HTMLButtonElement>('again').addEventListener('click', () => {
  if (activeBankOrderId !== null) {
    el<HTMLButtonElement>('again').hidden = true;
    el<HTMLSpanElement>('spinner').className = 'spinner';
    setError('status-error', null);
    pollStatus(activeBankOrderId, 'bank_transfer');
    return;
  }
  draft = null;
  if (BANK_TRANSFER_DEMO) {
    demoBank = newDemoBankTransfer();
  }
  attemptOrderId = null;
  el<HTMLElement>('bank-instructions').replaceChildren();
  el<HTMLButtonElement>('back').disabled = false;
  el<HTMLInputElement>('destination').value = '';
  el<HTMLInputElement>('amount').value = '';
  refreshDemoBankPreview();
  el<HTMLButtonElement>('pay').disabled = false;
  el<HTMLElement>('receipt').hidden = true;
  el<HTMLButtonElement>('again').hidden = true;
  setError('status-error', null);
  el<HTMLSpanElement>('spinner').className = 'spinner';
  show(stepDetails);
});

/** Poll the coarse status until terminal, with the same phase-aware budget the storefront flow uses. On
 *  completion, fetch the receipt so the user leaves with the on-chain proof in hand. */
function pollStatus(orderId: string, paymentMethod: 'card' | 'bank_transfer' = 'card'): void {
  let polls = 0;
  let sawProcessing = false;
  const statusText = el<HTMLParagraphElement>('status-text');
  const spinner = el<HTMLSpanElement>('spinner');
  statusText.textContent = 'iyzico sekmesinde kart ödemeniz bekleniyor…';

  const timer = setInterval(() => {
    void (async () => {
      polls += 1;
      const cap = sawProcessing ? CONFIRM_MAX_POLLS : PENDING_MAX_POLLS;
      if (polls > cap) {
        clearInterval(timer);
        spinner.className = 'spinner bad';
        setError(
          'status-error',
          'Sonuç izleme durduruldu. Ödeme yaptıysanız sipariş işlenmeye devam ediyor. Yeniden ödeme göndermeyin. Destek için bu sipariş numarasını saklayın: ' +
            orderId,
        );
        el<HTMLButtonElement>('again').hidden = false;
        if (paymentMethod === 'bank_transfer')
          el<HTMLButtonElement>('again').textContent = 'Durumu tekrar kontrol et';
        return;
      }
      let status: PublicStatus;
      try {
        const outcome = await send<StatusOutcome>({ type: 'TROIA_STATUS', orderId });
        if (!outcome.ok) return; // transient — keep polling through it
        status = outcome.status;
      } catch {
        return;
      }
      if (status === 'processing') sawProcessing = true;
      const copy = statusCopy(status);
      statusText.textContent =
        paymentMethod === 'bank_transfer' && status === 'pending'
          ? 'Banka tahsilatı bekleniyor…'
          : copy.text;
      if (status === 'review' && paymentMethod === 'bank_transfer')
        statusText.textContent = `Transfer incelemede. Yeniden ödeme göndermeyin. Sipariş: ${orderId}`;
      if (!copy.terminal) return;

      clearInterval(timer);
      spinner.className = copy.kind === 'error' ? 'spinner bad' : 'spinner done';
      el<HTMLButtonElement>('again').hidden = false;
      if (paymentMethod === 'bank_transfer') {
        if (status === 'completed' || status === 'failed') {
          activeBankOrderId = null;
          try {
            const cached: unknown = JSON.parse(
              window.localStorage.getItem(BANK_RESUME_KEY) ?? 'null',
            );
            if (isBankTransferInstructions(cached) && cached.orderId === orderId)
              window.localStorage.removeItem(BANK_RESUME_KEY);
          } catch {
            /* optional UI persistence */
          }
          el<HTMLElement>('bank-instructions').replaceChildren();
          el<HTMLButtonElement>('again').textContent = 'Yeni bir ödeme yap';
        } else {
          el<HTMLButtonElement>('again').textContent = 'Durumu tekrar kontrol et';
        }
      }
      if (status !== 'completed') return;
      try {
        const receipt = await send<ReceiptOutcome>({ type: 'TROIA_RECEIPT', orderId });
        if (receipt.ok) {
          el<HTMLElement>('r-order').textContent = orderId;
          el<HTMLElement>('r-try').textContent =
            receipt.paidPriceTry !== null ? formatApproxTry(receipt.paidPriceTry) : '—';
          // Zincir kanıtı tek dokunuşla açılsın: hash'i explorer bağlantısı olarak bas. textContent ile
          // yazılan bir metin kopyala-yapıştır ister; burada makbuzun kendisi doğrulanabilir olmalı.
          const txEl = el<HTMLElement>('r-tx');
          txEl.textContent = '';
          if (receipt.txHash !== null && receipt.txHash !== undefined) {
            const a = document.createElement('a');
            a.href = `https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'txlink';
            a.textContent = receipt.txHash;
            txEl.appendChild(a);
          } else {
            txEl.textContent = '—';
          }
          el<HTMLElement>('receipt').hidden = false;
        }
      } catch {
        // the payment is complete either way; the receipt is a bonus, not a gate
      }
    })();
  }, POLL_INTERVAL_MS);
}

// Resume an IBAN checkout after a panel reload without creating another transfer.
try {
  const raw: unknown = JSON.parse(window.localStorage.getItem(BANK_RESUME_KEY) ?? 'null');
  if (isBankTransferInstructions(raw)) {
    activeBankOrderId = raw.orderId;
    attemptOrderId = raw.orderId;
    el<HTMLElement>('bank-instructions').replaceChildren(renderBankTransfer(raw));
    el<HTMLElement>('status-text').textContent =
      'Mevcut banka transferinin durumu kontrol ediliyor…';
    show(stepStatus);
    pollStatus(raw.orderId, 'bank_transfer');
  }
} catch {
  /* A malformed UI cache never creates a payment. */
}
