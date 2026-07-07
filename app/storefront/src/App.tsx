import { useEffect, useMemo, useState, type CSSProperties, type ChangeEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  PRODUCTS,
  CATEGORIES,
  SIZES,
  priceOf,
  findProduct,
  imageOf,
  descriptionOf,
  type Product,
  type ProductCategory,
  type Size,
} from './data/products';
import { STORE, COINS, orderRef, buildSep7, cryptoAmount, shortAddr, type Coin, type CryptoNetwork } from './config';

// STORE — a fully working demo streetwear site. Browse -> product -> cart -> a 3-step checkout
// (Address -> Shipping -> Payment). At payment the shopper chooses Card or Crypto; the crypto option renders a
// standard SEP-7 (web+stellar:pay) request for USDC on Stellar — the point a supported browser extension detects
// and offers to pay by card. The store knows nothing about that bridge; it just accepts USDC on Stellar.

type Section = 'shop' | 'new' | 'archive' | 'sale';
type View = { name: 'list'; section: Section } | { name: 'product'; id: string } | { name: 'checkout' };

interface CartLine { product: Product; size: Size; qty: number }
type CartMap = Record<string, CartLine>;

const NAV: { label: string; section: Section }[] = [
  { label: 'Shop', section: 'shop' },
  { label: 'New', section: 'new' },
  { label: 'Archive', section: 'archive' },
  { label: 'Sale', section: 'sale' },
];

const SECTION_META: Record<Section, { title: string; sub: string; base: (p: Product) => boolean }> = {
  shop: { title: 'The Drop', sub: 'Current season — every run.', base: () => true },
  new: { title: 'New Arrivals', sub: "Just dropped. Won't last.", base: (p) => p.tag === 'new' },
  archive: { title: 'Archive', sub: 'Every piece, every run.', base: () => true },
  sale: { title: 'Sale', sub: 'Marked down while stock lasts.', base: (p) => !!p.sale },
};

function usd(n: number): string { return `$${n.toLocaleString('en-US')}`; }
function hue(p: Product): CSSProperties { return { '--hue': p.hue } as CSSProperties; }
function displayTag(p: Product): { kind: string; text: string } | null {
  if (p.sale) return { kind: 'sale', text: `-${p.sale}%` };
  if (p.tag) return { kind: p.tag, text: p.tag };
  return null;
}

function Price({ p }: { p: Product }) {
  const { now, was } = priceOf(p);
  return (
    <span className="price">
      {was && <span className="price__was">{usd(was)}</span>}
      <span className={was ? 'price__now--sale' : ''}>{usd(now)}</span>
    </span>
  );
}

function GridCard({ p, onSelect, onPick }: { p: Product; onSelect: (id: string) => void; onPick: (p: Product) => void }) {
  const soldOut = p.tag === 'sold out';
  const tag = displayTag(p);
  const img = imageOf(p);
  return (
    <article className="card">
      <div className="tile" style={hue(p)} onClick={() => onSelect(p.id)}>
        {img && <img className="tile__img" src={img} alt={p.name} loading="lazy" />}
        {tag && <span className="tile__tag" data-kind={tag.kind}>{tag.text}</span>}
      </div>
      <div className="card__meta">
        <div>
          <div className="card__title" onClick={() => onSelect(p.id)}>{p.name}</div>
          <div className="card__color">{p.colorway}</div>
        </div>
        <Price p={p} />
      </div>
      <button className="card__add" disabled={soldOut} onClick={() => onPick(p)}>{soldOut ? 'Sold out' : 'Add to cart'}</button>
    </article>
  );
}

