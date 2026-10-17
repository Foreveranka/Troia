/** Public instructions only. Never contains API credentials or a client-controlled paid flag. */
export interface BankTransferInstructions {
  providerId: string;
  transferId: string;
  orderId: string;
  reference: string;
  iban: string;
  beneficiary: string;
  amountTry: string;
  currency: 'TRY';
  expiresAtUnix: number;
  sandboxToken?: string;
}

export function isBankTransferInstructions(raw: unknown): raw is BankTransferInstructions {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return (
    o.providerId !== 'troia-ui-demo' &&
    ['providerId', 'transferId', 'orderId', 'reference', 'beneficiary'].every(
      (key) => typeof o[key] === 'string' && o[key].length > 0 && o[key].length <= 256,
    ) &&
    typeof o.iban === 'string' &&
    /^TR\d{24}$/.test(o.iban) &&
    o.currency === 'TRY' &&
    typeof o.amountTry === 'string' &&
    /^(0|[1-9]\d*)\.\d{2}$/.test(o.amountTry) &&
    Number.isSafeInteger(o.expiresAtUnix) &&
    (o.expiresAtUnix as number) > 0
  );
}

export const BANK_TRANSFER_CSS = `
 .troia-bank { background:#F4EFE4;color:#0C1B30;border:1px solid #D8CEBD;border-top:2px solid #B08A50;
   font:13px/1.5 -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;padding:20px;box-sizing:border-box; }
 .troia-bank h2 { font:500 24px/1.2 Georgia,serif;margin:0 0 8px; }
 .troia-bank p { margin:8px 0;color:#536277;font-size:12px; }
 .troia-bank dl { margin:16px 0; }
 .troia-bank .bank-row { border-top:1px solid #D8CEBD;padding:10px 0;display:grid;grid-template-columns:100px 1fr auto;gap:8px;align-items:center; }
 .troia-bank dt { color:#536277;font-size:11px; }
 .troia-bank dd { margin:0;overflow-wrap:anywhere; }
 .troia-bank button { border:1px solid #B08A50;background:transparent;color:#0C1B30;padding:6px 9px;font-size:11px;cursor:pointer; }
 .troia-bank button:focus-visible { outline:2px solid #B08A50;outline-offset:2px; }
 .troia-bank .bank-warning { color:#826033; }
 @media(max-width:500px) { .troia-bank { padding:14px; } .troia-bank .bank-row { grid-template-columns:1fr auto; } .troia-bank dt { grid-column:1/-1; } }
`;

export function bankErrorCopy(error: string): string | null {
  switch (error) {
    case 'BankTransferUnavailable':
      return 'Banka transferi henüz kullanıma açılmadı. Sağlayıcı bağlantısı bekleniyor; şu an havale yapmayın.';
    case 'BankTransferPreparing':
      return 'Havale bilgileri henüz doğrulanamadı. Aynı siparişten devam edin; yeni bir ödeme başlatmayın.';
    case 'BankTransferReview':
      return 'Bu banka transferi incelemede. Aynı sipariş için tekrar havale yapmayın.';
    case 'OrderConflict':
      return 'Bu sipariş için başka bir ödeme yöntemi başlatılmış. Mevcut işlemi kontrol edin.';
    case 'OrderClosed':
      return 'Bu sipariş artık ödeme kabul etmiyor. Yeni bir sipariş başlatın.';
    default:
      return null;
  }
}

