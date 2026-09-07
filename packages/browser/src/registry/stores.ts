import { RETICLE_RENDERS_STORE } from '@reticlehq/core';
import { nativeWarn } from '../timers/native-console.js';
import { sanitizeWithReport, type TruncationReport } from '../security/serialization.js';

/** Store registry — lets the agent pull live framework/store state on demand. */
export type StoreGetter = () => unknown;
/** A store's subscribe method (Zustand/Redux shape): register a listener, get back an unsubscribe. */
export type StoreSubscribe = (listener: () => void) => () => void;

// Persist on a global so registrations survive HMR re-evaluation (see adapters.ts / feedback #7).
/** Notified when a SUBSCRIBABLE store is registered, so a late registration is still observed. */
// Exported because the lossy-transform registry classifies it by name — see
// scripts/check-lossy-transforms.mjs, which fails the lint gate if it stops being exported.
export type StoreRegisteredListener = (entry: [string, StoreGetter, StoreSubscribe]) => void;

const globalStore = globalThis as unknown as {
  __reticleStores?: Map<string, StoreGetter>;
  __reticleStoreSubs?: Map<string, StoreSubscribe>;
  __reticleStoreListeners?: Set<StoreRegisteredListener>;
};
const stores: Map<string, StoreGetter> = (globalStore.__reticleStores ??= new Map());
// Parallel map: stores that also provided a subscribe method, for automatic STATE_CHANGE diffs.
const subscribers: Map<string, StoreSubscribe> = (globalStore.__reticleStoreSubs ??= new Map());
const registrationListeners: Set<StoreRegisteredListener> = (globalStore.__reticleStoreListeners ??=
  new Set());

/**
 * Observe FUTURE subscribable-store registrations. The SDK installs its observers during connect, but
 * apps call registerStore afterwards — so enumerating once at install time subscribes to nothing and
 * STATE_CHANGE never fires. Observers use this to pick up stores registered after they installed.
 */
export function onStoreRegistered(listener: StoreRegisteredListener): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

/** A Zustand/Redux-shaped store: exposes both current state and a subscribe. */
export interface StoreLike {
  getState: () => unknown;
  subscribe: StoreSubscribe;
}

function isStoreLike(source: StoreGetter | StoreLike): source is StoreLike {
  // Zustand's `create` returns a CALLABLE hook that also carries getState/subscribe, so a store can be
  // typeof 'function' as well as 'object'. What distinguishes it from a plain getter is those two members
  // — never the typeof. (Checking only for 'object' left every Zustand app on pull-only reads.)
  if (null === source) return false;
  if (typeof source !== 'object' && typeof source !== 'function') return false;
  const candidate = source as Partial<StoreLike>;
  return 'function' === typeof candidate.getState && 'function' === typeof candidate.subscribe;
}

/**
 * App calls this once per store. PREFER passing the store itself — `registerStore('app', useApp)` —
 * which wires `getState` AND `subscribe`, so every mutation emits a STATE_CHANGE path diff automatically
 * (the before→after the causal summary reports). Passing a bare getter still works for back-compat, but
 * leaves the store on pull-only reads: no change events, and an empty `stateDiffs` in every act summary.
 */
export function registerStore(
  name: string,
  source: StoreGetter | StoreLike,
  subscribe?: StoreSubscribe,
): void {
  claimSource(name, source);
  if (isStoreLike(source)) {
    const getter: StoreGetter = () => source.getState();
    const sub: StoreSubscribe = (listener) => source.subscribe(listener);
    stores.set(name, getter);
    subscribers.set(name, sub);
    notifyRegistered(name, getter, sub);
    return;
  }
  if (typeof source !== 'function') {
    const hasSubscribe = 'object' === typeof source && source !== null && 'subscribe' in source;
    nativeWarn(
      `[reticle] store "${name}" is neither a getter function nor a {getState, subscribe} store` +
        (hasSubscribe
          ? ` — it has subscribe but no getState. Wrap it with an adapter or add getState.`
          : '.'),
    );
    return;
  }
  stores.set(name, source);
  if (subscribe !== undefined) {
    subscribers.set(name, subscribe);
    notifyRegistered(name, source, subscribe);
    return;
  }
  // Readable but SILENT: reticle_state can read this store on demand, yet nothing will ever emit a
  // STATE_CHANGE for it, so causal summaries show no state diff and a {kind:"state"} predicate can
  // never observe it changing. That reads exactly like "the app did not change anything" — a false
  // negative with no error attached. Say so once, at registration, where the developer can fix it by
  // passing the store itself (or a subscribe function) instead of a bare getter.
  warnSilentStoreOnce(name);
}

function notifyRegistered(name: string, getter: StoreGetter, subscribe: StoreSubscribe): void {
  for (const listener of registrationListeners) {
    try {
      listener([name, getter, subscribe]);
    } catch {
      // a broken observer must never break the app's registerStore call
    }
  }
}

