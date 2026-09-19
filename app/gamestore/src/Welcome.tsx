export default function Welcome() {
  return (
    <div className="app">
      <header className="nav">
        <a className="brand" href="/">
          NOVA<span className="thin">KEYS</span>
        </a>
        <a href="https://troia-extension.vercel.app/#install">Install Troia ↗</a>
      </header>
      <main className="wrap">
        <section className="hero">
          <div className="eyebrow">TROIA · JURY PLAYGROUND</div>
          <h1>
            A familiar checkout.
            <br />
            <span className="accent">A different payment rail.</span>
          </h1>
          <p>
            Test a card purchase settled in USDC on Stellar. This separate demo shop lets you
            experience Troia alongside a normal checkout.
          </p>
          <a className="buy" href="/shop">
            ENTER THE DEMO STORE →
          </a>
        </section>
        <section className="demo-guide">
          <article>
            <span>01 / INSTALL</span>
            <h2>Add Troia to Chrome</h2>
            <p>
              Download the ZIP, unzip it, then use Load unpacked in Chrome’s Extensions page with
              Developer mode on.
            </p>
            <a href="https://troia-extension.vercel.app/#install">Installation guide ↗</a>
          </article>
          <article>
            <span>02 / SHOP</span>
            <h2>Choose a test product</h2>
            <p>
              Add a product to your cart and select Pay with crypto → Stellar. Use the Troia banner,
              or enter the checkout details in its Manual payment panel.
            </p>
          </article>
          <article>
            <span>03 / PAY</span>
            <h2>Use a sandbox card</h2>
            <p>
              Enter the official iyzico Troy test card in the hosted sandbox form. Return to the
              store and follow the payment status.
            </p>
            <code>9792 0720 0001 7956</code>
            <p>Expiry: 12/2030 · CVV: 123 · Name: Test User</p>
            <a
              href="https://docs.iyzico.com/ek-bilgiler/test-kartlari"
              target="_blank"
              rel="noreferrer"
            >
              Official test card reference ↗
            </a>
          </article>
        </section>
        <section className="demo-note">
          <h2>Testnet throughout.</h2>
          <p>
            No real card charge, bank transfer, product licence or email delivery. Test USDC has no
            monetary value. Troia’s Bank transfers panel is a separate demo: connect Freighter on
            Testnet to deposit simulated TRY or withdraw test USDC.
          </p>
          <a href="/shop">Start a test purchase →</a>
        </section>
      </main>
      <footer className="foot">
        <span>NOVAKEYS · Troia demo</span>
        <span>Stellar Pro Hackathon · Testnet preview</span>
      </footer>
    </div>
  );
}
