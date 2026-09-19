import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import Welcome from './Welcome.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.pathname === '/shop' ? <App /> : <Welcome />}</StrictMode>,
);
