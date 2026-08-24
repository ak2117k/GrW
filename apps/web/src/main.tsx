import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './services/query-client';
import App from './App';
import './app.css';
import { initTheme } from './stores/theme-store';

// Apply the persisted theme to <html> before first paint (no theme flash).
initTheme();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#1a1a2e',
              color: '#f1f5f9',
              border: '1px solid #334155',
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
