import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { GAMES, priceOf, usd, type Game } from './data/games';
import { STORE, gameKey, orderRef, buildSep7 } from './config';

type View =
  | { name: 'shop' }
  | { name: 'checkout' }
  | {
      name: 'paid';
      orderId: string;
      keys: readonly KeyLine[];
      txHash: string | null;
      try: string | null;
    };

interface KeyLine {
  readonly title: string;
  readonly key: string;
}

type PayStep = 'method' | 'crypto';

const NETWORKS = [{ id: 'stellar', label: 'Stellar', note: 'Test USDC' }] as const;

export default function App(): React.ReactElement {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [view, setView] = useState<View>({ name: 'shop' });
  const [genre, setGenre] = useState<string>('All');
  const [email, setEmail] = useState('judge@example.com');
  const [step, setStep] = useState<PayStep>('method');
  const [network, setNetwork] = useState<string>('stellar');
  const [order, setOrder] = useState<string>(() => orderRef());
  const [copied, setCopied] = useState<string | null>(null);
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const lines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ game: GAMES.find((g) => g.id === id)!, qty }))
        .filter((l) => l.game !== undefined),
    [cart],
  );
  const total = lines.reduce((n, l) => n + priceOf(l.game).now * l.qty, 0);
  const totalStr = total.toFixed(2);
  const count = lines.reduce((n, l) => n + l.qty, 0);

  // The extension posts this once the USDC leg has settled on chain. That is the only Troia-aware line in the
  // store: no SDK, no key, no callback URL.
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data as {
        source?: string;
        type?: string;
        orderId?: string;
        txHash?: string | null;
        paidPriceTry?: string | null;
      } | null;
      if (!d || d.source !== 'troia-extension' || d.type !== 'TROIA_PAID') return;
      const current = Object.entries(cartRef.current)
        .map(([id, qty]) => ({ game: GAMES.find((g) => g.id === id)!, qty }))
        .filter((l) => l.game !== undefined);
      if (current.length === 0) return;
      const keys: KeyLine[] = current.flatMap((l) =>
        Array.from({ length: l.qty }, () => ({ title: l.game.name, key: gameKey() })),
      );
      setView({
        name: 'paid',
        orderId: typeof d.orderId === 'string' && d.orderId.length > 0 ? d.orderId : order,
        keys,
        txHash: typeof d.txHash === 'string' ? d.txHash : null,
        try: typeof d.paidPriceTry === 'string' ? d.paidPriceTry : null,
      });
      setCart({});
      window.scrollTo(0, 0);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [order]);

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1400);
  };

  const add = (g: Game): void => {
    setCart((c) => ({ ...c, [g.id]: (c[g.id] ?? 0) + 1 }));
  };
  const remove = (id: string): void => {
    const next = { ...cart };
    delete next[id];
    setCart(next);
    if (Object.keys(next).length === 0) {
      setView({ name: 'shop' });
      setStep('method');
    }
  };

  const shown = genre === 'All' ? GAMES : GAMES.filter((g) => g.genre === genre);
  const genres = ['All', ...new Set(GAMES.map((g) => g.genre))];

  return (
    <div className="app">
      <header className="nav">
        <a className="brand" href="/">
          <img src="/brand/troia-logo.png" alt="" />
          <span>
            TROIA<small>THE DEMO STORE</small>
          </span>
        </a>
        <nav className="links">
          <button onClick={() => setView({ name: 'shop' })}>Collection</button>
          <a href="https://troia-extension.vercel.app/#install">Installation guide ↗</a>
          <a href="https://troia-extension.vercel.app/#install">About Troia ↗</a>
        </nav>
        <button
          className="cartbtn"
          onClick={() => count > 0 && setView({ name: 'checkout' })}
          disabled={count === 0}
        >
          Bag ({count})
        </button>
      </header>

      <div className="strip">
        <span>THE TROIA TESTNET EXPERIENCE</span>
        <span>No real charges. No goods are shipped.</span>
      </div>

      {view.name === 'shop' && (
        <main className="wrap">
          <section className="hero">
            <div>
              <div className="eyebrow">THE EVERYDAY COLLECTION / 2026</div>
              <h1>
                Good essentials.
                <br />
                <em>A different way to pay.</em>
              </h1>
            </div>
            <div className="shop-intro">
              <p>
                A small collection for a real test checkout. Choose an item and let Troia handle the
                payment.
              </p>
              <a href="https://troia-extension.vercel.app/#install">
                Install the Troia extension ↗
              </a>
            </div>
          </section>
          <div className="collection-line">
            <span>Explore the collection</span>
            <span>Every item · 0.50 test USDC</span>
          </div>
          <div className="filters">
            {genres.map((g) => (
              <button
                key={g}
                className={g === genre ? 'chip on' : 'chip'}
                onClick={() => setGenre(g)}
              >
                {g.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="grid">
            {shown.map((g) => {
              const p = priceOf(g);
              return (
                <article className="card" key={g.id}>
                  <div className="cover">
                    <img src={g.image} alt={g.name} loading="lazy" />
                    {g.tag && <span className="tag">{g.tag}</span>}
                  </div>
                  <div className="meta">
                    <h3>{g.name}</h3>
                    <div className="studio">{g.studio}</div>
                    <div className="platform">{g.platform}</div>
                    <div className="row">
                      <div className="price">
                        {p.was !== null && <s>{usd(p.was)}</s>} {usd(p.now)}
                      </div>
                      <button
                        className="buy"
                        onClick={() => add(g)}
                        aria-label={`Add ${g.name} to bag`}
                      >
                        {cart[g.id] ? `Add again · ${cart[g.id]} in bag` : 'Add to bag +'}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </main>
      )}

      {view.name === 'checkout' && (
        <main className="wrap two">
          <section className="pay">
            <button className="back" onClick={() => setView({ name: 'shop' })}>
              ← BACK TO STORE
            </button>

            <div className="block">
              <h2>Contact</h2>
              <p className="hint">Demo only. No email is sent and no products are shipped.</p>
              <input
                className="field"
                aria-label="Test email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                spellCheck={false}
              />
            </div>

            {step === 'method' && (
              <div className="block">
                <h2>Payment</h2>
                <button className="method" disabled>
                  <span>Credit / debit card</span>
                  <span className="muted">Not offered directly by this demo shop</span>
                </button>
                <button className="method go" onClick={() => setStep('crypto')}>
                  <span>Pay with crypto</span>
                  <span className="muted">Test USDC on Stellar</span>
                </button>
              </div>
            )}

            {step === 'crypto' && (
              <div className="block">
                <h2>Pay with crypto</h2>
                <div className="nets">
                  {NETWORKS.map((n) => (
                    <button
                      key={n.id}
                      className={n.id === network ? 'net on' : 'net'}
                      onClick={() => setNetwork(n.id)}
                    >
                      <b>{n.label}</b>
                      <span>{n.note}</span>
                    </button>
                  ))}
                </div>

                {network === 'stellar' ? (
                  <div className="invoice">
                    <div className="amt">
                      {totalStr} <span>USDC</span>
                    </div>
                    <div className="on">ON STELLAR TESTNET</div>
                    <a className="buy" href={buildSep7(totalStr, order)}>
                      Open Stellar payment
                    </a>
                    <p className="hint">
                      Troia detects this checkout. Use its payment banner, or copy the address and
                      amount into Manual payment.
                    </p>
                    <div className="qr">
                      <QRCodeSVG value={STORE.merchant} size={190} level="M" />
                    </div>
                    <div className="copyrow">
                      <div className="cl">Deposit address</div>
                      <code>{STORE.merchant}</code>
                      <button className="copy" onClick={() => copy(STORE.merchant, 'addr')}>
                        {copied === 'addr' ? 'COPIED' : 'COPY'}
                      </button>
                    </div>
                    <div className="copyrow">
                      <div className="cl">Amount</div>
                      <code>{totalStr} USDC</code>
                      <button className="copy" onClick={() => copy(totalStr, 'amt')}>
                        {copied === 'amt' ? 'COPIED' : 'COPY'}
                      </button>
                    </div>
                    <p className="note">
                      Use only the testnet USDC specified by this checkout. Your extension receipt
                      links to the settlement transaction. Never send mainnet funds.
                    </p>
                  </div>
                ) : (
                  <div className="invoice soon">
                    <p>
                      This network is not enabled on the demo. Pick <b>Stellar</b> to see the full
                      flow.
                    </p>
                  </div>
                )}
                <button className="back small" onClick={() => setStep('method')}>
                  ← other payment methods
                </button>
              </div>
            )}
          </section>

          <aside className="summary">
            <div className="checkout-progress">YOUR TEST CHECKOUT</div>
            <h2>Your bag</h2>
            {lines.map((l) => (
              <div className="sline" key={l.game.id}>
                <div>
                  <div className="sname">{l.game.name}</div>
                  <div className="ssub">
                    {l.game.platform} · x{l.qty}
                  </div>
                </div>
                <div className="sprice">
                  {usd(priceOf(l.game).now * l.qty)}
                  <button className="rm" onClick={() => remove(l.game.id)}>
                    remove
                  </button>
                </div>
              </div>
            ))}
            <div className="sline muted">
              <span>Delivery</span>
              <span>Demo only · not shipped</span>
            </div>
            <div className="sline total">
              <span>Total</span>
              <span>{usd(total)}</span>
            </div>
            <div className="ref">Order {order}</div>
            <details className="test-card" open>
              <summary>Sandbox test card</summary>
              <p>Use this card in the form opened by Troia.</p>
              <code>9792 0720 0001 7956</code>
              <div>
                <span>
                  Expiry <b>12/2030</b>
                </span>
                <span>
                  CVV <b>123</b>
                </span>
              </div>
              <p>Cardholder: Test User. No real money is charged.</p>
              <a
                href="https://docs.iyzico.com/ek-bilgiler/test-kartlari"
                target="_blank"
                rel="noreferrer"
              >
                Official test card reference ↗
              </a>
            </details>
            <button
              className="newref"
              onClick={() => {
                setOrder(orderRef());
                setStep('method');
              }}
            >
              new order reference
            </button>
          </aside>
        </main>
      )}

      {view.name === 'paid' && (
        <main className="wrap">
          <section className="done">
            <div className="tick">✓</div>
            <h1>Test checkout complete.</h1>
            <p className="hint">
              Demo receipt for <b>{email}</b>. No email was sent. Order <b>{view.orderId}</b>
              {view.try !== null && (
                <>
                  {' '}
                  · charged <b>{view.try} TL</b>
                </>
              )}
            </p>
            <div className="keys">
              {view.keys.map((k, i) => (
                <div className="keyrow" key={i}>
                  <span className="kt">{k.title}</span>
                  <span>Test purchase recorded</span>
                </div>
              ))}
            </div>
            {view.txHash !== null && (
              <p className="hint">
                Settlement proof:{' '}
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${view.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {view.txHash.slice(0, 12)}…
                </a>
              </p>
            )}
            <button
              className="buy"
              onClick={() => {
                setOrder(orderRef());
                setStep('method');
                setView({ name: 'shop' });
              }}
            >
              BACK TO STORE
            </button>
          </section>
        </main>
      )}

      <footer className="foot">
        <span>TROIA / DEMO STORE</span>
        <span>Stellar Testnet. No real payments or goods.</span>
      </footer>
    </div>
  );
}
