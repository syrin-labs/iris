import './reticle-render-setup.js'; // MUST be first — installs the render meter before react-dom loads
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { queryClient } from './lib/query-client.js';
import { installReticle } from './reticle-dev.js';
import { installRegressions } from './reticle-regress.js';
import { installBugInjector } from './reticle-bug-injector.js';
import { installNoSource, installOpaqueShell } from './reticle-opaque.js';
import { installAmbientTraffic } from './reticle-ambient.js';

// Dev-only: wire the proof layer into this running dashboard (presenter + capabilities +
// store). Tree-shaken out of production builds.
if (import.meta.env.DEV) {
  // ?no-hud skips Reticle's SDK + presenter entirely — the app a non-Reticle tool (e.g. Playwright)
  // would actually face, with NO HUD overlay to fight. The bug injector still runs, so the same bug
  // is present; only Reticle's own instrumentation is absent. (Reticle-MCP uses the normal build.)
  const noHud = new URLSearchParams(window.location.search).has('no-hud');
  // The injector goes FIRST so its fetch/history patches sit UNDERNEATH Reticle's observers.
  // Reticle patches window.fetch on connect; whichever installs last is outermost. With Reticle first,
  // the injector wrapped it, so a rewritten response (a swallowed 500, a wrong content-type) was
  // applied AFTER Reticle had already recorded the real 200 — the fault was invisible to the very
  // tool meant to catch it, and three net bugs silently never fired.
  installBugInjector(); // no-op unless ?reticle-bug=<ids> — injects UI bugs for the benchmark
  if (!noHud) installReticle(); // presenter (glow+cursor+HUD) + capabilities + store registration
  installRegressions(); // no-op unless ?reticle-break=<testids> — controlled regression knob for benchmarks
  installOpaqueShell(); // no-op unless ?opaque=<1|2> — strips testids (+role/aria) for the opaque-shell metric
  installNoSource(); // no-op unless ?nosource=1 — the file:line ablation
  installAmbientTraffic(); // no-op unless ?ambient=<ids> — traffic the user did NOT cause (negative cases)
}

const rootElement = document.getElementById('root');
if (null === rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
