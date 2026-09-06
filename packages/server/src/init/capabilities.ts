/**
 * What the app can be driven by: its `data-testid` values, and which state library holds its truth.
 *
 * `init` wired none of this, so every app came up with `hasCapabilities: false`, empty capabilities,
 * and a `reticle_state` holding nothing but `__reticle_renders` — the state-truth read that SKILL.md
 * calls the highest-value line was unavailable on every app out of the box. Measured across six.
 *
 * Testids are scanned rather than asked for. Stores are NAMED but not wired: detecting that an app
 * depends on zustand is easy, knowing which module exports the store instance is not, and generating
 * a wrong import would break the dev module that everything else now hangs off.
 */

import { posix } from 'node:path';

/** `data-testid="foo"` / `data-testid='foo'` / `data-testid={"foo"}` — the forms people actually write. */
const TESTID_ATTR = /data-testid\s*=\s*[{]?\s*["'`]([^"'`]+)["'`]/g;

/** Cap the generated list. A capabilities block is a hint for an agent, not an inventory. */
export const MAX_TESTIDS = 60;

/** Every distinct `data-testid` literal in the given sources, in first-seen order. */
export function scanTestids(sources: readonly string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(TESTID_ATTR)) {
      const id = m[1];
      if (id !== undefined && id.length > 0) found.add(id);
      if (found.size >= MAX_TESTIDS) return [...found];
    }
  }
  return [...found];
}

/**
 * State libraries the browser SDK has an adapter for, in the order we would recommend registering
 * them. TanStack Query is first on purpose: a stale cache served as fresh fires NO network request,
 * so the network log shows silence and the DOM shows a plausible number — the cache is the only
 * witness, which makes it the highest-value store in the list and the least obvious one to add.
 */
const STORE_LIBRARIES: readonly (readonly [dep: string, hint: string])[] = [
  ['@tanstack/react-query', "registerStore('queries', tanstackQueryStore(queryClient))"],
  [
    'zustand',
    "registerStore('app', useStore) // pass the store itself, not () => store.getState()",
  ],
  ['@reduxjs/toolkit', "registerStore('app', store)"],
  ['redux', "registerStore('app', store)"],
  ['jotai', "registerStore('app', jotaiStore(getDefaultStore(), { cart, user }))"],
  ['valtio', "registerStore('app', valtioStore(state))"],
  ['mobx', "registerStore('app', mobxStore(state))"],
  ['xstate', "registerStore('machine', xstateStore(actor))"],
  ['pinia', "registerStore('cart', piniaStore(useCartStore()))"],
  ['svelte', "registerStore('cart', svelteStore(cartStore))"],
];

/**
 * Libraries that hand their store to React through a context provider, and therefore need no hint.
 *
 * `<Provider store>` and `<QueryClientProvider client>` put the store instance in the fiber tree as
 * a prop, so the React adapter finds and registers it on the first commit — see `auto-stores.ts` in
 * `@reticlehq/react`. Offering a commented `registerStore` line for these was asking someone to do
 * by hand, and be nagged about, work that is already done by the time they read the report.
 *
 * Everything absent from this set is module-scope (Zustand, Valtio, a MobX singleton) or needs an
 * argument only the source supplies (Jotai atoms, an XState actor). Nothing in the running app
 * points at those, so they still need the app to hand them over, and the hint still earns its place.
 */
const AUTO_DISCOVERED_DEPS: ReadonlySet<string> = new Set([
  '@tanstack/react-query',
  '@reduxjs/toolkit',
  'redux',
]);

/**
 * The store libraries this app depends on AND the running app cannot reveal on its own, as
 * ready-to-uncomment registration lines.
 */
export function storeHints(deps: ReadonlySet<string>): string[] {
  return STORE_LIBRARIES.filter(([dep]) => deps.has(dep) && !AUTO_DISCOVERED_DEPS.has(dep)).map(
    ([, hint]) => hint,
  );
}

/** A store instance we found in the app's own source, with everything needed to import and register it. */
export interface FoundStore {
  /** The name it registers under — what `reticle_state` keys its output by. */
  key: string;
  /** The exported identifier. */
  ident: string;
  /** Module specifier relative to `src/reticle-dev.ts`. */
  importPath: string;
}

/**
 * Store factories whose EXPORTED result is the store instance itself — the form `registerStore`
 * takes directly. Each is gated on the app actually depending on that library, so a local helper
 * called `create` in an app with no store library is never mistaken for one.
 *
 * Deliberately short. The adapter-wrapped libraries (Jotai, XState, Valtio, MobX, TanStack Query)
 * need an argument we cannot infer — which atoms, which actor, which queryClient — so they keep the
 * commented hint. Guessing there produces a module that throws on import, which is strictly worse
 * than a comment.
 */
const STORE_FACTORIES: readonly (readonly [dep: string, factory: string])[] = [
  ['zustand', 'create'],
  ['@reduxjs/toolkit', 'configureStore'],
  ['redux', 'createStore'],
];

/** `export const useCart = create<S>()(...)` / `export const store = configureStore({...})`. */
function storeDeclaration(factory: string): RegExp {
  return new RegExp(`export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${factory}\\s*[<(]`, 'g');
}

/**
 * `src/cart-store.ts` → `cart`; `src/store.ts` → `app`. The key is what the agent reads state under,
 * so it has to be stable and distinct — two stores sharing one key would silently overwrite.
 */
function storeKey(path: string, taken: ReadonlySet<string>): string {
  const file = (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const base = file.replace(/[-_.]?stores?$/i, '').replace(/[^a-z0-9]+/gi, '-') || 'app';
  const key = base.toLowerCase();
  if (!taken.has(key)) return key;
  for (let n = 2; ; n += 1) {
    const candidate = `${key}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Module specifier for `store.ts` as seen FROM the generated dev module.
 *
 * The dev module is not always a sibling: Vite puts it at `src/reticle-dev.ts`, Next at
 * `app/reticle-dev.tsx` or `src/app/reticle-dev.tsx`. A specifier computed for one is dead in the
 * other, and a dead import in this file breaks the module every other capability hangs off — so the
 * relative path is computed, not assumed.
 */
function importPathFor(storePath: string, fromDir: string): string {
  const noExt = storePath.replace(/\.[^./]+$/, '');
  const rel = posix.relative(fromDir, noExt);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Where the generated dev module lives, for Vite. Next passes its own. */
const DEFAULT_DEV_MODULE_DIR = 'src';

/**
 * Store instances declared in the app's own source, ready to import and register.
 *
 * Only exported declarations of a factory the app actually depends on: anything less certain would
 * generate an import that breaks the dev module everything else hangs off, and a broken module is
 * worse than the commented hint it replaces.
 */
export function scanStores(
  files: readonly { path: string; source: string }[],
  deps: ReadonlySet<string>,
  fromDir: string = DEFAULT_DEV_MODULE_DIR,
): FoundStore[] {
  const factories = STORE_FACTORIES.filter(([dep]) => deps.has(dep)).map(([, f]) => f);
  const found: FoundStore[] = [];
  const keys = new Set<string>();
  for (const { path, source } of files) {
    for (const factory of factories) {
      for (const m of source.matchAll(storeDeclaration(factory))) {
        const ident = m[1];
        if (ident === undefined) continue;
        const key = storeKey(path, keys);
        keys.add(key);
        found.push({ key, ident, importPath: importPathFor(path, fromDir) });
      }
    }
  }
  return found;
}
