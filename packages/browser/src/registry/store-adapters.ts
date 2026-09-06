import { nativeWarn } from '../timers/native-console.js';
import { markAdapterSource, type StoreLike, type StoreSubscribe } from './stores.js';

/**
 * Adapters that give non-`{getState, subscribe}` state libraries the shape `registerStore` wants.
 *
 * `registerStore` duck-types on `{getState, subscribe}`, which zustand and Redux satisfy natively — so
 * those two needed nothing and got support for free. Everything else was unserved, and the gap was not
 * evenly distributed: by weekly npm downloads TanStack Query (~64M) is larger than zustand (~46M) and
 * redux (~39M), and it holds the state most likely to be WRONG in a way nothing else can see.
 *
 * That last point is the reason this file exists rather than a docs page. A stale-cache bug — the UI
 * rendering data the server has since changed, a mutation that never invalidated its query, an
 * optimistic update that was never rolled back — fires NO network request. An outside-in tool watching
 * the network sees silence and calls it healthy; the DOM shows a plausible number. The only witness is
 * the cache itself, and until now Reticle could not read it either.
 *
 * Every adapter here is a pure function returning `{getState, subscribe}`. None of them import their
 * library — they take an already-constructed client/store/proxy and use structural types, so this file
 * adds no dependency and no bundle weight for an app that uses none of them.
 */

/** The minimum of TanStack Query's `QueryClient` that this adapter touches. */
interface QueryLike {
  queryKey: readonly unknown[];
  state: {
    status: string;
    fetchStatus?: string;
    dataUpdatedAt?: number;
    error?: { message?: string } | null;
    data?: unknown;
  };
  isStale?: () => boolean;
}
interface QueryCacheLike {
  getAll: () => QueryLike[];
  subscribe: (listener: () => void) => () => void;
}
interface QueryClientLike {
  getQueryCache: () => QueryCacheLike;
}

/** How a single cached query is projected into readable state. */
export interface QuerySnapshot {
  status: string;
  fetchStatus: string | undefined;
  isStale: boolean | undefined;
  dataUpdatedAt: number | undefined;
  error: string | null;
  data: unknown;
}

/**
 * Expose a TanStack Query cache as a Reticle store, keyed by query key.
 *
 * `isStale` / `fetchStatus` / `dataUpdatedAt` are carried deliberately: they are what let an agent
 * assert the stronger property — not merely "the value rendered is X" but "the cache the UI rendered
 * from was actually fresh". A screenshot cannot distinguish a correct number from a correct-looking
 * stale one, and neither can a network log when the request never fired.
 *
 * ```ts
 * registerStore('queries', tanstackQueryStore(queryClient));
 * ```
 */
export function tanstackQueryStore(client: QueryClientLike): StoreLike {
  // Resolved per call, not captured once. A QueryClient can be rebuilt — React Strict Mode double
  // effects, a provider remount, HMR — and an adapter holding the old cache would keep answering
  // from a store the app no longer reads, which is a stale-data bug inside the tool whose job is
  // catching stale data.
  const store: StoreLike = {
    getState: (): Record<string, QuerySnapshot> => {
      const out: Record<string, QuerySnapshot> = {};
      for (const query of client.getQueryCache().getAll()) {
        const key = query.queryKey.map((part) => String(part)).join('/');
        out[key] = {
          status: query.state.status,
          fetchStatus: query.state.fetchStatus,
          isStale: query.isStale?.(),
          dataUpdatedAt: query.state.dataUpdatedAt,
          error: query.state.error?.message ?? null,
          data: query.state.data,
        };
      }
      return out;
    },
    subscribe: (listener: () => void): (() => void) => client.getQueryCache().subscribe(listener),
  };
  // Registering this adapter claims the CLIENT too, so fiber-tree discovery can tell that the app
  // already wired this exact QueryClient and must not add a second entry for it.
  markAdapterSource(store, client);
  return store;
}

/**
 * The minimum of a Jotai vanilla store this adapter touches, generic in the ATOM type.
 *
 * `atom: object` was rejected by TypeScript for a real store and the reason is contravariance, not
 * pedantry: Jotai's `get` is `<Value>(atom: Atom<Value>) => Value`, and a function that requires an
 * `Atom` cannot stand in for one that accepts any `object`. So `jotaiStore(createStore(), …)` did
 * not compile — the adapter was advertised, shipped, and unusable from TypeScript without a cast,
 * which the shape-matched fake in the sibling test could never reveal because the fake was written
 * to the same belief the adapter was.
 */
interface JotaiStoreLike<A> {
  get: (atom: A) => unknown;
  sub: (atom: A, listener: () => void) => () => void;
}

