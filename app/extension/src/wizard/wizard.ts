// The manual-payment wizard page (B-11). Runs in the extension's OWN tab — no storefront, no content script,
// no extra host permissions. All decisions live in lib/wizard-core (unit-tested); this file renders steps and
// relays messages to the background worker, which alone talks to the backend (same protocol as the SEP-7
// flow: TROIA_QUOTE / TROIA_INTENT / TROIA_STATUS / TROIA_RECEIPT — one money path, one set of guards).

import { formatApproxTry } from '../lib/amount';
import { statusCopy } from '../lib/intent';
import type { PublicStatus } from '../lib/intent';
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
  destination: string;
  amountStroops: bigint;
  amountText: string;
}
let draft: Draft | null = null;

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

el<HTMLSpanElement>('cap-hint').textContent = `Up to ${MANUAL_MAX_USDC} USDC per payment.`;

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
      destination: checked.destination,
      amountStroops: checked.amountStroops,
      amountText: amountText.trim(),
    };
    el<HTMLElement>('c-dest').textContent = checked.destination;
    el<HTMLElement>('c-amount').textContent = `${draft.amountText} USDC`;
    el<HTMLElement>('c-try').textContent = '…';
    show(stepConfirm);
    try {
      const quote = await send<QuoteOutcome>({
        type: 'TROIA_QUOTE',
        amountStroops: checked.amountStroops.toString(),
      });
      el<HTMLElement>('c-try').textContent = quote.ok
        ? formatApproxTry(quote.paidPriceTry)
        : 'shown on the card form';
    } catch {
      el<HTMLElement>('c-try').textContent = 'shown on the card form';
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
    const payButton = el<HTMLButtonElement>('pay');
    payButton.disabled = true; // double-submit guard: one click, one order
    setError('confirm-error', null);
    try {
      const orderId = newManualOrderId(Date.now(), () => {
        const b = new Uint8Array(1);
        crypto.getRandomValues(b);
        return b[0] as number;
      });
      const body = await buildManualIntentBody(orderId, draft.destination, draft.amountStroops);
      const outcome = await send<IntentOutcome>({ type: 'TROIA_INTENT', body });
      if (!outcome.ok) {
        setError('confirm-error', wizardErrorCopy(outcome.error));
        payButton.disabled = false;
        return;
      }
      if (typeof outcome.response.paymentPageUrl !== 'string') {
        setError('confirm-error', wizardErrorCopy('CheckoutUnavailable'));
        payButton.disabled = false;
        return;
      }
      show(stepStatus);
      pollStatus(orderId);
    } catch {
      setError('confirm-error', wizardErrorCopy('internal'));
      payButton.disabled = false;
    }
  })();
});

el<HTMLButtonElement>('again').addEventListener('click', () => {
  draft = null;
  el<HTMLInputElement>('destination').value = '';
  el<HTMLInputElement>('amount').value = '';
  el<HTMLButtonElement>('pay').disabled = false;
  el<HTMLElement>('receipt').hidden = true;
  el<HTMLButtonElement>('again').hidden = true;
  setError('status-error', null);
  el<HTMLSpanElement>('spinner').className = 'spinner';
  show(stepDetails);
});

/** Poll the coarse status until terminal, with the same phase-aware budget the storefront flow uses. On
 *  completion, fetch the receipt so the user leaves with the on-chain proof in hand. */
function pollStatus(orderId: string): void {
  let polls = 0;
  let sawProcessing = false;
  const statusText = el<HTMLParagraphElement>('status-text');
  const spinner = el<HTMLSpanElement>('spinner');
  statusText.textContent = 'Waiting for your card payment in the iyzico tab…';

  const timer = setInterval(() => {
    void (async () => {
      polls += 1;
      const cap = sawProcessing ? CONFIRM_MAX_POLLS : PENDING_MAX_POLLS;
      if (polls > cap) {
        clearInterval(timer);
        spinner.className = 'spinner bad';
        setError(
          'status-error',
          'Stopped watching for a result. If you completed the card payment, the order is still being processed — keep this order id for support: ' +
            orderId,
        );
        el<HTMLButtonElement>('again').hidden = false;
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
      statusText.textContent = copy.text;
      if (!copy.terminal) return;

      clearInterval(timer);
      spinner.className = copy.kind === 'error' ? 'spinner bad' : 'spinner done';
      el<HTMLButtonElement>('again').hidden = false;
      if (status !== 'completed') return;
      try {
        const receipt = await send<ReceiptOutcome>({ type: 'TROIA_RECEIPT', orderId });
        if (receipt.ok) {
          el<HTMLElement>('r-order').textContent = orderId;
          el<HTMLElement>('r-try').textContent =
            receipt.paidPriceTry !== null ? formatApproxTry(receipt.paidPriceTry) : '—';
          el<HTMLElement>('r-tx').textContent = receipt.txHash ?? '—';
          el<HTMLElement>('receipt').hidden = false;
        }
      } catch {
        // the payment is complete either way; the receipt is a bonus, not a gate
      }
    })();
  }, POLL_INTERVAL_MS);
}