export function renderBankTransfer(
  details: BankTransferInstructions,
  options: { demo?: boolean; amountPending?: boolean } = {},
): HTMLElement {
  const box = document.createElement('section');
  box.className = 'troia-bank';
  const style = document.createElement('style');
  style.textContent = BANK_TRANSFER_CSS;
  box.append(style);
  const heading = document.createElement('h2');
  heading.textContent = 'Banka transferiyle ödeyin';
  const intro = document.createElement('p');
  intro.textContent =
    'Bankanızdan aşağıdaki hesaba tam tutarı ve sipariş açıklamasını kullanarak TL gönderin.';
  box.append(heading, intro);
  if (options.demo) {
    box.dataset.demo = 'true';
    heading.textContent = 'Test havale bilgileri';
    intro.textContent =
      'TEST GÖSTERİMİ · Para göndermeyin. Alıcı ve IBAN örnektir; gerçek banka işlemi yapılmaz.';
    intro.className = 'bank-warning';
    intro.style.fontWeight = '600';
  }
  const sandbox = details.providerId === 'tr-mock-anchor';
  if (sandbox) {
    heading.textContent = 'Test banka transferi';
    intro.textContent =
      'STELLAR TESTNET · Gerçek para göndermeyin. Banka hareketi simüle edilir; USDC teslimatı testnet üzerinde gerçekleşir.';
    intro.className = 'bank-warning';
  }
  const list = document.createElement('dl');
  const expired = details.expiresAtUnix * 1000 <= Date.now();
  for (const [label, value, copy] of [
    ['Alıcı', details.beneficiary, false],
    ['IBAN', details.iban, true],
    [
      options.demo ? 'Örnek tutar' : 'Gönderilecek tutar',
      options.amountPending
        ? 'Tutarı girin'
        : `${details.amountTry} ${options.demo ? 'test TL' : 'TL'}`,
      false,
    ],
    ['Açıklama', details.reference, true],
    ['Sipariş', details.orderId, false],
    ['Son ödeme zamanı', new Date(details.expiresAtUnix * 1000).toLocaleString('tr-TR'), false],
  ] as const) {
    const row = document.createElement('div');
    row.className = 'bank-row';
    const key = document.createElement('dt');
    key.textContent = label;
    const val = document.createElement('dd');
    val.textContent = value;
    row.append(key, val);
    if (copy) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Kopyala';
      button.setAttribute('aria-label', `${label} kopyala`);
      button.disabled = expired;
      button.addEventListener('click', () => {
        if (details.expiresAtUnix * 1000 <= Date.now()) {
          button.disabled = true;
          button.textContent = 'Süresi doldu';
          return;
        }
        if (navigator.clipboard === undefined) {
          button.textContent = 'Metni seçip kopyalayın';
          return;
        }
        void navigator.clipboard.writeText(value).then(
          () => {
            button.textContent = 'Kopyalandı';
          },
          () => {
            button.textContent = 'Metni seçip kopyalayın';
          },
        );
      });
      row.append(button);
    }
    list.append(row);
  }
  const note = document.createElement('p');
  note.className = 'bank-warning';
  note.textContent = expired
    ? 'Bu talimatın süresi doldu. Bu hesaba bu sipariş için havale yapmayın.'
    : 'Eksik, fazla, açıklaması hatalı veya süresi geçen transferler otomatik tamamlanmaz. Havale masrafını tutardan düşmeyin.';
  const status = document.createElement('p');
  status.textContent =
    'Sipariş, banka tahsilatı ve satıcıya USDC teslimatı doğrulandıktan sonra tamamlanır. Aynı ödemeyi tekrar göndermeyin.';
  if (options.demo) {
    note.textContent =
      'Açıklama kodu bu test ödemesine özeldir. Başka bir ödeme için yeni kod oluşturulur.';
    status.textContent =
      'Örnek hesaplama: 1 test USDC = 45 test TL. Bu ekran tahsilat veya USDC teslimatı yapmaz.';
  }
  box.append(list, note, status);
  if (sandbox && /^[a-f0-9]{64}$/.test(details.sandboxToken ?? '')) {
    const simulate = document.createElement('button');
    simulate.type = 'button';
    simulate.disabled = expired;
    simulate.textContent = 'Test havalesini simüle et';
    simulate.addEventListener('click', () => {
      simulate.disabled = true;
      simulate.textContent = 'Test havalesi gönderiliyor…';
      void chrome.runtime
        .sendMessage({
          type: 'TROIA_SIMULATE_BANK',
          orderId: details.orderId,
          sandboxToken: details.sandboxToken,
        })
        .then((outcome: { ok?: boolean }) => {
          simulate.disabled = outcome?.ok === true;
          simulate.textContent = outcome?.ok
            ? 'Havale simüle edildi · USDC doğrulanıyor'
            : 'Bağlantı kurulamadı · tekrar dene';
        })
        .catch(() => {
          simulate.disabled = false;
          simulate.textContent = 'Bağlantı kurulamadı · tekrar dene';
        });
    });
    box.append(simulate);
    note.textContent =
      'Bu IBAN ve açıklama anchor’ın sandbox talimatıdır. Gerçek bankanızdan para göndermeyin.';
    status.textContent =
      'Buton banka girişini simüle eder. Sipariş yalnızca anchor USDC transferi ve satıcı ödemesi doğrulandıktan sonra tamamlanır.';
  }
  return box;
}