export function unregisterStore(name: string): void {
  stores.delete(name);
  subscribers.delete(name);
}

export function storeNames(): string[] {
  return [...stores.keys()];
}

/** Registered stores that exposed a subscribe method, as [name, getter, subscribe] tuples. */
export function subscribableStores(): Array<[string, StoreGetter, StoreSubscribe]> {
  const out: Array<[string, StoreGetter, StoreSubscribe]> = [];
  for (const [name, subscribe] of subscribers) {
    const getter = stores.get(name);
    if (getter !== undefined) out.push([name, getter, subscribe]);
  }
  return out;
}

/**
 * Read one store (by name) or all of them WITHOUT transport sanitization. For scoped reads that
 * select a sub-tree first, so a deep/large path (e.g. row 250 of a 500-row array) isn't truncated
 * before selection. Each getter is isolated: a throw becomes an error object.
 */
export function readStoresRaw(only?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, getter] of stores) {
    if (only !== undefined && name !== only) continue;
    try {
      out[name] = getter();
    } catch (error) {
      out[name] = { __error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}

/** Read one store (by name) or all of them, each capped for transport. */
export function readStores(only?: string): Record<string, unknown> {
  return readStoresWithTruncation(only).stores;
}

/**
 * As `readStores`, plus which stores came back INCOMPLETE.
 *
 * The whole-store read is the one path where the transport caps could silently hand back a fraction
 * of a large store — ~142 of 1,000 entities, with the remainder simply absent. A caller comparing
 * that against expected data reads it as "the app lost the rest", which is a false failure; a caller
 * asserting something is absent reads it as proof, which is a false green. Neither is recoverable
 * from the payload, so the fact of truncation travels beside it.
 */
export function readStoresWithTruncation(only?: string): {
  stores: Record<string, unknown>;
  truncation?: Record<string, TruncationReport>;
} {
  const stores: Record<string, unknown> = {};
  const truncation: Record<string, TruncationReport> = {};
  for (const [name, value] of Object.entries(readStoresRaw(only))) {
    const result = sanitizeWithReport(value);
    stores[name] = result.value;
    if (result.truncation !== undefined) truncation[name] = result.truncation;
  }
  return Object.keys(truncation).length > 0 ? { stores, truncation } : { stores };
}

/** Stores already warned about — a warning that repeats on every HMR cycle or remount becomes noise. */
const warnedSilent = new Set<string>();

/**
 * Reticle's OWN read-only stores. `@reticlehq/react` registers a render-stats getter that the app
 * developer never wrote and cannot change, so warning about it would be Reticle telling the user to fix
 * Reticle — the same self-contradiction as a tool description naming a tool the profile does not expose.
 */
const RETICLE_OWNED_STORES = new Set<string>([RETICLE_RENDERS_STORE]);

function warnSilentStoreOnce(name: string): void {
  if (RETICLE_OWNED_STORES.has(name) || warnedSilent.has(name)) return;
  warnedSilent.add(name);
  nativeWarn(
    `[reticle] store "${name}" was registered without a subscribe function. It can be READ, but its ` +
      `changes are invisible: no STATE_CHANGE events, no state diffs in causal summaries, and a state ` +
      `predicate will never see it update. Pass the store object (or a subscribe callback) to fix.`,
  );
}

/**
 * Who owns a given store SOURCE — the object the app (or an adapter) was built from.
 *
 * Registration is keyed by name, which cannot answer "is this same store already readable?". The
 * question matters because the React adapter discovers stores from the fiber tree, and an app that
 * has already registered the very same store by hand must not get a second entry for it under a
 * second name. Comparing the READ VALUE cannot answer it either: `tanstackQueryStore` builds a fresh
 * snapshot object on every `getState`, so identity never matches. Measured on bench-app, which
 * registers `queries` itself and got an auto-discovered `query` beside it — one cache, listed twice,
 * in every state read.
 *
 * A WeakMap so nothing here keeps an app's store alive.
 */
const sourceOwners = new WeakMap<object, string>();
/** Adapter instance → the object it wraps, so registering an adapter also claims its source. */
const adapterSources = new WeakMap<object, object>();

/** Called by an adapter to record what it was built from. See `sourceOwner`. */
export function markAdapterSource(store: object, source: object): void {
  adapterSources.set(store, source);
}

function claimSource(name: string, source: StoreGetter | StoreLike): void {
  if (null === source || ('object' !== typeof source && 'function' !== typeof source)) return;
  sourceOwners.set(source, name);
  const wrapped = adapterSources.get(source);
  if (wrapped !== undefined) sourceOwners.set(wrapped, name);
}

/** The name this store source is registered under, or undefined if nothing has claimed it. */
export function sourceOwner(value: unknown): string | undefined {
  if (null === value || ('object' !== typeof value && 'function' !== typeof value))
    return undefined;
  return sourceOwners.get(value);
}
