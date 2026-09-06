/**
 * Find the app's state stores WITHOUT the app registering them.
 *
 * `registerStore` is the highest-value line in a Reticle install and the one most likely never to be
 * written: `init` can only offer a commented suggestion, because the argument it would need
 * (which client, which store instance) is knowable only by reading the source. Measured on real
 * apps, that suggestion mostly stays a comment — the install reports every step green,
 * `hasCapabilities` stays false, and `reticle_state` is empty forever. The agent doing the install
 * then spends a handful of turns being told to go finish the file, which is most of what makes
 * onboarding long.
 *
 * The observation that removes the whole step: every context-based state library already hands its
 * store to React as a prop. `<Provider store>` renders `ReactReduxContext.Provider value={{store}}`,
 * `<QueryClientProvider client>` renders `QueryClientContext.Provider value={client}`. So the store
 * is sitting in the fiber tree under `memoizedProps.value`, and one walk finds it.
 *
 * WHAT THIS CANNOT FIND, deliberately: module-scope stores (Zustand, Valtio, MobX singletons, Jotai
 * atoms). They are never passed through a provider, so nothing in the tree points at them and only
 * the app can hand them over. Those still need `registerStore`, and the capability report must keep
 * saying so — an auto-discovery that quietly covered 60% of apps while reading as though it covered
 * all of them would be a worse failure than the manual step it replaced.
 *
 * A store the app registered itself ALWAYS wins. This never overwrites a name that is already taken.
 */

import {
  registerStore,
  sourceOwner,
  storeNames,
  tanstackQueryStore,
  unregisterStore,
  type StoreLike,
} from '@reticlehq/browser';

/** Names for the libraries we can recognise by shape rather than by import. */
export const AUTO_STORE_KEY = {
  REDUX: 'redux',
  QUERY: 'query',
  /** Anything store-shaped behind an anonymous context. */
  STORE: 'store',
} as const;

/** React stamps its fiber on host nodes under a key with a per-copy suffix. */
const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];
/** How many elements to look at before concluding this is not a React page. A root is near the top. */
const MAX_HOST_SCAN = 200;
/** Fibers visited in one walk. A cap, not a budget — real trees finish far inside it. */
const MAX_FIBER_NODES = 20000;

/** React 18 renders a provider whose `type` carries this; React 19 uses the context object itself. */
const PROVIDER_TYPE = Symbol.for('react.provider');
const CONTEXT_TYPE = Symbol.for('react.context');

export interface DiscoveredStore {
  key: string;
  store: StoreLike;
  /**
   * The object the store was built FROM — the Redux store, the QueryClient.
   *
   * Carried separately from `store` because for an adapter-wrapped library the two are different
   * objects, and the source is the only one that can answer "has the app already registered this?".
   */
  source: object;
}

interface FiberNode {
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
  type?: unknown;
  memoizedProps?: unknown;
}

function isStoreLike(value: unknown): value is StoreLike {
  if (null === value) return false;
  if ('object' !== typeof value && 'function' !== typeof value) return false;
  const candidate = value as Partial<StoreLike>;
  return 'function' === typeof candidate.getState && 'function' === typeof candidate.subscribe;
}

/** A TanStack QueryClient, identified by the one method the adapter needs. */
function isQueryClient(value: unknown): value is { getQueryCache: () => unknown } {
  if (null === value || 'object' !== typeof value) return false;
  return 'function' === typeof (value as { getQueryCache?: unknown }).getQueryCache;
}

/**
 * Turn a context display name into a store key.
 *
 * Lowercased and stripped to word characters because the key is typed by an agent into
 * `reticle_state({ store })`, and `ReactRedux.Provider` is not a thing anyone will type correctly.
 */
