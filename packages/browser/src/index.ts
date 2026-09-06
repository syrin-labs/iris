import { Reticle } from './reticle.js';

/**
 * The singleton embedded in the host app: `import { reticle } from '@reticlehq/browser'`.
 * Persisted on a global so HMR module re-evaluation reuses the same (already-connected)
 * instance instead of creating a second bridge connection (feedback #7).
 */
const globalStore = globalThis as unknown as { __reticleInstance?: Reticle };
export const reticle: Reticle = (globalStore.__reticleInstance ??= new Reticle());

export { Reticle } from './reticle.js';
export type { ReticleConnectOptions } from './reticle.js';

// Session label sentinel: pass as `session` (or omit it) to get a unique per-tab id (no collisions).
export { SESSION_AUTO } from '@reticlehq/core';

// Exclude your own dev widgets from snapshots/observers.
export { setIgnoreSelectors } from './dom/dom-ignore.js';

// Adapter API (used by @reticlehq/react and other framework adapters).
export {
  registerAdapter,
  identifyComponent,
  readComponentState,
  elementHasHoverHandlers,
  adapterNames,
} from './registry/adapters.js';
export type { ReticleAdapter, ComponentInfo, ComponentSource } from './registry/adapters.js';

// Store registry: pull live framework/store state on demand.
export {
  registerStore,
  unregisterStore,
  storeNames,
  readStores,
  readStoresWithTruncation,
  // Which name a store SOURCE is registered under. The React adapter discovers stores from the fiber
  // tree and needs this to tell "the app already wired this exact store" from "this is another one" —
  // a question neither the name nor the read value can answer.
  sourceOwner,
  markAdapterSource,
} from './registry/stores.js';
export type { StoreGetter, StoreLike, StoreSubscribe } from './registry/stores.js';

// Adapters for state libraries that do not natively expose `{getState, subscribe}`. zustand and Redux
// need none of these; TanStack Query is the one that matters most, because a stale-cache bug fires no
// request and renders a plausible value, so the cache is the only witness.
export {
  tanstackQueryStore,
  jotaiStore,
  xstateStore,
  valtioStore,
  mobxStore,
  recoilStore,
  svelteStore,
  piniaStore,
  pushStore,
} from './registry/store-adapters.js';
export type { QuerySnapshot, RecoilAtomSnapshot } from './registry/store-adapters.js';

// Capability registry: the app self-describes its testable surface via reticle.describe.
export {
  registerCapabilities,
  getCapabilities,
  hasCapabilities,
  setCapabilitiesListener,
} from './registry/capabilities.js';
export type { Capabilities, CapabilitiesInput, CapabilityFlow } from './registry/capabilities.js';

// SDK helpers: adopt the recommended integration patterns without boilerplate.
export { createReticleEmitter } from './registry/emitter.js';
export type {
  ReticleEmitter,
  EmitterTarget,
  CreateReticleEmitterOptions,
} from './registry/emitter.js';
export { commitAndSignal } from './registry/commit-and-signal.js';
export { registerReticleDomain } from './registry/domains.js';
export type { ReticleDomain } from './registry/domains.js';

// Lower-level building blocks (useful for tests and advanced embedding).
export { buildSnapshot } from './dom/snapshot.js';

// Chart inspection. Surfaced automatically on any element descriptor that contains faulty plot
// geometry (see ElementDescriptor.chart), and exported for direct use — canvasChartData is the only
// route to a canvas chart's data, since its pixels are not DOM.
export { inspectChart, canvasChartData } from './dom/chart.js';
export type { ChartReport, ChartFinding, CanvasChartData } from './dom/chart.js';
export { matchQuery, runQuery } from './dom/query.js';
export { executeAction, executeSequence } from './actions/actions.js';
export { describe, getRole, getAccessibleName, getStates, isVisible } from './dom/a11y.js';
export { refs, RefRegistry } from './dom/refs.js';
export { Annotator, installAnnotator, type AnnotatorDeps } from './review/annotator.js';
export { resolveMarkAnchor, type MarkAnchor } from './review/mark-anchor.js';
