/**
 * Discovery against a REAL React tree, not a hand-built fiber.
 *
 * The first pass of these tests used fibers we constructed ourselves, which proved the classifier and
 * the walk agreed with our own idea of a fiber — and proved nothing about React's. The battery then
 * failed on a Next app whose page rendered nothing but an error overlay, on a change every unit test
 * passed. A real `createRoot` render is the smallest thing that could have caught it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, createContext, createElement, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerStore, storeNames, tanstackQueryStore, unregisterStore } from '@reticlehq/browser';
import { autoRegisterStores, discoverStores, resetAutoStores } from './auto-stores.js';

function reduxLikeStore(): { getState: () => unknown; subscribe: () => () => void } {
  let state = { count: 0 };
  return {
    getState: () => state,
    subscribe: () => () => {
      state = { count: state.count };
    },
  };
}

describe('discovery over a real React render', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    resetAutoStores();
    for (const name of storeNames()) unregisterStore(name);
  });

  it('finds a store passed through a real context provider', () => {
    const StoreContext = createContext<unknown>(null);
    StoreContext.displayName = 'ReactRedux';
    const store = reduxLikeStore();

    function App(): ReactNode {
      return createElement(
        StoreContext.Provider,
        { value: { store } },
        createElement('button', { 'data-testid': 'pay' }, 'Pay'),
      );
    }

    const root = createRoot(host);
    act(() => root.render(createElement(App)));

    const found = discoverStores(document);
    expect(found.map((s) => s.key)).toEqual(['redux']);
    expect(found[0]?.store.getState()).toEqual({ count: 0 });
  });

  it('leaves an app with no store alone, and reports nothing', () => {
    function Plain(): ReactNode {
      return createElement('p', null, 'nothing to see');
    }
    const root = createRoot(host);
    act(() => root.render(createElement(Plain)));

    expect(discoverStores(document)).toEqual([]);
    expect(autoRegisterStores(document)).toEqual([]);
  });

  /**
   * The failure the battery actually hit: discovery runs inside React's commit callback, so anything
   * it does that re-enters React takes the host app's render with it. The app must still render, and
   * must still be interactive, after discovery has run over it.
   */
  it('does not disturb the app it just walked', () => {
    const StoreContext = createContext<unknown>(null);
    const store = reduxLikeStore();

    function Counter(): ReactNode {
      const [n, setN] = useState(0);
      return createElement(
        StoreContext.Provider,
        { value: { store } },
        createElement(
          'button',
          { 'data-testid': 'inc', onClick: () => setN(n + 1) },
          `count ${String(n)}`,
        ),
      );
    }

    const root = createRoot(host);
    act(() => root.render(createElement(Counter)));
    act(() => {
      autoRegisterStores(document);
    });

    const button = document.querySelector('[data-testid="inc"]');
    expect(button?.textContent).toBe('count 0');
    act(() => {
      (button as HTMLButtonElement | null)?.click();
    });
    expect(document.querySelector('[data-testid="inc"]')?.textContent).toBe('count 1');
  });
});

/**
 * The bench-app shape, which every gate passed and driving caught.
 *
 * bench-app renders a real `QueryClientProvider` AND registers the same client itself with
 * `registerStore('queries', tanstackQueryStore(client))`. Discovery found the client in the fiber
 * tree, saw no store named `query`, and added one — so `reticle_state` returned the same cache twice,
 * under two names, in every read.
 */
describe('a store the app already registered is not registered again', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAutoStores();
    for (const name of storeNames()) unregisterStore(name);
  });

  function fakeQueryClient(): {
    getQueryCache: () => { getAll: () => []; subscribe: () => () => void };
  } {
    const cache = { getAll: (): [] => [], subscribe: () => () => {} };
    return { getQueryCache: () => cache };
  }

  function mountWithProvider(client: unknown): void {
    const QueryContext = createContext<unknown>(null);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(QueryContext.Provider, { value: client }, createElement('main', null, 'app')),
      ),
    );
  }

  it('leaves an adapter-wrapped client the app wired alone', () => {
    const client = fakeQueryClient();
    registerStore('queries', tanstackQueryStore(client));
    mountWithProvider(client);

    expect(autoRegisterStores(document)).toEqual([]);
    expect(storeNames()).toEqual(['queries']);
  });

  it('still registers a DIFFERENT client the app never wired', () => {
    registerStore('queries', tanstackQueryStore(fakeQueryClient()));
    mountWithProvider(fakeQueryClient());

    expect(autoRegisterStores(document)).toEqual(['query']);
  });

  /** The other order: discovery lands first, the app registers the same client afterwards. */
  it('gives up its own name when the app registers the same client later', () => {
    const client = fakeQueryClient();
    mountWithProvider(client);
    expect(autoRegisterStores(document)).toEqual(['query']);

    registerStore('queries', tanstackQueryStore(client));
    autoRegisterStores(document);

    expect(storeNames()).toEqual(['queries']);
  });
});
