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
import './anchor.css';

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
      <small>{copied ? 'Copied' : 'Copy'}</small>
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
        e instanceof Error
          ? e.message
          : 'Could not complete this step. Please refresh the transfer status.',
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
            setNotice('Live updates paused. Refresh to retry; pending does not mean failed.');
        })
        .finally(() => {
          running = false;
        });
    }, 8000);
    return () => clearInterval(t);
  }, [client, active?.id]);
  const connect = () =>
    run('Connecting wallet', async () => {
      const access = await walletRequest({ action: 'connect' });
      if (!access.address) throw new Error('Wallet connection was not approved.');
      const address = access.address;
      const c = new AnchorClient(address, async (xdr) => {
        const result = await walletRequest({ action: 'sign', address, xdr });
        if (result.address !== address || !result.signedTxXdr)
          throw new Error('Wallet signature does not match the connected account.');
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
    run('Getting your quote', async () => {
      if (!client) return;
      setQuote(await client.quote(direction, amount));
    });
  const begin = () =>
    run('Creating transfer', async () => {
      if (!client || !quote) return;
      setUncertain(true);
      const i = await client.start(direction, quote);
      setInstructions(i);
      setQuote(undefined);
      setUncertain(false);
      await refresh(client, i.id);
    });
  const send = () =>
    run('Approve withdrawal in Freighter', async () => {
      if (!client || !active || !instructions || !active.amount_in) return;
      // Persist BEFORE broadcast. A lost response must never turn into a second payment.
      const next = {
        ...submitted,
        [active.id]: 'Submission pending. Check history before sending again.',
      };
      const tx = await client.payWithdrawal(instructions, active.amount_in, () => {
        localStorage.setItem(`troia:anchor:sent:${client.account}`, JSON.stringify(next));
        setSubmitted(next);
      });
      next[active.id] = tx.hash;
      localStorage.setItem(`troia:anchor:sent:${client.account}`, JSON.stringify(next));
      setSubmitted({ ...next });
      setNotice('USDC submitted. Waiting for the anchor to confirm the bank simulation.');
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
          troia<span>®</span>
        </a>
        <nav>
          <a href="../wizard/index.html">Card payment ↗</a>
          <span className="network-pill">● Stellar Testnet</span>
          {client ? (
            <button disabled={!!busy} onClick={disconnect}>
              {short(client.account)} · Disconnect
            </button>
          ) : (
            <button className="primary" disabled={!!busy} onClick={connect}>
              Connect Freighter ↗
            </button>
          )}
        </nav>
      </header>
      <main className="anchor-main">
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">BANK TRANSFERS</div>
            <h1>Add or withdraw funds.</h1>
            <p>Manage testnet bank transfers from your Troia panel.</p>
          </div>
          <div className="wallet-balance">
            <small>YOUR TESTNET USDC</small>
            <strong>
              {balance === '—'
                ? '—'
                : Number(balance).toLocaleString('en-US', { maximumFractionDigits: 7 })}
            </strong>
            <span>{client ? short(client.account) : 'Connect your wallet to begin'}</span>
          </div>
        </div>
        <div className="sandbox-note">
          <b>Sandbox</b> Bank deposits and payouts are simulated. USDC transfers run on Stellar
          testnet. Use test funds only.
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
              The anchor is still processing this transfer. Its service may be delayed. Do not send
              another payment. Refresh this transfer or reopen it from history.
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
                ↙ Add Turkish lira
              </button>
              <button
                disabled={!!busy}
                aria-pressed={!deposit}
                onClick={() => changeDirection('withdraw')}
              >
                ↗ Withdraw to bank
              </button>
            </div>
            {!client ? (
              <div className="connect-empty">
                <div className="circle-arrow">↔</div>
                <h2>Your wallet is the starting point.</h2>
                <p>
                  Connect Freighter on Testnet. You approve the login and every onchain transfer in
                  your wallet.
                </p>
                <button className="primary" disabled={!!busy} onClick={connect}>
                  Connect wallet ↗
                </button>
                <a href="https://www.freighter.app/" target="_blank" rel="noreferrer">
                  Get Freighter
                </a>
              </div>
            ) : !ready ? (
              <div className="connect-empty">
                <h2>Prepare your test wallet.</h2>
                <p>
                  Request free test XLM if needed, then approve the USDC trustline. This lets the
                  anchor deliver USDC directly to you.
                </p>
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run('Preparing testnet wallet', async () => {
                      await client.prepareWallet();
                      await refresh(client);
                    })
                  }
                >
                  Prepare wallet ↗
                </button>
              </div>
            ) : active ? (
              <div className="transfer-body">
                <div className="eyebrow">{active.kind.toUpperCase()}</div>
                <h2>{settled ? 'Transfer completed.' : statusLabel(active.status)}</h2>
                <p>
                  {active.message ||
                    (settled
                      ? 'The anchor has confirmed this transfer.'
                      : 'Your transfer is tracked below. Refreshing this page does not cancel it.')}
                </p>
                <div className="receipt">
                  <div>
                    <span>You send</span>
                    <b>
                      {active.amount_in ?? '—'} {deposit ? 'TRY' : 'USDC'}
                    </b>
                  </div>
                  <div>
                    <span>You receive</span>
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
                      run('Simulating bank deposit', async () => {
                        await client.simulate(active.id, active.amount_in!);
                        await refresh(client, active.id);
                      })
                    }
                  >
                    Simulate bank transfer · Test only
                  </button>
                )}
                {!deposit &&
                  active.status === 'pending_user_transfer_start' &&
                  !submitted[active.id] &&
                  instructions?.account_id && (
                    <>
                      <label className="instruction">
                        Anchor destination
                        <Copy value={instructions.account_id} />
                      </label>
                      <p>Memo ID: {instructions.memo}</p>
                      <button className="primary full" disabled={!!busy} onClick={send}>
                        Approve USDC transfer ↗
                      </button>
                    </>
                  )}
                {submitted[active.id] && (
                  <p className="notice">
                    Transfer submitted or awaiting verification. Do not send it again.{' '}
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
                      View on Stellar ↗
                    </a>
                  )}
                {trustedLink(active.more_info_url ?? instructions?.more_info_url) && (
                  <a
                    className="text-link"
                    href={trustedLink(active.more_info_url ?? instructions?.more_info_url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Anchor instructions / recovery ↗
                  </a>
                )}
                <button
                  className="secondary full"
                  disabled={!!busy}
                  onClick={() => run('Refreshing transfer', () => refresh(client, active.id))}
                >
                  Refresh status
                </button>
                <button
                  className="text-link"
                  disabled={!!busy}
                  onClick={() => {
                    setActive(undefined);
                    setInstructions(undefined);
                  }}
                >
                  Back to new transfer
                </button>
              </div>
            ) : (
              <div className="transfer-body">
                <label htmlFor="amount">{deposit ? 'You deposit' : 'You withdraw'}</label>
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
                    ? 'Bank transfer → your Stellar wallet'
                    : 'Your Stellar wallet → simulated bank payout'}
                </p>
                {quote && (
                  <div className="receipt">
                    <div>
                      <span>You receive</span>
                      <strong>
                        {quote.buy_amount} {deposit ? 'USDC' : 'TRY'}
                      </strong>
                    </div>
                    <div>
                      <span>Anchor fee (included)</span>
                      <b>
                        {quote.fee?.total ?? '—'} {deposit ? 'TRY' : 'USDC'}
                      </b>
                    </div>
                    <div>
                      <span>Quote valid until</span>
                      <b>{new Date(quote.expires_at).toLocaleTimeString()}</b>
                    </div>
                    <p>
                      {quoteIsLive(quote, now)
                        ? 'This quote belongs to your connected account.'
                        : 'Quote expired. Request a fresh quote.'}
                    </p>
                  </div>
                )}
                {uncertain ? (
                  <div className="notice">
                    The previous request may have reached the anchor. Refresh history and open that
                    transfer before creating another.
                    <button onClick={() => run('Checking history', () => refresh(client))}>
                      Refresh history
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary full"
                    disabled={!!busy}
                    onClick={quote && quoteIsLive(quote, now) ? begin : requestQuote}
                  >
                    {quote && quoteIsLive(quote, now)
                      ? 'Confirm quote & continue →'
                      : 'Get exchange quote →'}
                  </button>
                )}
                <p className="fine-print">
                  {deposit
                    ? 'Next: review the IBAN and transfer reference.'
                    : 'The mock anchor uses a sandbox bank account. No real IBAN is required.'}{' '}
                  Network fees are paid in test XLM.
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
            <div className="eyebrow">HOW IT MOVES</div>
            <h2>{deposit ? 'From lira to your wallet.' : 'From your wallet to lira.'}</h2>
            {(deposit
              ? [
                  ['Review your quote', 'Know the rate, fee and USDC amount.'],
                  ['Simulate the bank transfer', 'An IBAN and reference identify your deposit.'],
                  ['Receive testnet USDC', 'The anchor sends funds to your wallet.'],
                ]
              : [
                  ['Review your quote', 'See the lira amount before you proceed.'],
                  ['Approve in your wallet', 'The exact destination and memo are included.'],
                  ['Track the bank payout', 'The anchor confirms the simulated payment.'],
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
              <small>POWERED BY</small>
              <b>TR Mock Anchor ↗</b>
              <p>SEP standards on Stellar testnet. Independent sandbox; not a BiLira service.</p>
            </div>
          </aside>
        </div>
        <section className="history-panel">
          <div className="history-title">
            <h2>Transfer activity</h2>
            <button
              disabled={!client || !!busy}
              onClick={() => client && run('Refreshing history', () => refresh(client, active?.id))}
            >
              Refresh ↻
            </button>
          </div>
          {!client ? (
            <p>Connect your wallet to see its transfers.</p>
          ) : history.length === 0 ? (
            <p>No transfers yet. Your first transfer will appear here.</p>
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
                  <b>{t.kind.startsWith('deposit') ? 'Add lira' : 'Withdraw to bank'}</b>
                  <small>{t.started_at ? new Date(t.started_at).toLocaleString() : t.id}</small>
                </span>
                <span className="history-amount">
                  {t.amount_in} {t.kind.startsWith('deposit') ? 'TRY' : 'USDC'}
                </span>
                <span className="status" data-complete={t.status === 'completed'}>
                  {statusLabel(t.status)}
                </span>
                <span>↗</span>
              </button>
            ))
          )}
        </section>
      </main>
      <footer>
        Troia · Built on Stellar<span>Card settlement pool is managed and funded separately.</span>
      </footer>
    </div>
  );
}