/**
 * Expose a chosen set of Jotai atoms as one Reticle store.
 *
 * The atom map is not an ergonomic shortcut, it is forced by the design: Jotai has no registry of live
 * atoms to enumerate, so "the whole store" is not a thing that exists. Naming the atoms you care about
 * is the only way to snapshot them, and it doubles as a declaration of what matters.
 *
 * ```ts
 * registerStore('app', jotaiStore(getDefaultStore(), { cart: cartAtom, user: userAtom }));
 * ```
 */
export function jotaiStore<A>(store: JotaiStoreLike<A>, atoms: Record<string, A>): StoreLike {
  return {
    getState: (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [name, atom] of Object.entries(atoms)) out[name] = store.get(atom);
      return out;
    },
    subscribe: (listener: () => void): (() => void) => {
      const unsubs = Object.values(atoms).map((atom) => store.sub(atom, listener));
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
  };
}

/** The minimum of an XState actor this adapter touches. */
interface ActorLike {
  getSnapshot: () => unknown;
  subscribe: (listener: () => void) => { unsubscribe: () => void };
}

/**
 * Expose an XState actor as a Reticle store. Its `subscribe` returns a subscription OBJECT rather than
 * an unsubscribe function, which is the single reason it does not satisfy `StoreLike` already.
 */
export function xstateStore(actor: ActorLike): StoreLike {
  return {
    getState: (): unknown => actor.getSnapshot(),
    subscribe: (listener: () => void): (() => void) => {
      const subscription = actor.subscribe(listener);
      return () => subscription.unsubscribe();
    },
  };
}

/**
 * Expose a Valtio proxy as a Reticle store. Valtio ships `snapshot`/`subscribe` as free functions
 * rather than methods, so the caller passes them in — importing them here would make every consumer
 * of this file depend on valtio.
 *
 * ```ts
 * import { snapshot, subscribe } from 'valtio/vanilla';
 * registerStore('app', valtioStore(state, snapshot, subscribe));
 * ```
 */
export function valtioStore<T extends object>(
  proxy: T,
  snapshot: (p: T) => unknown,
  subscribe: (p: T, listener: () => void) => () => void,
): StoreLike {
  return {
    getState: (): unknown => snapshot(proxy),
    subscribe: (listener: () => void): (() => void) => subscribe(proxy, listener),
  };
}

/**
 * Expose a MobX observable as a Reticle store. `toJS` and `reaction` are passed in for the same
 * dependency reason as valtio above.
 *
 * ```ts
 * import { reaction, toJS } from 'mobx';
 * registerStore('app', mobxStore(store, toJS, reaction));
 * ```
 */
export function mobxStore<T>(
  observable: T,
  toJS: (value: T) => unknown,
  reaction: (track: () => unknown, effect: () => void) => () => void,
): StoreLike {
  return {
    getState: (): unknown => toJS(observable),
    subscribe: (listener: () => void): (() => void) =>
      reaction(
        () => toJS(observable),
        () => listener(),
      ),
  };
}

/**
 * The load states a Recoil `Loadable` reports. Named because the projection below branches on them
 * and a bare 'hasValue' in three places is exactly the free string the rules forbid.
 */
const RecoilLoadState = {
  HAS_VALUE: 'hasValue',
  LOADING: 'loading',
  HAS_ERROR: 'hasError',
} as const;

/** The minimum of a Recoil `Loadable` this adapter touches. */
interface RecoilLoadableLike {
  /** 'hasValue' | 'loading' | 'hasError'. Widened to string: it arrives from outside this package. */
  state: string;
  /** The value, the pending promise, or the thrown error — which one depends on `state`. */
  contents: unknown;
}

/** The minimum of a Recoil `Snapshot` this adapter touches, generic in the ATOM type. */
interface RecoilSnapshotLike<A> {
  getLoadable: (atom: A) => RecoilLoadableLike;
}

/** How one Recoil atom is projected: the value never travels without the load state beside it. */
export interface RecoilAtomSnapshot {
  status: string;
  value: unknown;
  error: string | null;
}

function projectLoadable(loadable: RecoilLoadableLike): RecoilAtomSnapshot {
  if (loadable.state === RecoilLoadState.HAS_ERROR) {
    const contents = loadable.contents;
    return {
      status: loadable.state,
      value: null,
      error: contents instanceof Error ? contents.message : String(contents),
    };
  }
  // A LOADING loadable's `contents` is the pending promise. Sending it would serialize to `{}` and
  // read as an empty value — so the value stays null and the status carries the truth.
  if (loadable.state !== RecoilLoadState.HAS_VALUE) {
    return { status: loadable.state, value: null, error: null };
  }
  return { status: loadable.state, value: loadable.contents, error: null };
}

