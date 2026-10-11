import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/toast';
import { LiveProvider } from './lib/live';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </LiveProvider>
  </StrictMode>,
);
