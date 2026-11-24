import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DevHarness } from './DevHarness';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <DevHarness />
    </StrictMode>,
  );
}
