import { describe, it, expect, beforeEach } from 'vitest';
import { storeNames, registerStore, unregisterStore } from '@reticlehq/browser';
import {
  autoRegisterStores,
  classifyProviderValue,
  discoverStores,
  resetAutoStores,
  AUTO_STORE_KEY,
} from './auto-stores.js';

const PROVIDER = Symbol.for('react.provider');
const CONTEXT = Symbol.for('react.context');

interface FakeFiber {
  return: FakeFiber | null;
  child?: FakeFiber | null;
  sibling?: FakeFiber | null;
  type?: unknown;
  memoizedProps?: unknown;
}

/** A React 18-shaped provider fiber: `type.$$typeof` is react.provider, context under `_context`. */
function providerFiber(value: unknown, displayName?: string): FakeFiber {
  return {
    return: null,
    type: { $$typeof: PROVIDER, _context: { displayName } },
    memoizedProps: { value },
  };
}

/** React 19 renders the context object itself as the fiber type. */
function context19Fiber(value: unknown, displayName?: string): FakeFiber {
  return {
    return: null,
    type: { $$typeof: CONTEXT, displayName },
    memoizedProps: { value },
  };
}

function reduxContextValue(): { store: { getState: () => unknown; subscribe: () => () => void } } {
  return { store: { getState: () => ({ cart: 2 }), subscribe: () => () => {} } };
}

function queryClient(): { getQueryCache: () => unknown } {
  return {
    getQueryCache: () => ({
      getAll: () => [],
      subscribe: () => () => {},
    }),
  };
}

describe('classifyProviderValue', () => {
  it('recognises a react-redux context value by its nested store', () => {
    const found = classifyProviderValue(reduxContextValue(), undefined);
    expect(found?.key).toBe(AUTO_STORE_KEY.REDUX);
    expect(found?.store.getState()).toEqual({ cart: 2 });
  });

  it('recognises a TanStack QueryClient by its query cache', () => {
    const found = classifyProviderValue(queryClient(), undefined);
    expect(found?.key).toBe(AUTO_STORE_KEY.QUERY);
  });

  it('recognises a bare {getState, subscribe} value and names it from the context', () => {
    const value = { getState: () => 1, subscribe: () => () => {} };
    expect(classifyProviderValue(value, 'CheckoutStore')?.key).toBe('checkoutstore');
  });

  it('falls back to a generic name when the context is anonymous', () => {
    const value = { getState: () => 1, subscribe: () => () => {} };
    expect(classifyProviderValue(value, undefined)?.key).toBe(AUTO_STORE_KEY.STORE);
  });

  it('ignores an ordinary context value', () => {
    expect(classifyProviderValue({ theme: 'dark' }, 'Theme')).toBeNull();
    expect(classifyProviderValue(null, undefined)).toBeNull();
    expect(classifyProviderValue(undefined, undefined)).toBeNull();
  });

  it('ignores a value that only half-satisfies the store shape', () => {
    expect(classifyProviderValue({ subscribe: () => () => {} }, undefined)).toBeNull();
  });
});

describe('discoverStores', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAutoStores();
  });

  /** Attach a fiber tree to the document the way React does, via a host element's fiber key. */
  function mount(leaf: FakeFiber): HTMLElement {
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = leaf;
    document.body.appendChild(el);
    return el;
  }

  it('finds a provider above the element React stamped', () => {
    const provider = providerFiber(reduxContextValue());
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    mount(host);

    expect(discoverStores(document).map((s) => s.key)).toEqual([AUTO_STORE_KEY.REDUX]);
  });

  it('finds providers below the stamped element by walking the whole tree', () => {
    const root: FakeFiber = { return: null, type: 'div' };
    const provider = providerFiber(queryClient());
    provider.return = root;
    root.child = provider;
    mount(root);

    expect(discoverStores(document).map((s) => s.key)).toEqual([AUTO_STORE_KEY.QUERY]);
  });

  it('finds a React 19 provider, where the fiber type is the context object itself', () => {
    const provider = context19Fiber(reduxContextValue(), 'ReactRedux');
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    mount(host);

    expect(discoverStores(document).map((s) => s.key)).toEqual([AUTO_STORE_KEY.REDUX]);
  });

  it('returns nothing when the page is not a React app', () => {
    document.body.appendChild(document.createElement('div'));
    expect(discoverStores(document)).toEqual([]);
  });

  it('gives two same-named stores distinct keys', () => {
    const root: FakeFiber = { return: null, type: 'div' };
    const first = providerFiber({ getState: () => 1, subscribe: () => () => {} });
    const second = providerFiber({ getState: () => 2, subscribe: () => () => {} });
    first.return = root;
    second.return = root;
    root.child = first;
    first.sibling = second;
    mount(root);

    expect(discoverStores(document).map((s) => s.key)).toEqual([
      AUTO_STORE_KEY.STORE,
      `${AUTO_STORE_KEY.STORE}2`,
    ]);
  });
});

describe('autoRegisterStores', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAutoStores();
    for (const name of storeNames()) unregisterStore(name);
  });

  it('registers what it discovered so reticle_state can read it', () => {
    const provider = providerFiber(reduxContextValue());
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = host;
    document.body.appendChild(el);

    expect(autoRegisterStores(document)).toEqual([AUTO_STORE_KEY.REDUX]);
    expect(storeNames()).toContain(AUTO_STORE_KEY.REDUX);
  });

  it('never overwrites a store the app registered itself', () => {
    registerStore(AUTO_STORE_KEY.REDUX, () => 'the app value');
    const provider = providerFiber(reduxContextValue());
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = host;
    document.body.appendChild(el);

    expect(autoRegisterStores(document)).toEqual([]);
  });

  it('is idempotent across repeated commits', () => {
    const provider = providerFiber(reduxContextValue());
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = host;
    document.body.appendChild(el);

    expect(autoRegisterStores(document)).toEqual([AUTO_STORE_KEY.REDUX]);
    expect(autoRegisterStores(document)).toEqual([]);
  });

  it('never throws on a hostile fiber tree', () => {
    const el = document.createElement('div');
    const hostile = {
      return: null,
      get child(): never {
        throw new Error('nope');
      },
    };
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = hostile;
    document.body.appendChild(el);

    expect(() => autoRegisterStores(document)).not.toThrow();
  });
});

describe('autoRegisterStores does not duplicate a store that is already readable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAutoStores();
    for (const name of storeNames()) unregisterStore(name);
  });

  it('skips a provider holding the same store init already wired under its own name', () => {
    // The SAME object, which is what "already registered" means. Two distinct stores that happen to
    // return equal state are two stores, and listing both is correct.
    const shared = { getState: () => ({ cart: ['a'] }), subscribe: () => () => {} };
    registerStore('app', shared);

    const provider = providerFiber({ store: shared });
    const host: FakeFiber = { return: provider, type: 'div' };
    provider.child = host;
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['__reactFiber$auto'] = host;
    document.body.appendChild(el);

    expect(autoRegisterStores(document)).toEqual([]);
    expect(storeNames()).toEqual(['app']);
  });
});