/**
 * Expose a chosen set of Recoil atoms as one Reticle store.
 *
 * Three things about Recoil's API shape this adapter is built around, none of them optional:
 *
 *  - **The atom map is forced, not an ergonomic choice.** Recoil has no enumerable registry of live
 *    atoms, so "the whole store" is not a thing that exists. Naming the atoms is the only way to
 *    snapshot them, and it doubles as a declaration of what matters — the same reason `jotaiStore`
 *    takes one.
 *  - **`.state`/`.contents`, never `.getValue()`.** On a pending async selector `getValue()` THROWS
 *    the pending promise, and on a failed one it throws the error. Either would take down the whole
 *    state read over one slow atom — so a loading atom reports `status: 'loading'` with a null value
 *    rather than silently becoming an empty object or an exception.
 *  - **One subscription, not one per atom.** Recoil exposes no per-atom subscription outside React
 *    (`jotaiStore` gets `store.sub(atom, …)`; there is no equivalent here). The transaction stream is
 *    the only public change signal, so the caller passes it in — the same "the library ships free
 *    functions, so hand them over" shape as `valtioStore` and `mobxStore`.
 *
 * Wire it from a bridge component, which is where `useRecoilTransactionObserver_UNSTABLE` lives:
 *
 * ```tsx
 * const latest = useRef(snapshot_UNSTABLE());
 * const listeners = useRef(new Set<() => void>()).current;
 * useRecoilTransactionObserver_UNSTABLE(({ snapshot }) => {
 *   latest.current = snapshot;
 *   for (const l of listeners) l();
 * });
 * registerStore('recoil', recoilStore({ cart: cartAtom }, () => latest.current, (l) => {
 *   listeners.add(l);
 *   return () => listeners.delete(l);
 * }));
 * ```
 */
export function recoilStore<A>(
  atoms: Record<string, A>,
  snapshot: () => RecoilSnapshotLike<A>,
  subscribe: StoreSubscribe,
): StoreLike {
  return {
    // Resolved per call, not captured once: a Recoil snapshot is IMMUTABLE, so an adapter holding
    // one would keep answering from the transaction it was built in and never see another write.
    getState: (): Record<string, RecoilAtomSnapshot> => {
      const current = snapshot();
      const out: Record<string, RecoilAtomSnapshot> = {};
      for (const [name, atom] of Object.entries(atoms)) {
        out[name] = projectLoadable(current.getLoadable(atom));
      }
      return out;
    },
    subscribe,
  };
}

/**
 * The minimum of a Svelte store this adapter touches.
 *
 * `subscribe` may return either the unsubscribe function or an object carrying one — the store
 * contract permits both, and an RxJS-shaped source returns the object form.
 */
interface SvelteReadable {
  subscribe: (run: (value: unknown) => void) => (() => void) | { unsubscribe: () => void };
}

function stopSubscription(handle: (() => void) | { unsubscribe: () => void }): void {
  if ('function' === typeof handle) {
    handle();
    return;
  }
  handle.unsubscribe();
}

/**
 * Expose a Svelte store as a Reticle store.
 *
 * Structurally unlike every other adapter in this file: they all wrap something that can be PULLED
 * (`getState`, `getSnapshot`, `snapshot(proxy)`, `toJS`). A Svelte store has no pull side at all —
 * `{ subscribe }` is the entire contract. What makes a pull possible anyway is the part of that
 * contract which says `subscribe` must call back **immediately and synchronously** with the current
 * value: subscribe, catch the value, unsubscribe, return it. That is precisely how `svelte/store`'s
 * own `get()` is implemented, so it is a blessed read rather than a trick.
 *
 * Doing it that way is what keeps this adapter free of the `dispose` the obvious implementation
 * needs. Caching the latest value would mean holding a permanent subscription, which means a
 * teardown the other five adapters don't have, which means a leak the moment a caller forgets it.
 * A transient subscription per read owns nothing and leaks nothing.
 *
 * ```ts
 * registerStore('cart', svelteStore(cartStore));
 * ```
 */