function keyFromName(name: string | undefined): string | undefined {
  if ('string' !== typeof name) return undefined;
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Decide whether one context value is a store, and what to call it.
 *
 * Ordered most-specific first: react-redux nests the store under `.store` and would otherwise fall
 * through to the generic branch under whatever its context is called this major version.
 */
export function classifyProviderValue(
  value: unknown,
  displayName: string | undefined,
): DiscoveredStore | null {
  if (null === value || undefined === value) return null;
  const nested = (value as { store?: unknown }).store;
  if (isStoreLike(nested)) return { key: AUTO_STORE_KEY.REDUX, store: nested, source: nested };
  if (isQueryClient(value)) {
    return {
      key: AUTO_STORE_KEY.QUERY,
      // The adapter already exists and carries what a bare `getState` would lose — staleness and
      // fetch status, which is the whole reason a cache read beats a DOM read.
      store: tanstackQueryStore(value as Parameters<typeof tanstackQueryStore>[0]),
      source: value,
    };
  }
  if (isStoreLike(value)) {
    return { key: keyFromName(displayName) ?? AUTO_STORE_KEY.STORE, store: value, source: value };
  }
  return null;
}

/** The context a provider fiber renders, across the versions that spell it differently. */
function providerContext(type: unknown): { displayName?: string } | null {
  if (null === type || 'object' !== typeof type) return null;
  const marker = (type as { $$typeof?: symbol }).$$typeof;
  if (PROVIDER_TYPE === marker) {
    const inner = (type as { _context?: { displayName?: string } })._context;
    return inner ?? type;
  }
  if (CONTEXT_TYPE === marker) return type;
  return null;
}

/** The topmost fiber reachable from one node — the tree we then walk downward. */
function topOf(fiber: FiberNode): FiberNode {
  let current = fiber;
  for (let i = 0; i < MAX_FIBER_NODES; i += 1) {
    const parent = current.return;
    if (null === parent || undefined === parent) return current;
    current = parent;
  }
  return current;
}

/** Any fiber React has stamped on the document, as the entry point into the tree. */
function findFiber(doc: Document): FiberNode | null {
  const elements = doc.querySelectorAll('*');
  const limit = Math.min(elements.length, MAX_HOST_SCAN);
  for (let i = 0; i < limit; i += 1) {
    const node = elements[i] as unknown as Record<string, unknown> | undefined;
    if (undefined === node) continue;
    for (const key of Object.keys(node)) {
      if (FIBER_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        const fiber = node[key];
        if (null !== fiber && 'object' === typeof fiber) return fiber;
      }
    }
  }
  return null;
}

/**
 * Every store-shaped context value in the mounted tree, in mount order.
 *
 * Iterative rather than recursive: a deep tree is ordinary in a real app, and a stack overflow
 * inside instrumentation would take the host app's render with it.
 */
export function discoverStores(doc: Document): DiscoveredStore[] {
  const entry = findFiber(doc);
  if (null === entry) return [];
  const found: DiscoveredStore[] = [];
  const used = new Set<string>();
  try {
    const stack: FiberNode[] = [topOf(entry)];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_FIBER_NODES) {
      const fiber = stack.pop();
      if (undefined === fiber || null === fiber) continue;
      visited += 1;
      const context = providerContext(fiber.type);
      if (null !== context) {
        const props = fiber.memoizedProps;
        const value =
          null !== props && 'object' === typeof props ? (props as { value?: unknown }).value : null;
        const store = classifyProviderValue(value, context.displayName);
        if (null !== store) {
          // Two providers of the same shape are ordinary — a nested QueryClient, two Redux stores in
          // a micro-frontend. Both are worth reading, so the second gets a suffixed key rather than
          // silently replacing the first.
          let key = store.key;
          for (let n = 2; used.has(key); n += 1) key = `${store.key}${String(n)}`;
          used.add(key);
          found.push({ key, store: store.store, source: store.source });
        }
      }
      const sibling = fiber.sibling;
      if (null !== sibling && undefined !== sibling) stack.push(sibling);
      const child = fiber.child;
      if (null !== child && undefined !== child) stack.push(child);
    }
  } catch {
    // A fiber shape we have not seen must never break the host app. Whatever was found still counts.
  }
  return found;
}

/** What this module registered: our key → the source object we registered it for. */
let registered = new Map<string, object>();

/** Test seam: forget what was discovered so a fresh tree can be walked. */
export function resetAutoStores(): void {
  registered = new Map<string, object>();
}

/**
 * Give up a name we claimed for a store the app has since registered itself.
 *
 * The order of the two is a genuine race: the app registers inside `connect()`, discovery runs on a
 * React commit, and which lands first depends on the app. Handling only the app-first order would
 * leave the other one shipping the exact duplicate this exists to prevent — one cache under two
 * names, differing only by which of them the reader happens to try.
 */
function releaseSupersededNames(): void {
  for (const [key, source] of [...registered]) {
    const owner = sourceOwner(source);
    if (owner !== undefined && owner !== key) {
      unregisterStore(key);
      registered.delete(key);
    }
  }
}

/**
 * Register everything discovered that is not already spoken for, and return the new names.
 *
 * Safe to call on every commit: it re-walks (providers can mount late) but only registers sources
 * nothing has claimed, so the steady state is a walk and no writes.
 */
export function autoRegisterStores(doc: Document): string[] {
  releaseSupersededNames();
  const taken = new Set(storeNames());
  const added: string[] = [];
  for (const { key, store, source } of discoverStores(doc)) {
    // The SOURCE, not the name and not the read value. bench-app registers `queries` from
    // `tanstackQueryStore(client)`; discovery finds the same `client` and, keying on the name alone,
    // added `query` beside it — one cache listed twice in every state read. Comparing read values
    // cannot catch it either, because that adapter builds a fresh snapshot on every `getState`.
    if (sourceOwner(source) !== undefined) continue;
    if (taken.has(key) || registered.has(key)) continue;
    try {
      registerStore(key, store);
    } catch {
      continue; // a store whose getState throws on registration is not worth taking the app down for
    }
    registered.set(key, source);
    added.push(key);
  }
  return added;
}