// Size-selection overlay shown when "Add to cart" is clicked from the grid.
function SizePicker({ p, onPick, onClose }: { p: Product; onPick: (size: Size) => void; onClose: () => void }) {
  return (
    <div className="sizemodal" onClick={onClose}>
      <div className="sizemodal__panel" onClick={(e) => e.stopPropagation()}>
        <button className="sizemodal__x" onClick={onClose} aria-label="Close">×</button>
        <div className="sizemodal__name">{p.name}</div>
        <div className="sizemodal__color">{p.colorway}</div>
        <div className="sizemodal__label">Select a size</div>
        <div className="sizemodal__sizes">
          {SIZES.map((s) => (
            <button key={s} onClick={() => onPick(s)}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [cart, setCart] = useState<CartMap>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [view, setView] = useState<View>({ name: 'list', section: 'shop' });
  const [category, setCategory] = useState<ProductCategory | 'All'>('All');

  const items = useMemo(() => Object.entries(cart).map(([key, line]) => ({ key, ...line })), [cart]);
  const count = items.reduce((n, i) => n + i.qty, 0);
  const subtotal = items.reduce((n, i) => n + priceOf(i.product).now * i.qty, 0);
  const estShip = subtotal >= 150 || subtotal === 0 ? 0 : 12;

  const add = (p: Product, size: Size) => {
    const key = `${p.id}:${size}`;
    setCart((c) => ({ ...c, [key]: { product: p, size, qty: (c[key]?.qty ?? 0) + 1 } }));
    setCartOpen(true);
  };
  const setQty = (key: string, qty: number) => {
    setCart((c) => {
      if (qty <= 0) { const { [key]: _d, ...rest } = c; return rest; }
      return { ...c, [key]: { ...c[key]!, qty } };
    });
  };
  const goSection = (section: Section) => { setView({ name: 'list', section }); setCategory('All'); window.scrollTo(0, 0); };
  const goProduct = (id: string) => { setView({ name: 'product', id }); window.scrollTo(0, 0); };

  return (
    <>
      <div className="ticker">Free shipping over $150 · New drop live · Limited runs only</div>

      <header className="nav">
        <div className="container nav__row">
          <button className="brand" onClick={() => goSection('shop')}>STORE</button>
          <nav className="nav__links">
            {NAV.map((n) => (
              <button key={n.section} data-active={view.name === 'list' && view.section === n.section} onClick={() => goSection(n.section)}>
                {n.label}
              </button>
            ))}
          </nav>
          <button className="cart-btn" onClick={() => setCartOpen(true)}>Cart {count > 0 && <span>[{count}]</span>}</button>
        </div>
      </header>

      {view.name === 'list' && (
        <ListView section={view.section} category={category} onCategory={setCategory} onSelect={goProduct} onAdd={add} />
      )}
      {view.name === 'product' && <ProductView id={view.id} onAdd={add} onBack={() => goSection('shop')} />}
      {view.name === 'checkout' && <Checkout items={items} subtotal={subtotal} onBack={() => goSection('shop')} />}

      <footer className="footer">
        <div className="container">
          <div className="footer__cols">
            <div className="footer__brand">
              <h4>STORE</h4>
              <p>Engineered decay. Streetwear for the signal-lost. Shipped worldwide, dropped without warning.</p>
            </div>
            <div><h4>Shop</h4><ul>{['Tops', 'Outerwear', 'Bottoms', 'Accessories'].map((x) => <li key={x} onClick={() => goSection('shop')}>{x}</li>)}</ul></div>
            <div><h4>Help</h4><ul>{['Shipping', 'Returns', 'Sizing', 'Contact'].map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div><h4>Account</h4><ul>{['Sign in', 'Register', 'Orders', 'Wishlist'].map((x) => <li key={x}>{x}</li>)}</ul></div>
          </div>
          <div className="footer__bottom">
            <span>© 2026 STORE. All rights reserved.</span>
            <span>Terms · Privacy · Cookies</span>
          </div>
        </div>
      </footer>

      {cartOpen && (
        <>
          <div className="overlay" onClick={() => setCartOpen(false)} />
          <aside className="drawer">
            <div className="drawer__head">
              <h3>Cart {count > 0 && `· ${count}`}</h3>
              <button className="iconbtn" onClick={() => setCartOpen(false)}>×</button>
            </div>
            <div className="drawer__body">
              {items.length === 0 ? (
                <div className="drawer__empty">Your cart is empty.</div>
              ) : (
                items.map(({ key, product: p, size, qty }) => (
                  <div className="line" key={key}>
                    <div className="line__thumb" style={hue(p)} />
                    <div className="line__info">
                      <div className="line__name">{p.name}</div>
                      <div className="line__color">{p.colorway} · Size {size}</div>
                      <div className="qty">
                        <button onClick={() => setQty(key, qty - 1)}>−</button>
                        <span>{qty}</span>
                        <button onClick={() => setQty(key, qty + 1)}>+</button>
                      </div>
                      <button className="remove" onClick={() => setQty(key, 0)}>Remove</button>
                    </div>
                    <div className="line__price">{usd(priceOf(p).now * qty)}</div>
                  </div>
                ))
              )}
            </div>
            {items.length > 0 && (
              <div className="drawer__foot">
                <div className="summ"><span>Subtotal</span><b>{usd(subtotal)}</b></div>
                <div className="summ"><span>Shipping</span><b>{estShip === 0 ? 'Free' : `from ${usd(estShip)}`}</b></div>
                <div className="summ summ--total"><span>Total</span><b>{usd(subtotal + estShip)}</b></div>
                <button className="btn btn--block" onClick={() => { setCartOpen(false); setView({ name: 'checkout' }); window.scrollTo(0, 0); }}>Checkout</button>
              </div>
            )}
          </aside>
        </>
      )}
    </>
  );
}

/* ---------------- list ---------------- */
interface ListProps {
  section: Section; category: ProductCategory | 'All';
  onCategory: (c: ProductCategory | 'All') => void; onSelect: (id: string) => void; onAdd: (p: Product, size: Size) => void;
}
function ListView({ section, category, onCategory, onSelect, onAdd }: ListProps) {
  const meta = SECTION_META[section];
  const list = PRODUCTS.filter(meta.base).filter((p) => category === 'All' || p.category === category);
  const [pick, setPick] = useState<Product | null>(null);
  return (
    <main>
      {section === 'shop' && (
        <section className="hero">
          <div className="container hero__inner">
            <div className="hero__kicker">SS26 · Signal-lost series</div>
            <h1 className="hero__title">Engineered<br /><em>Decay.</em></h1>
            <p className="hero__sub">Distressed, glitch-washed streetwear built in limited runs. When it's gone, it stays gone.</p>
            <button className="btn" onClick={() => document.getElementById('shop')?.scrollIntoView({ behavior: 'smooth' })}>Shop the drop</button>
          </div>
        </section>
      )}
      <section className="shop container" id="shop">
        <div className="shop__head">
          <h2>{meta.title}</h2>
          <div className="filters">
            {CATEGORIES.map((c) => (<button key={c} data-active={category === c} onClick={() => onCategory(c)}>{c}</button>))}
          </div>
        </div>
        <p className="shop__sub">{meta.sub}</p>
        {list.length === 0 ? (
          <div className="empty">Nothing here right now.</div>
        ) : (
          <div className="grid">
            {list.map((p) => <GridCard key={p.id} p={p} onSelect={onSelect} onPick={setPick} />)}
          </div>
        )}
      </section>
      {pick && (
        <SizePicker
          p={pick}
          onPick={(size) => { onAdd(pick, size); setPick(null); }}
          onClose={() => setPick(null)}
        />
      )}
    </main>
  );
}

/* ---------------- product ---------------- */
function ProductView({ id, onAdd, onBack }: { id: string; onAdd: (p: Product, size: Size) => void; onBack: () => void }) {
  const p = findProduct(id);
  const [size, setSize] = useState<Size>('M');
  if (!p) return <main className="container" style={{ padding: '60px 0' }}><button className="link-back" onClick={onBack}>← Back to shop</button><p>Product not found.</p></main>;
  const soldOut = p.tag === 'sold out';
  const img = imageOf(p);
  const desc = descriptionOf(p);
  const t = displayTag(p);
  return (
    <main className="product container">
      <button className="link-back" onClick={onBack}>← Back to shop</button>
      <div className="product__grid">
        <div className="tile tile--lg" style={hue(p)}>
          {img && <img className="tile__img" src={img} alt={p.name} />}
          {t && <span className="tile__tag" data-kind={t.kind}>{t.text}</span>}
        </div>
        <div className="product__info">
          <h1>{p.name}</h1>
          <div className="product__color">{p.colorway}</div>
          <div className="product__price"><Price p={p} /></div>
          <p className="product__desc">{desc}</p>
          <div className="sizes">{SIZES.map((s) => (<button key={s} data-active={size === s} onClick={() => setSize(s)}>{s}</button>))}</div>
          <button className="btn btn--block" disabled={soldOut} onClick={() => onAdd(p, size)}>{soldOut ? 'Sold out' : `Add to cart · ${usd(priceOf(p).now)}`}</button>
          <div className="product__specs">
            <div className="spec"><span>Category</span><span>{p.category}</span></div>
            <div className="spec"><span>Colorway</span><span>{p.colorway}</span></div>
            <div className="spec"><span>Fit</span><span>Oversized</span></div>
            <div className="spec"><span>Material</span><span>Heavyweight cotton</span></div>
            <div className="spec"><span>SKU</span><span>{p.id.toUpperCase().replace(/-/g, '')}</span></div>
          </div>
        </div>
      </div>
    </main>
  );
}

/* ---------------- checkout (3 steps) ---------------- */
const SHIP: Record<string, { label: string; note: string; price: (sub: number) => number }> = {
  standard: { label: 'Standard', note: '5–8 business days', price: (s) => (s >= 150 ? 0 : 12) },
  express: { label: 'Express', note: '2–3 business days', price: () => 18 },
  overnight: { label: 'Overnight', note: 'Next business day', price: () => 35 },
};
const emptyAddr = { email: '', first: '', last: '', address: '', city: '', postal: '', country: '' };

function Checkout({ items, subtotal, onBack }: { items: { key: string; product: Product; size: Size; qty: number }[]; subtotal: number; onBack: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [addr, setAddr] = useState({ ...emptyAddr });
  const [shipKey, setShipKey] = useState('standard');
  const [pay, setPay] = useState<'card' | 'crypto' | null>(null);
  const [placed, setPlaced] = useState(false);

  const set = (k: keyof typeof emptyAddr) => (e: ChangeEvent<HTMLInputElement>) => setAddr((a) => ({ ...a, [k]: e.target.value }));
  const addrValid = addr.email.includes('@') && addr.first && addr.last && addr.address && addr.city && addr.postal && addr.country;

  const shipping = SHIP[shipKey]!.price(subtotal);
  const total = subtotal + shipping;

  if (placed) {
    return (
      <main className="checkout container">
        <div className="placed">
          <div className="placed__mark">✓</div>
          <h2>Order placed</h2>
          <p>Thanks, {addr.first || 'friend'}. A confirmation is on its way to {addr.email || 'your inbox'}.</p>
          <button className="btn" onClick={onBack}>Continue shopping</button>
        </div>
      </main>
    );
  }

  return (
    <main className="checkout container">
      <button className="link-back" onClick={onBack}>← Back to shop</button>

      {/* stepper */}
      <div className="steps">
        {(['Address', 'Shipping', 'Payment'] as const).map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const state = step === n ? 'active' : step > n ? 'done' : 'todo';
          return (
            <button key={label} className="step" data-state={state} disabled={n > step} onClick={() => n < step && setStep(n)}>
              <span className="step__num">{step > n ? '✓' : n}</span>
              <span className="step__label">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="checkout__grid">
        <div>
          {/* STEP 1 — address */}
          {step === 1 && (
            <div className="panel">
              <h3>Shipping address</h3>
              <div className="field"><label>Email</label><input value={addr.email} onChange={set('email')} placeholder="you@example.com" /></div>
              <div className="field field--row">
                <div><label>First name</label><input value={addr.first} onChange={set('first')} placeholder="First" /></div>
                <div><label>Last name</label><input value={addr.last} onChange={set('last')} placeholder="Last" /></div>
              </div>
              <div className="field"><label>Address</label><input value={addr.address} onChange={set('address')} placeholder="Street address" /></div>
              <div className="field field--row">
                <div><label>City</label><input value={addr.city} onChange={set('city')} placeholder="City" /></div>
                <div><label>Postal code</label><input value={addr.postal} onChange={set('postal')} placeholder="00000" /></div>
              </div>
              <div className="field"><label>Country</label><input value={addr.country} onChange={set('country')} placeholder="Country" /></div>
              <button className="btn btn--block" disabled={!addrValid} onClick={() => setStep(2)}>Continue to shipping</button>
              {!addrValid && <p className="hint">Enter your full address to continue.</p>}
            </div>
          )}

          {/* STEP 2 — shipping */}
          {step === 2 && (
            <div className="panel">
              <h3>Shipping method</h3>
              {Object.entries(SHIP).map(([key, m]) => {
                const price = m.price(subtotal);
                return (
                  <label key={key} className="ship-opt" data-active={shipKey === key}>
                    <input type="radio" name="ship" checked={shipKey === key} onChange={() => setShipKey(key)} />
                    <span className="ship-opt__main"><b>{m.label}</b><span>{m.note}</span></span>
                    <span className="ship-opt__price">{price === 0 ? 'Free' : usd(price)}</span>
                  </label>
                );
              })}
              <div className="row-btns">
                <button className="btn btn--ghost" onClick={() => setStep(1)}>Back</button>
                <button className="btn" onClick={() => setStep(3)}>Continue to payment</button>
              </div>
            </div>
          )}

          {/* STEP 3 — payment */}
          {step === 3 && (
            <div className="panel">
              <h3>Payment</h3>
              <div className="pay-methods">
                <button className="pay-method" data-active={pay === 'card'} onClick={() => setPay('card')}>
                  <b>Credit / debit card</b><span>Visa · Mastercard</span>
                </button>
                <button className="pay-method" data-active={pay === 'crypto'} onClick={() => setPay('crypto')}>
                  <b>Crypto</b><span>BTC · ETH · USDC · more</span>
                </button>
              </div>

              {pay === 'card' && (
                <div className="pay-body">
                  <div className="field"><label>Card number</label><input placeholder="4242 4242 4242 4242" /></div>
                  <div className="field"><label>Name on card</label><input placeholder="Full name" /></div>
                  <div className="field field--row">
                    <div><label>Expiry</label><input placeholder="MM / YY" /></div>
                    <div><label>CVC</label><input placeholder="123" /></div>
                  </div>
                  <button className="btn btn--block" onClick={() => setPlaced(true)}>Pay {usd(total)}</button>
                </div>
              )}

              {pay === 'crypto' && <CryptoPay total={total} />}

              <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={() => setStep(2)}>Back</button>
            </div>
          )}
        </div>

        {/* order summary */}
        <div className="panel panel--sticky">
          <h3>Order</h3>
          {items.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Your cart is empty.</p>
          ) : (
            <>
              {items.map(({ key, product: p, size, qty }) => (
                <div className="co-line" key={key}><span>{p.name} · {size} × {qty}</span><b>{usd(priceOf(p).now * qty)}</b></div>
              ))}
              <div className="co-line"><span>Subtotal</span><b>{usd(subtotal)}</b></div>
              <div className="co-line"><span>Shipping</span><b>{step >= 2 ? (shipping === 0 ? 'Free' : usd(shipping)) : '—'}</b></div>
              <div className="co-total"><span>Total</span><span>{usd(total)}</span></div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function CryptoPay({ total }: { total: number }) {
  const [coin, setCoin] = useState<Coin | null>(null);
  const [net, setNet] = useState<CryptoNetwork | null>(null);
  const memo = useState(() => orderRef())[0];
  const [left, setLeft] = useState(15 * 60);

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);

  const pickCoin = (c: Coin) => { setCoin(c); setNet(c.networks.length === 1 ? c.networks[0]! : null); };

  // step A — choose a currency
  if (!coin) {
    return (
      <div className="pay-body">
        <div className="crypto-head">Select a currency</div>
        <div className="coin-grid">
          {COINS.map((c) => (
            <button key={c.code} className="coin" onClick={() => pickCoin(c)}>
              <span className="coin__icon" style={{ background: c.color }}>{c.code.slice(0, 2)}</span>
              <span className="coin__code">{c.code}</span>
              <span className="coin__name">{c.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // step B — choose a network (only when the coin spans several)
  if (!net) {
    return (
      <div className="pay-body">
        <button className="link-back" onClick={() => setCoin(null)}>← Currencies</button>
        <div className="crypto-head">Choose the {coin.code} network</div>
        <div className="net-list">
          {coin.networks.map((n) => (
            <button key={n.id} className="net-opt" onClick={() => setNet(n)}>
              <b>{n.name}</b><span>›</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // step C — the payment page
  const amount = cryptoAmount(total, coin.rate);
  const isStellar = net.id === 'stellar';
  const isUsdcStellar = coin.code === 'USDC' && isStellar;
  const qr = isStellar
    ? buildSep7(amount, memo, coin.code === 'USDC' ? { code: 'USDC', issuer: STORE.usdcIssuer } : 'native')
    : net.addr;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="pay-body">
      <button className="link-back" onClick={() => (coin.networks.length > 1 ? setNet(null) : setCoin(null))}>← Back</button>
      <div className="sep7">
        <div className="sep7__amount">{amount} <span>{coin.code}</span></div>
        <div className="sep7__net">on {net.name}</div>
        <div className="sep7__qr"><QRCodeSVG value={qr} size={168} bgColor="#ffffff" fgColor="#000000" level="M" /></div>
        <div className="sep7__rows">
          <CopyRow label="Send to" value={shortAddr(net.addr)} copy={net.addr} />
          {net.needsMemo && <CopyRow label="Memo" value={memo} copy={memo} />}
          <div className="sep7__row"><span>Amount</span><b>{amount} {coin.code}</b></div>
        </div>
        <div className="pay-status"><span className="pay-status__dot" /> Waiting for payment · rate locked {mm}:{ss}</div>
        {isStellar && <a className="btn btn--ghost btn--block" href={qr} style={{ marginTop: 12 }}>Open in wallet</a>}
        {isUsdcStellar && (
          <p className="sep7__note">
            Have a supported browser extension installed? It can offer to pay this USDC-on-Stellar invoice with
            your card instead — no crypto needed.
          </p>
        )}
      </div>
    </div>
  );
}

function CopyRow({ label, value, copy }: { label: string; value: string; copy: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="sep7__row">
      <span>{label}</span>
      <button className="copy" onClick={() => { navigator.clipboard?.writeText(copy); setDone(true); setTimeout(() => setDone(false), 1200); }}>
        <b>{value}</b> {done ? '✓' : '⧉'}
      </button>
    </div>
  );
}
