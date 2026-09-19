import { useRef, useState } from 'react';
import './landing.css';
const steps = [
  [
    'Download & extract',
    'Download the ZIP. On Mac, double-click it. On Windows, right-click and choose Extract All.',
  ],
  [
    'Open Chrome Extensions',
    'Paste chrome://extensions into your address bar. Turn on Developer mode in the top right.',
  ],
  [
    'Load the folder',
    'Click Load unpacked. Select the extracted troia-testnet folder containing manifest.json, not the ZIP.',
  ],
  [
    'You’re ready',
    'Keep the folder on your computer. Open the demo store and choose Pay with crypto → Stellar at checkout.',
  ],
];
export default function Landing() {
  const video = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="troia-site">
      <header className="site-nav">
        <a className="brand" href="/">
          <img src="/brand/troia-logo.png" alt="" />
          TROIA
        </a>
        <nav aria-label="Main navigation">
          <a href="#experience">The extension</a>
          <a href="#install">Installation</a>
          <a href="https://troia-demo-store.vercel.app">Demo store ↗</a>
        </nav>
        <a className="button compact" href="#install">
          Get Troia <span>↗</span>
        </a>
      </header>
      <main>
        <section className="intro section-width">
          <div className="intro-copy">
            <div className="overline">
              <i /> THE CHROME EXTENSION FOR STELLAR CHECKOUTS
            </div>
            <h1>
              Your Troy card.
              <br />A world of
              <br />
              <em>possibilities.</em>
            </h1>
            <p>
              Pay at supported Stellar checkouts with the card you already know. Troia takes care of
              the connection, right in your browser.
            </p>
            <div className="actions">
              <a className="button" href="#install">
                Get the extension <span>↗</span>
              </a>
              <a
                className="watch-link"
                href="#install"
                onClick={() => {
                  void video.current?.play().catch(() => undefined);
                }}
              >
                ▷ Watch installation
              </a>
            </div>
            <div className="fine">
              Desktop Chrome <span>·</span> Testnet preview <span>·</span> No real charges
            </div>
          </div>
          <div className="extension-stage">
            <div className="stage-top">
              <span>DESIGNED TO STAY WITH YOU</span>
              <span>01 / TROIA</span>
            </div>
            <div className="stage-line" />
            <img
              className="real-popup"
              src="/media/extension-popup.png"
              alt="Actual Troia extension: Troy card payments, manual payment and bank transfers"
            />
            <div className="stage-bottom">
              <span>YOUR BROWSER. YOUR PAYMENT.</span>
              <span>↓</span>
            </div>
          </div>
        </section>
        <div className="brand-rail section-width">
          <span>A FAMILIAR WAY TO PAY</span>
          <b>Troy card</b>
          <span>→</span>
          <b>Troia extension</b>
          <span>→</span>
          <b>Stellar Testnet</b>
        </div>
        <section className="experience section-width" id="experience">
          <div className="section-heading">
            <div>
              <div className="overline">01 / THE EXPERIENCE</div>
              <h2>
                At checkout.
                <br />
                <em>Right where you need it.</em>
              </h2>
            </div>
            <p>
              No new shopping habits. Just an extension that brings your Troy card to supported
              crypto checkouts.
            </p>
          </div>
          <div className="experience-grid">
            {[
              [
                '01',
                'Choose your purchase.',
                'Add an item at the demo store. Select Pay with crypto, then Stellar.',
              ],
              [
                '02',
                'Let Troia step in.',
                'Use the Troia payment banner and enter a sandbox Troy card in the hosted payment form.',
              ],
              [
                '03',
                'See it settle.',
                'The merchant receives test USDC. Follow the payment and open the onchain receipt.',
              ],
            ].map(([n, title, description]) => (
              <article key={n}>
                <span>{n}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="install" id="install">
          <div className="section-width">
            <div className="section-heading">
              <div>
                <div className="overline">02 / INSTALLATION</div>
                <h2>
                  See it. Follow it.
                  <br />
                  <em>You’re in.</em>
                </h2>
              </div>
              <p>
                A 40-second guide using real Chrome screenshots.
                <br />
                Pause whenever you need to.
              </p>
            </div>
            <div className="install-grid">
              <div>
                <div className="video-frame">
                  <div className="video-label">
                    <span>TROIA / QUICK SETUP</span>
                    <span>00:40</span>
                  </div>
                  <video
                    ref={video}
                    controls
                    playsInline
                    preload="none"
                    poster="/media/install-poster.jpg"
                    aria-label="Troia Chrome extension installation guide"
                  >
                    <source src="/media/troia-install.mp4" type="video/mp4" />
                    <track
                      kind="captions"
                      src="/media/install-en.vtt"
                      srcLang="en"
                      label="English"
                      default
                    />
                    <track
                      kind="captions"
                      src="/media/install-tr.vtt"
                      srcLang="tr"
                      label="Türkçe"
                    />
                    Follow the installation steps next to this video.
                  </video>
                  <div className="video-foot">
                    <span>Real Chrome screenshots · No sound required</span>
                    <a href="/media/troia-install.mp4" download>
                      Save video ↓
                    </a>
                  </div>
                </div>
                <div className="download-row">
                  <a className="button gold" href="/downloads/troia-testnet.zip" download>
                    Download Troia ZIP <span>↓</span>
                  </a>
                  <span>
                    Unzip first.
                    <br />
                    Select the folder, not the ZIP.
                  </span>
                </div>
              </div>
              <ol className="install-steps">
                {steps.map(([title, description], i) => (
                  <li key={title}>
                    <span>0{i + 1}</span>
                    <div>
                      <h3>{title}</h3>
                      <p>{description}</p>
                      {i === 1 && (
                        <button
                          className="copy-url"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText('chrome://extensions')
                              .then(() => setCopied(true))
                              .catch(() => setCopied(false));
                          }}
                        >
                          {copied ? 'Copied ✓' : 'Copy chrome://extensions'} <span>⧉</span>
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <details className="install-help">
              <summary>Installation help & requirements</summary>
              <p>
                Use desktop Chrome. This testnet preview is not in the Chrome Web Store yet and
                requires Developer mode. If Chrome reports a missing manifest, select the inner
                folder containing manifest.json. To pin Troia, open Chrome’s Extensions puzzle icon
                and click the pin next to Troia. For bank transfers only, install Freighter and
                select Testnet. Card checkout does not require a wallet.
              </p>
            </details>
          </div>
        </section>
        <section className="bank section-width">
          <div>
            <div className="overline">03 / ALSO IN YOUR EXTENSION</div>
            <h2>
              Lira in.
              <br />
              <em>USDC out.</em>
            </h2>
            <p>
              Explore simulated bank deposits and withdrawals through TR Mock Anchor. Connect
              Freighter from Troia’s Bank transfers panel.
            </p>
          </div>
          <div className="bank-diagram">
            <span>
              TRY<small>SIMULATED BANK TRANSFER</small>
            </span>
            <b>↔</b>
            <span>
              USDC<small>STELLAR TESTNET</small>
            </span>
          </div>
          <p className="service-note">
            <b>Anchor service notice</b> Bank transfers are currently delayed. Card checkout uses a
            separately funded pool and remains a separate flow.
          </p>
        </section>
        <section className="final-cta section-width">
          <div>
            <div className="overline">THE NEXT STEP</div>
            <h2>Take Troia shopping.</h2>
          </div>
          <a className="button" href="https://troia-demo-store.vercel.app">
            Open the demo store <span>↗</span>
          </a>
        </section>
      </main>
      <footer className="site-footer section-width">
        <a className="brand" href="/">
          <img src="/brand/troia-logo.png" alt="" />
          TROIA
        </a>
        <span>Built for Stellar Pro Hackathon.</span>
        <span>Testnet only. No real payments or goods.</span>
      </footer>
    </div>
  );
}