export function svelteStore(
  readable: SvelteReadable,
  warn: (message: string) => void = nativeWarn,
): StoreLike {
  let warnedAboutLazyStore = false;
  return {
    getState: (): unknown => {
      let value: unknown;
      let called = false;
      stopSubscription(
        readable.subscribe((next) => {
          value = next;
          called = true;
        }),
      );
      // A store that did NOT call back synchronously (an RxJS Observable that is not a
      // BehaviorSubject, a hand-rolled store that breaks the contract) leaves `value` undefined —
      // indistinguishable from a store legitimately holding undefined. Reading empty when the answer
      // is "unknown" is the false green this project exists to prevent, so say it once, out loud.
      if (!called && !warnedAboutLazyStore) {
        warnedAboutLazyStore = true;
        warn(
          '[reticle] a store passed to svelteStore did not call its subscriber synchronously, so ' +
            'its current value cannot be read. reticle_state will report undefined for it. Svelte ' +
            'stores always call back immediately; an RxJS Observable does not unless it is a ' +
            'BehaviorSubject.',
        );
      }
      return value;
    },
    subscribe: (listener: () => void): (() => void) => {
      // Swallow whatever arrives DURING the subscribe call. Forwarding it would emit a STATE_CHANGE
      // at REGISTRATION time for a change that never happened — a diff of nothing that shows up in
      // causal summaries and that a {kind:'state'} predicate could satisfy without the app doing
      // anything at all.
      //
      // The window is what makes this correct, rather than "swallow the first callback whenever it
      // arrives". A store that does NOT call back synchronously (an RxJS Observable that is not a
      // BehaviorSubject — the exact store `getState` warns about) has no registration callback to
      // drop, so counting callbacks ate its first REAL change: no STATE_CHANGE, and a
      // {kind:'state'} assertion with nothing to match. A silently missed state change is the false
      // green this project exists to prevent, so the rule is positional, not ordinal.
      let inSubscribeCall = true;
      const handle = readable.subscribe(() => {
        if (!inSubscribeCall) listener();
      });
      inSubscribeCall = false;
      return () => stopSubscription(handle);
    },
  };
}

/** Pinia `$subscribe` options. `sync` and `detached` are library option values, not free strings. */
const PINIA_SUBSCRIBE_OPTIONS = { detached: true, flush: 'sync' } as const;

/**
 * The minimum of a Pinia store this adapter touches.
 *
 * Two things here look over-specified and are not, both found by compiling against the real library
 * rather than against a fake written to the same belief as the adapter:
 *
 *  - **`$state: object`, not `Record<string, unknown>`.** A Pinia store's `$state` is a concrete
 *    object type with named keys and no index signature, and TypeScript rejects those for a
 *    `Record<string, unknown>` parameter. `piniaStore(useCartStore())` did not compile — the same
 *    shape of failure as the Jotai contravariance note above, and equally invisible to a fake.
 *  - **`flush` as the literal union**, not `string`. The option object is checked contravariantly, so
 *    a widened `string` here makes the real `$subscribe` unassignable to this shape and the whole
 *    store stops matching.
 */
interface PiniaStoreLike {
  $state: object;
  $subscribe: (
    callback: (mutation: unknown, state: unknown) => void,
    options?: { detached?: boolean; flush?: 'pre' | 'post' | 'sync' },
  ) => () => void;
}

/**
 * Expose a Pinia store as a Reticle store. `$state` / `$subscribe` are close to `{getState,
 * subscribe}` but not close enough for `registerStore`'s duck-type, which is the whole reason a Vue
 * app currently connects and then reports no state at all.
 *
 * Both `$subscribe` options are load-bearing:
 *
 *  - **`detached`** keeps the subscription alive past the component that happened to register the
 *    store. Without it Pinia tears the listener down on unmount, so a store registered from inside a
 *    component goes permanently silent after the first route change — readable, but never again
 *    emitting a STATE_CHANGE, which reads exactly like an app that stopped changing.
 *  - **`flush: 'sync'`** puts the notification inside the action's attribution window. The default
 *    (`'post'`) defers it past the Vue update tick, and a state change that lands after the window
 *    closed is no longer linked to the click that caused it in the causal summary.
 *
 * `$state` carries state, not getters — a Pinia getter is derived, so asserting on the state it
 * derives from is the stronger assertion anyway.
 *
 * ```ts
 * registerStore('cart', piniaStore(useCartStore()));
 * ```
 */
export function piniaStore(store: PiniaStoreLike): StoreLike {
  return {
    // `$state` is a live reactive proxy, so this reads through to the current value rather than
    // snapshotting at registration. The transport serializer walks it like any object and guards
    // each key, which is what keeps a throwing reactive trap from costing the whole read.
    getState: (): unknown => store.$state,
    subscribe: (listener: () => void): (() => void) =>
      store.$subscribe(() => listener(), { ...PINIA_SUBSCRIBE_OPTIONS }),
  };
}

/**
 * Build a store whose value is PUSHED in rather than pulled — for state that has no object to read.
 *
 * React Context and `useState`/`useReducer` keep their value inside the fiber tree; there is no store
 * instance and no subscription point outside React, so no adapter over a public API is possible. The
 * only way in is to invert the direction: the component holding the value tells Reticle when it
 * changes. `@reticlehq/react`'s `useReticleStore` hook is the ergonomic wrapper over this.
 *
 * Returns the store plus the `push` that updates it, so the caller owns the write side.
 */
export function pushStore(initial: unknown): { store: StoreLike; push: (value: unknown) => void } {
  let current = initial;
  const listeners = new Set<() => void>();
  const subscribe: StoreSubscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    store: { getState: () => current, subscribe },
    push: (value: unknown): void => {
      current = value;
      for (const listener of listeners) listener();
    },
  };
}
