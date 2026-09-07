import { describe, expect, it } from 'vitest';
import { scanTestids, storeHints, scanStores, MAX_TESTIDS } from './capabilities.js';

/**
 * Every app came up with `hasCapabilities: false` and a `reticle_state` holding only
 * `__reticle_renders`, because `init` wired neither call. The state-truth read — the one thing that
 * shows what the app BELIEVES rather than what it rendered — was unavailable out of the box on all
 * six real apps. Testids are cheap to find; stores are named rather than guessed.
 */
describe('scanTestids', () => {
  it('finds the attribute forms people actually write', () => {
    const ids = scanTestids([
      '<button data-testid="pay">Pay</button>',
      "<a data-testid='nav-home' />",
      '<div data-testid={"cart-total"} />',
      '<input data-testid = "email" />',
    ]);
    expect(ids).toEqual(['pay', 'nav-home', 'cart-total', 'email']);
  });

  it('de-duplicates across files and preserves first-seen order', () => {
    expect(scanTestids(['a data-testid="x" b data-testid="y"', 'c data-testid="x"'])).toEqual([
      'x',
      'y',
    ]);
  });

  it('caps the list — this is a hint for an agent, not an inventory', () => {
    const many = Array.from({ length: MAX_TESTIDS + 25 }, (_, i) => `data-testid="id${String(i)}"`);
    expect(scanTestids([many.join(' ')]).length).toBe(MAX_TESTIDS);
  });

  it('finds a testid planted as a JS string, the form the install gate stamps', () => {
    // apps/e2e/install-gate.mjs writes this exact line so an empty scaffold still registers
    // something. If the scanner stops matching it, the gate's hasCapabilities check fails every
    // scaffold for a reason that is the stamp, not the install.
    expect(
      scanTestids([`export const RETICLE_INSTALL_PROBE = 'data-testid="reticle-install-probe"';`]),
    ).toEqual(['reticle-install-probe']);
  });
});

describe('storeHints', () => {
  it('names only the libraries the app actually depends on', () => {
    const hints = storeHints(new Set(['zustand', 'lodash']));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('zustand' in {} ? '' : 'registerStore');
    expect(hints[0]).toContain('useStore');
  });

  /**
   * TanStack Query and Redux hand their store to React through a context provider, so the React
   * adapter finds and registers them on the first commit. A hint for either would be asking the
   * reader to do work that is already done by the time they read it — and the notice attached to
   * that hint would then nag about it forever.
   */
  it('says nothing about the libraries the running app reveals on its own', () => {
    expect(storeHints(new Set(['@tanstack/react-query']))).toEqual([]);
    expect(storeHints(new Set(['redux']))).toEqual([]);
    expect(storeHints(new Set(['@reduxjs/toolkit']))).toEqual([]);
  });

  it('still hints the libraries nothing in the running app points at', () => {
    const hints = storeHints(new Set(['@tanstack/react-query', 'jotai', 'zustand']));
    expect(hints).toHaveLength(2);
    expect(hints.join(' ')).toContain('jotaiStore');
    expect(hints.join(' ')).toContain('useStore');
  });

  it('says nothing when the app has no store library we can read', () => {
    expect(storeHints(new Set(['react', 'vite']))).toEqual([]);
  });
});

/**
 * `storeHints` names the LIBRARY; that was never enough to write a working line, so the generated
 * module shipped its `registerStore` call commented out and `registerCapabilities({ stores: [] })`
 * registered nothing. Every app came up `hasCapabilities: false` on a file `init` had just reported
 * `✓` for — and the fix was left to a human who had to read the docs to make it.
 *
 * The store instance is findable in the same sources already scanned for testids: the declaration
 * form is regular (`export const useX = create(...)`), and it carries both the identifier and the
 * file to import it from. Found → a real import and a real call. Not found → the commented hint,
 * exactly as before. A guess is never emitted.
 */
describe('scanStores', () => {
  const deps = new Set(['zustand']);

  it('finds a zustand store and the module to import it from', () => {
    const found = scanStores(
      [{ path: 'src/store.ts', source: 'export const useApp = create<S>()((set) => ({}));' }],
      deps,
    );
    expect(found).toEqual([{ key: 'app', ident: 'useApp', importPath: './store' }]);
  });

  it('finds a plain zustand create() with no generics', () => {
    const found = scanStores(
      [{ path: 'src/store.ts', source: 'export const useStore = create((set) => ({ n: 0 }));' }],
      deps,
    );
    expect(found[0]?.ident).toBe('useStore');
  });

  it('names the redux store from configureStore', () => {
    const found = scanStores(
      [{ path: 'src/app/store.ts', source: 'export const store = configureStore({ reducer });' }],
      new Set(['@reduxjs/toolkit']),
    );
    expect(found).toEqual([{ key: 'app', ident: 'store', importPath: './app/store' }]);
  });

  it('derives a distinct key per store so two stores do not collide', () => {
    const found = scanStores(
      [
        { path: 'src/cart-store.ts', source: 'export const useCart = create(() => ({}));' },
        { path: 'src/user-store.ts', source: 'export const useUser = create(() => ({}));' },
      ],
      deps,
    );
    expect(found.map((s) => s.key)).toEqual(['cart', 'user']);
  });

  /** A dependency the app does not have cannot be the thing that created this store. */
  it('ignores a create() call when the app does not depend on that library', () => {
    const found = scanStores(
      [{ path: 'src/store.ts', source: 'export const useApp = create(() => ({}));' }],
      new Set(['react']),
    );
    expect(found).toEqual([]);
  });

  it('ignores a non-exported store — nothing can import it', () => {
    const found = scanStores(
      [{ path: 'src/store.ts', source: 'const useApp = create(() => ({}));' }],
      deps,
    );
    expect(found).toEqual([]);
  });

  it('finds nothing rather than guessing when no store declaration is present', () => {
    expect(
      scanStores([{ path: 'src/App.tsx', source: 'export const App = () => null;' }], deps),
    ).toEqual([]);
  });
});
