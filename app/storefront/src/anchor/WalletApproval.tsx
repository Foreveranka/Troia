import { useEffect, useState } from 'react';
import { getAddress, getNetwork, requestAccess, signTransaction } from '@stellar/freighter-api';
import { ANCHOR } from './config';
import './anchor.css';
type Request = { action: 'connect' | 'sign'; address?: string; xdr?: string };
export default function WalletApproval() {
  const [request, setRequest] = useState<Request>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.type !== 'TROIA_WALLET_REQUEST' ||
        event.data.id !== location.hash.slice(1)
      )
        return;
      const r = event.data.request;
      if (r?.action !== 'connect' && r?.action !== 'sign') return;
      if (
        r.action === 'sign' &&
        (typeof r.xdr !== 'string' || r.xdr.length > 100000 || typeof r.address !== 'string')
      )
        return;
      setRequest((previous) => previous ?? r);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const respond = (result: object) =>
    window.postMessage(
      { type: 'TROIA_WALLET_RESULT', id: location.hash.slice(1), result },
      location.origin,
    );
  async function approve() {
    if (!request || busy) return;
    setBusy(true);
    setError('');
    try {
      if (request.action === 'connect') {
        const result = await requestAccess();
        if (result.error || !result.address)
          throw new Error('Freighter connection was not approved.');
        const network = await getNetwork();
        if (network.networkPassphrase !== ANCHOR.passphrase)
          throw new Error('Select Testnet in Freighter, then retry.');
        respond({ address: result.address });
      } else {
        const account = await getAddress();
        const network = await getNetwork();
        if (account.address !== request.address)
          throw new Error('Select the connected account in Freighter.');
        if (network.networkPassphrase !== ANCHOR.passphrase)
          throw new Error('Select Testnet in Freighter.');
        const signed = await signTransaction(request.xdr!, {
          address: request.address,
          networkPassphrase: ANCHOR.passphrase,
        });
        if (signed.error || !signed.signedTxXdr || signed.signerAddress !== request.address)
          throw new Error('Signature was not approved by the connected account.');
        respond({ address: signed.signerAddress, signedTxXdr: signed.signedTxXdr });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet approval failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="anchor-shell">
      <main className="landing" style={{ maxWidth: 660 }}>
        <a className="troia-wordmark" href="/">
          troia
        </a>
        <div className="eyebrow" style={{ marginTop: 32 }}>
          WALLET APPROVAL · TESTNET
        </div>
        <h2 style={{ marginTop: 16 }}>
          {request?.action === 'sign' ? 'Review in Freighter.' : 'Connect your wallet.'}
        </h2>
        <p>
          This tab handles wallet approval for the Troia extension. Your transfer stays in the side
          panel. Troia never asks for your secret key.
        </p>
        {request?.address && <p style={{ overflowWrap: 'anywhere' }}>{request.address}</p>}
        {error && (
          <div role="alert" className="error-note">
            {error}
          </div>
        )}
        {request ? (
          <div className="landing-actions">
            <button className="primary" disabled={busy} onClick={() => void approve()}>
              {busy ? 'Waiting for Freighter…' : 'Continue in Freighter ↗'}
            </button>
            <button
              disabled={busy}
              onClick={() => respond({ error: 'Wallet approval cancelled.' })}
            >
              Cancel
            </button>
          </div>
        ) : (
          <p>Waiting for the Troia extension. Open Bank transfers from the extension to begin.</p>
        )}
      </main>
    </div>
  );
}
