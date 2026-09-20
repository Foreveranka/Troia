import { useEffect, useRef, useState } from 'react';
import { walletRequest } from './wallet';
import {
  AnchorClient,
  quoteIsLive,
  statusLabel,
  trustedLink,
  type AnchorTransaction,
  type Direction,
  type Instructions,
  type Quote,
} from './client';
import { ANCHOR } from './config';
import troiaLogo from '../popup/assets/logo.png';
import './anchor.css';

const bankStatus = (status: string) =>
  (
    ({
      pending_user_transfer_start: 'Transferiniz bekleniyor',
      pending_anchor: 'Anchor işliyor',
      pending_stellar: 'Stellar onayı bekleniyor',
      pending_external: 'Banka ödemesi bekleniyor',
      pending_trust: 'USDC alım izni gerekli',
      pending_customer_info_update: 'Müşteri bilgisi gerekli',
      pending_transaction_info_update: 'Transfer bilgisi gerekli',
      pending_user: 'İşlem yapmanız gerekiyor',
      on_hold: 'İnceleniyor',
      incomplete: 'Kurulum tamamlanmadı',
      completed: 'Tamamlandı',
      refunded: 'İade edildi',
      expired: 'Süresi doldu',
      error: 'Başarısız',
      no_market: 'Dönüşüm kullanılamıyor',
      too_small: 'Alt limitin altında',
      too_large: 'Üst limitin üzerinde',
    }) as Record<string, string>
  )[status] ?? statusLabel(status);

