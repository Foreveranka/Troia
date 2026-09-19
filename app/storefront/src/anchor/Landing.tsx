import './anchor.css';
export default function Landing() {
  return (
    <div className="anchor-shell">
      <header className="anchor-nav">
        <a className="troia-wordmark" href="/">
          troia<span>®</span>
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="https://troia-demo-store.vercel.app">Demo store</a>
          <a className="primary-link" href="#install">
            Get the extension ↗
          </a>
        </nav>
      </header>
      <main className="landing">
        <div className="eyebrow">
          <i /> CHROME EXTENSION · STELLAR TESTNET
        </div>
        <h1>
          Your browser.
          <br />
          <em>Your way to pay.</em>
        </h1>
        <p>
          Troia brings Troy card payments to supported Stellar checkouts. Manage testnet bank
          deposits and withdrawals from the extension’s side panel.
        </p>
        <div className="landing-actions">
          <a className="primary-link" href="#install">
            Install Troia ↗
          </a>
          <a href="https://troia-demo-store.vercel.app">Try the demo store →</a>
        </div>
        <div className="sandbox-note">
          <b>Demo status · 20 Sep</b> Card checkout is available. Bank transfers may remain pending
          while the shared mock anchor resolves its current service incident.
        </div>
        <section className="money-path" id="how">
          <div>
            <small>01 · SHOP</small>
            <strong>Open checkout</strong>
            <span>Troia detects a supported Stellar payment.</span>
          </div>
          <b>→</b>
          <div>
            <small>02 · PAY</small>
            <strong>Use your Troy card</strong>
            <span>Complete the hosted sandbox card form.</span>
          </div>
          <b>→</b>
          <div>
            <small>03 · TRACK</small>
            <strong>Stay in your browser</strong>
            <span>Follow payment status in Troia.</span>
          </div>
        </section>
        <section className="landing-details">
          <div>
            <span>BANK TRANSFERS IN YOUR SIDE PANEL</span>
            <h2>
              Lira in.
              <br />
              USDC out.
            </h2>
          </div>
          <p>
            Open Bank transfers in the extension, connect Freighter and review your quote. Deposits
            and payouts are bank simulations with real testnet USDC transfers. Card checkout and
            bank transfers use the same testnet USDC asset. The operator funds the payment pool
            manually; your bank transfer is a separate action.
          </p>
        </section>
        <section id="install" className="landing-details">
          <div>
            <span>INSTALL IN CHROME</span>
            <h2>Ready in a few clicks.</h2>
          </div>
          <div>
            <p>
              Download the testnet preview below. Chrome requires Developer mode for this unpacked
              preview; there is no Web Store listing yet.
            </p>
            <a className="primary-link" href="/downloads/troia-testnet.zip" download>
              Download Troia ZIP ↓
            </a>
            <ol>
              <li>Download and unzip Troia. Keep the extracted folder on your computer.</li>
              <li>
                Open <code>chrome://extensions</code> and enable Developer mode.
              </li>
              <li>
                Choose Load unpacked and select the extracted <code>troia-testnet</code> folder.
              </li>
              <li>Pin Troia. Choose Manual payment or Bank transfers.</li>
            </ol>
            <p>
              For bank transfers, install Freighter and select Testnet. Card checkout does not
              require a wallet.
            </p>
          </div>
        </section>
        <section className="landing-details" id="jury">
          <div>
            <span>STELLAR PRO HACKATHON</span>
            <h2>Try the whole journey.</h2>
          </div>
          <div>
            <p>
              Visit the separate demo store, add a product, and choose Stellar checkout. Troia opens
              the hosted iyzico sandbox card form and tracks the Soroban settlement.
            </p>
            <p>
              Then open Bank transfers in Troia to test TRY deposits and USDC withdrawals with TR
              Mock Anchor.
            </p>
            <a href="https://troia-demo-store.vercel.app" className="primary-link">
              Open jury demo →
            </a>
            <p>
              Testnet tokens have no monetary value. Sandbox bank transfers and product keys are
              simulated. This is not a production financial service.
            </p>
          </div>
        </section>
      </main>
      <footer>
        Troia · Chrome extension on Stellar<span>Testnet only. No real bank payments.</span>
      </footer>
    </div>
  );
}
