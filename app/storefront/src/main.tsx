import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

const App = lazy(() => import('./App.tsx'));
import Landing from './anchor/Landing';
const WalletApproval = lazy(() => import('./anchor/WalletApproval'));
const path = window.location.pathname.replace(/\/$/, '') || '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p>Loading Troia…</p>}>
      {path === '/store' ? <App /> : path === '/wallet' ? <WalletApproval /> : <Landing />}
    </Suspense>
  </StrictMode>,
);