const short = (s: string) => `${s.slice(0, 7)}…${s.slice(-6)}`;
function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-value"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span>{value}</span>
      <small>{copied ? 'Kopyalandı' : 'Kopyala'}</small>
    </button>
  );
}
export default function AnchorApp() {
  const [client, setClient] = useState<AnchorClient>();
  const liveClient = useRef<AnchorClient | undefined>(undefined);
  const [direction, setDirection] = useState<Direction>('deposit');
  const [amount, setAmount] = useState('100');
  const [quote, setQuote] = useState<Quote>();
  const [instructions, setInstructions] = useState<Instructions>();
  const [active, setActive] = useState<AnchorTransaction>();
  const [history, setHistory] = useState<AnchorTransaction[]>([]);
  const [balance, setBalance] = useState('—');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [submitted, setSubmitted] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function run(label: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Bu adım tamamlanamadı. Transfer durumunu yenileyin.',
      );
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  async function refresh(c: AnchorClient, id?: string) {
    const rows = await c.history();
    if (liveClient.current !== c) return;
    setHistory(rows);
    if (id) {
      const t = await c.transaction(id);
      if (liveClient.current === c) setActive(t);
    }
    try {
      const b = await c.balances();
      if (liveClient.current === c) {
        setBalance(b.usdc);
        setReady(b.trusted);
      }
    } catch {
      if (liveClient.current === c) {
        setReady(false);
        setBalance('—');
      }
    }
  }
  useEffect(() => {
    if (!client) return;
    let running = false;
    const t = setInterval(() => {
      if (running || lock.current) return;
      running = true;
      void refresh(client, active?.id)
        .catch(() => {
          if (liveClient.current === client)
            setNotice(
              'Canlı güncelleme durdu. Yenileyerek tekrar deneyin. Bekleyen işlem başarısız sayılmaz.',
            );
        })
        .finally(() => {
          running = false;
        });
    }, 8000);
    return () => clearInterval(t);
  }, [client, active?.id]);
  const connect = () =>
    run('Cüzdan bağlanıyor', async () => {
      const access = await walletRequest({ action: 'connect' });
      if (!access.address) throw new Error('Cüzdan bağlantısı onaylanmadı.');
      const address = access.address;
      const c = new AnchorClient(address, async (xdr) => {
        const result = await walletRequest({ action: 'sign', address, xdr });
        if (result.address !== address || !result.signedTxXdr)
          throw new Error('İmza, bağlı cüzdanla eşleşmiyor.');
        return result.signedTxXdr;
      });
      await c.connect();
      liveClient.current = c;
      setClient(c);
      try {
        setSubmitted(JSON.parse(localStorage.getItem(`troia:anchor:sent:${address}`) || '{}'));
      } catch {
        setSubmitted({});
      }
      await refresh(c);
    });
  const disconnect = () => {
    liveClient.current = undefined;
    setClient(undefined);
    setQuote(undefined);
    setActive(undefined);
    setInstructions(undefined);
    setHistory([]);
    setBalance('—');
    setReady(false);
    setSubmitted({});
    setUncertain(false);
    setError('');
  };
  const changeDirection = (d: Direction) => {
    setDirection(d);
    setAmount(d === 'deposit' ? '100' : '1');
    setQuote(undefined);
    setInstructions(undefined);
    setActive(undefined);
    setError('');
    setUncertain(false);
  };
  const requestQuote = () =>
    run('Teklif alınıyor', async () => {
      if (!client) return;
      setQuote(await client.quote(direction, amount));
    });
  const begin = () =>
    run('Transfer oluşturuluyor', async () => {
      if (!client || !quote) return;
      setUncertain(true);
      const i = await client.start(direction, quote);
      setInstructions(i);
      setQuote(undefined);
      setUncertain(false);
      await refresh(client, i.id);
    });
  const send = () =>
    run('Çekme işlemini Freighter’da onaylayın', async () => {
      if (!client || !active || !instructions || !active.amount_in) return;
      // Persist BEFORE broadcast. A lost response must never turn into a second payment.
      const next = {
        ...submitted,
        [active.id]: 'Gönderim bekleniyor. Yeniden göndermeden önce geçmişi kontrol edin.',
      };
      const tx = await client.payWithdrawal(instructions, active.amount_in, () => {
        localStorage.setItem(`troia:anchor:sent:${client.account}`, JSON.stringify(next));
        setSubmitted(next);
      });
      next[active.id] = tx.hash;
      localStorage.setItem(`troia:anchor:sent:${client.account}`, JSON.stringify(next));
      setSubmitted({ ...next });
      setNotice('USDC gönderildi. Banka simülasyonu için anchor onayı bekleniyor.');
      await refresh(client, active.id);
    });
  const select = (t: AnchorTransaction) => {
    setActive(t);
    setQuote(undefined);
    setDirection(t.kind.startsWith('deposit') ? 'deposit' : 'withdraw');
    setUncertain(false);
    setInstructions({
      id: t.id,
      instructions: t.instructions,
      more_info_url: t.more_info_url,
      account_id: t.withdraw_anchor_account,
      memo: t.withdraw_memo,
      memo_type: t.withdraw_memo_type,
    });
  };
  const deposit = direction === 'deposit';
  const settled = active?.status === 'completed';
  return (
    <div className="anchor-shell">
      <header className="anchor-nav">
        <a href="../wizard/index.html" className="troia-wordmark">
          <img src={troiaLogo} alt="" />
          <span>TROIA</span>
        </a>
        <nav aria-label="Cüzdan ve ödeme">
          <a href="../wizard/index.html">Kartla ödeme ↗</a>
          <span className="network-pill">Stellar Testnet</span>
          {client ? (
            <button disabled={!!busy} onClick={disconnect}>
              {short(client.account)} · Bağlantıyı kes
            </button>
          ) : (
            <button className="primary" disabled={!!busy} onClick={connect}>
              Freighter’ı bağla ↗
            </button>
          )}
        </nav>
      </header>
      <main className="anchor-main">
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">BANKA TRANSFERİ</div>
            <h1>Liranız ve USDC’niz, aynı yerde.</h1>
            <p>Lira yatırın veya USDC’nizi bankaya çekin.</p>
          </div>
          <div className="wallet-balance">
            <small>TEST USDC BAKİYENİZ</small>
            <strong>
              {balance === '—'
                ? '—'
                : Number(balance).toLocaleString('tr-TR', { maximumFractionDigits: 7 })}
            </strong>
            <span>{client ? short(client.account) : 'Başlamak için cüzdanınızı bağlayın'}</span>
          </div>
        </div>
        <div className="sandbox-note">
          <b>Test ortamı</b> Banka hareketleri simülasyondur. USDC transferleri Stellar Testnet’te
          gerçekleşir. Yalnızca test varlığı kullanın.
        </div>
        {error && (
          <div role="alert" className="error-note">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {active?.status === 'pending_anchor' &&
          active.started_at &&
          now - Date.parse(active.started_at) > 60_000 && (
            <div role="status" className="notice">
              Anchor bu transferi henüz tamamlamadı. Tekrar ödeme göndermeyin. Durumu yenileyin veya
              işlemi geçmişten açın.
            </div>
          )}
        <div className="anchor-grid">
          <section className="transfer-panel">
            <div className="segmented">
              <button
                disabled={!!busy}
                aria-pressed={deposit}
                onClick={() => changeDirection('deposit')}
              >
                Lira yatır
              </button>
              <button
                disabled={!!busy}
                aria-pressed={!deposit}
                onClick={() => changeDirection('withdraw')}
              >
                Bankaya çek
              </button>
            </div>
            {!client ? (
              <div className="connect-empty">
                <div className="transfer-symbols" aria-hidden="true">
                  <span>₺</span>
                  <i />
                  <span>$</span>
                </div>
                <h2>Cüzdanınızı bağlayın</h2>
                <p>
                  Freighter ile bağlanın. Giriş ve zincir üzerindeki transferleri kendi cüzdanınızda
                  onaylayın.
                </p>
                <button className="primary" disabled={!!busy} onClick={connect}>
                  Cüzdanı bağla ↗
                </button>
                <a href="https://www.freighter.app/" target="_blank" rel="noreferrer">
                  Freighter’ı edin ↗
                </a>
              </div>
            ) : !ready ? (
              <div className="connect-empty">
                <h2>Test cüzdanınızı hazırlayın</h2>
                <p>
                  Gerekirse ücretsiz test XLM alın ve USDC alım iznini onaylayın. Böylece anchor
                  USDC’yi doğrudan cüzdanınıza gönderebilir.
                </p>
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run('Test cüzdanı hazırlanıyor', async () => {
                      await client.prepareWallet();
                      await refresh(client);
                    })
                  }
                >
                  Cüzdanı hazırla ↗
                </button>
              </div>
            ) : active ? (
              <div className="transfer-body">
                <div className="eyebrow">{deposit ? 'LİRA YATIRMA' : 'BANKAYA ÇEKME'}</div>
                <h2>{settled ? 'Transfer tamamlandı' : bankStatus(active.status)}</h2>
                <p>
                  {active.message ||
                    (settled
                      ? 'Anchor bu transferi onayladı.'
                      : 'Transferinizi aşağıdan takip edin. Sayfayı yenilemek işlemi iptal etmez.')}
                </p>
                <div className="receipt">
                  <div>
                    <span>Gönderdiğiniz</span>
                    <b>
                      {active.amount_in ?? '—'} {deposit ? 'TRY' : 'USDC'}
                    </b>
                  </div>
                  <div>
                    <span>Alacağınız</span>
                    <b>
                      {active.amount_out ?? '—'} {deposit ? 'USDC' : 'TRY'}
                    </b>
                  </div>
                </div>
                {Object.entries(instructions?.instructions ?? active.instructions ?? {}).map(
                  ([key, v]) => (
                    <label className="instruction" key={key}>
                      <span>{v.description || key.replaceAll('_', ' ')}</span>
                      <Copy value={v.value} />
                    </label>
                  ),
                )}
                {deposit && active.status === 'pending_user_transfer_start' && (
                  <button
                    className="primary full"
                    disabled={!!busy || !active.amount_in}
                    onClick={() =>
                      run('Banka yatırması simüle ediliyor', async () => {
                        await client.simulate(active.id, active.amount_in!);
                        await refresh(client, active.id);
                      })
                    }
                  >
                    Test banka transferini simüle et
                  </button>
                )}
                {!deposit &&
                  active.status === 'pending_user_transfer_start' &&
                  !submitted[active.id] &&
                  instructions?.account_id && (
                    <>
                      <label className="instruction">
                        Anchor alıcı adresi
                        <Copy value={instructions.account_id} />
                      </label>
                      <p>Memo ID: {instructions.memo}</p>
                      <button className="primary full" disabled={!!busy} onClick={send}>
                        USDC transferini onayla ↗
                      </button>
                    </>
                  )}
                {submitted[active.id] && (
                  <p className="notice">
                    Transfer gönderildi veya doğrulama bekliyor. Tekrar göndermeyin.{' '}
                    {submitted[active.id]}
                  </p>
                )}
                {active.stellar_transaction_id &&
                  /^[a-f0-9]{64}$/i.test(active.stellar_transaction_id) && (
                    <a
                      className="text-link"
                      href={`${ANCHOR.explorer}/tx/${active.stellar_transaction_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Stellar’da görüntüle ↗
                    </a>
                  )}
                {trustedLink(active.more_info_url ?? instructions?.more_info_url) && (
                  <a
                    className="text-link"
                    href={trustedLink(active.more_info_url ?? instructions?.more_info_url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Anchor talimatları ve işlem takibi ↗
                  </a>
                )}
                <button
                  className="secondary full"
                  disabled={!!busy}
                  onClick={() => run('Transfer yenileniyor', () => refresh(client, active.id))}
                >
                  Durumu yenile
                </button>
                <button
                  className="text-link"
                  disabled={!!busy}
                  onClick={() => {
                    setActive(undefined);
                    setInstructions(undefined);
                  }}
                >
                  Yeni transfere dön
                </button>
              </div>
            ) : (
              <div className="transfer-body">
                <label htmlFor="amount">
                  {deposit ? 'Yatıracağınız tutar' : 'Çekeceğiniz tutar'}
                </label>
                <div className="amount-input">
                  <input
                    id="amount"
                    inputMode="decimal"
                    value={amount}
                    disabled={!!busy}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setQuote(undefined);
                    }}
                  />
                  <b>{deposit ? 'TRY' : 'USDC'}</b>
                </div>
                <p className="muted">
                  {deposit
                    ? 'Banka transferi ile Stellar cüzdanınıza'
                    : 'Stellar cüzdanınızdan test banka hesabına'}
                </p>
                {quote && (
                  <div className="receipt">
                    <div>
                      <span>Alacağınız</span>
                      <strong>
                        {quote.buy_amount} {deposit ? 'USDC' : 'TRY'}
                      </strong>
                    </div>
                    <div>
                      <span>Anchor ücreti (dahil)</span>
                      <b>
                        {quote.fee?.total ?? '—'} {deposit ? 'TRY' : 'USDC'}
                      </b>
                    </div>
                    <div>
                      <span>Teklifin son geçerliliği</span>
                      <b>{new Date(quote.expires_at).toLocaleTimeString()}</b>
                    </div>
                    <p>
                      {quoteIsLive(quote, now)
                        ? 'Bu teklif bağlı cüzdanınıza aittir.'
                        : 'Teklifin süresi doldu. Yeni teklif alın.'}
                    </p>
                  </div>
                )}
                {uncertain ? (
                  <div className="notice">
                    Önceki istek anchor’a ulaşmış olabilir. Yeni transfer açmadan önce geçmişi
                    yenileyip o işlemi kontrol edin.
                    <button onClick={() => run('Geçmiş kontrol ediliyor', () => refresh(client))}>
                      Geçmişi yenile
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary full"
                    disabled={!!busy}
                    onClick={quote && quoteIsLive(quote, now) ? begin : requestQuote}
                  >
                    {quote && quoteIsLive(quote, now)
                      ? 'Teklifi onayla ve devam et →'
                      : 'Dönüşüm teklifi al →'}
                  </button>
                )}
                <p className="fine-print">
                  {deposit
                    ? 'Sonraki adımda IBAN ve transfer referansını kontrol edin.'
                    : 'Mock anchor test banka hesabı kullanır. Gerçek IBAN gerekmez.'}{' '}
                  Ağ ücretleri test XLM ile ödenir.
                </p>
              </div>
            )}
            {busy && (
              <div className="busy" role="status">
                ● {busy}…
              </div>
            )}
          </section>
          <aside className="journey">
            <div className="eyebrow">NASIL ÇALIŞIR</div>
            <h2>{deposit ? 'Liradan cüzdanınıza' : 'Cüzdanınızdan liraya'}</h2>
            {(deposit
              ? [
                  ['Teklifi inceleyin', 'Kuru, ücreti ve USDC tutarını görün.'],
                  [
                    'Test banka transferini başlatın',
                    'IBAN ve referans, yatırma işleminizi tanımlar.',
                  ],
                  ['Test USDC’yi alın', 'Anchor varlığı cüzdanınıza gönderir.'],
                ]
              : [
                  ['Teklifi inceleyin', 'Devam etmeden önce lira tutarını görün.'],
                  ['Cüzdanınızda onaylayın', 'Alıcı adresi ve memo işlemde yer alır.'],
                  ['Banka ödemesini takip edin', 'Anchor simüle edilen ödemeyi onaylar.'],
                ]
            ).map(([title, body], n) => (
              <div className="journey-step" key={title}>
                <span>0{n + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </div>
            ))}
            <div className="provider">
              <small>ALTYAPI</small>
              <b>TR Mock Anchor ↗</b>
              <p>
                Stellar Testnet üzerinde SEP standartları. Bağımsız test ortamıdır, BiLira üretim
                servisi değildir.
              </p>
            </div>
          </aside>
        </div>
        <section className="history-panel">
          <div className="history-title">
            <h2>Transfer geçmişi</h2>
            <button
              disabled={!client || !!busy}
              onClick={() => client && run('Geçmiş yenileniyor', () => refresh(client, active?.id))}
            >
              Yenile ↻
            </button>
          </div>
          {!client ? (
            <p>Transferlerinizi görmek için cüzdanınızı bağlayın.</p>
          ) : history.length === 0 ? (
            <p>Henüz transfer yok. İlk işleminiz burada görünecek.</p>
          ) : (
            history.map((t) => (
              <button
                className="history-row"
                key={t.id}
                disabled={!!busy}
                onClick={() => select(t)}
              >
                <span className="history-icon">{t.kind.startsWith('deposit') ? '↙' : '↗'}</span>
                <span>
                  <b>{t.kind.startsWith('deposit') ? 'Lira yatırma' : 'Bankaya çekme'}</b>
                  <small>{t.started_at ? new Date(t.started_at).toLocaleString() : t.id}</small>
                </span>
                <span className="history-amount">
                  {t.amount_in} {t.kind.startsWith('deposit') ? 'TRY' : 'USDC'}
                </span>
                <span className="status" data-complete={t.status === 'completed'}>
                  {bankStatus(t.status)}
                </span>
                <span>↗</span>
              </button>
            ))
          )}
        </section>
      </main>
      <footer>
        Troia · Stellar üzerinde<span>Kartlı ödeme havuzu ayrı yönetilir ve fonlanır.</span>
      </footer>
    </div>
  );
}
