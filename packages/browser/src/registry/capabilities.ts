/** Self-describing capability registry — the testable surface the app advertises. */

import { RETICLE_RENDERS_STORE } from '@reticlehq/core';
import { isPresenterVisible } from '../dom/dom-ignore.js';
import { domTestids } from './auto-testids.js';
import { storeNames } from './stores.js';

/**
 * The two halves of the capability report the app no longer has to write down.
 *
 * `testids` and `stores` used to be *declarations* — strings copied into a generated file by `init`
 * and then expected to stay true. Both are now read from the thing they describe: the testids from
 * the DOM, the store names from the registry (which the React adapter fills by discovery). What the
 * app declares is still merged in and still wins nothing away: `signals` and `flows` cannot be
 * observed and remain the app's to state.
 */
function liveTestids(): string[] {
  if ('undefined' === typeof document) return [];
  return domTestids(document);
}

/** Registered stores, minus the ones Reticle registered on the app's behalf. */
function liveStores(): string[] {
  return storeNames().filter((name) => RETICLE_RENDERS_STORE !== name);
}

function union(declared: readonly string[], observed: readonly string[]): string[] {
  const out = [...declared];
  for (const value of observed) if (!out.includes(value)) out.push(value);
  return out;
}

export interface CapabilityFlow {
  name: string;
  steps: string[];
}

export interface Capabilities {
  testids: string[];
  signals: string[];
  stores: string[];
  flows: CapabilityFlow[];
  /**
   * True when Reticle's OWN presenter is visible to snapshots and queries.
   *
   * Present only when the hatch is open, and reported here rather than left implicit, because a
   * verdict drawn against Reticle's own interface is not an ordinary verdict: an agent that can see
   * the impact panel can also assert against it. Anybody reading a result should be able to tell
   * which kind they are holding without going to look at a build config.
   */
  presenterExposed?: boolean;
}

/** What the host app passes to reticle.describe; all fields optional. */
export interface CapabilitiesInput {
  testids?: string[];
  signals?: string[];
  stores?: string[];
  flows?: CapabilityFlow[];
}

// Persist on a global so the registry survives HMR module re-evaluation (matches __reticleAdapters).
const globalStore = globalThis as unknown as { __reticleCapabilities?: Capabilities };

function empty(): Capabilities {
  return { testids: [], signals: [], stores: [], flows: [] };
}

const capabilities: Capabilities = (globalStore.__reticleCapabilities ??= empty());

function mergeUnique(into: string[], add: readonly string[] | undefined): void {
  if (add === undefined) return;
  for (const v of add) if (!into.includes(v)) into.push(v);
}

/**
 * Notified whenever capabilities change, so the SDK can re-announce them to the bridge.
 *
 * `hasCapabilities` rides in the HELLO, which goes out at connect() — and registering deliberately
 * happens AFTER connect, because `registerStore` needs a live SDK to subscribe through. Without a
 * notification, an app that declared its whole testable surface still appeared to the agent as
 * having none, permanently. The hook lives HERE rather than on `reticle.describe` because the
 * documented entry point is this bare function; only wiring `describe` would have fixed the path
 * almost nobody uses.
 */
let onChanged: (() => void) | undefined;

/** Set by the SDK at connect. Idempotent; the last connect wins. */
export function setCapabilitiesListener(cb: (() => void) | undefined): void {
  onChanged = cb;
}

/** Called by the host app via reticle.describe. Merges (idempotent), never replaces wholesale. */
export function registerCapabilities(input: CapabilitiesInput): void {
  mergeUnique(capabilities.testids, input.testids);
  mergeUnique(capabilities.signals, input.signals);
  mergeUnique(capabilities.stores, input.stores);
  if (input.flows !== undefined) {
    for (const flow of input.flows) {
      const existing = capabilities.flows.find((f) => f.name === flow.name);
      if (existing === undefined) {
        capabilities.flows.push({ name: flow.name, steps: [...flow.steps] });
      } else {
        existing.steps = [...flow.steps]; // last writer wins for a named flow
      }
    }
  }
  onChanged?.();
}

/** Snapshot copy of the registered capabilities (defensive — never hand out the live arrays). */
export function getCapabilities(): Capabilities {
  return {
    testids: union(capabilities.testids, liveTestids()),
    signals: [...capabilities.signals],
    stores: union(capabilities.stores, liveStores()),
    flows: capabilities.flows.map((f) => ({ name: f.name, steps: [...f.steps] })),
    // Only when open — an absent field is the ordinary case and should not cost a line in every
    // capabilities payload ever sent.
    ...(isPresenterVisible() ? { presenterExposed: true } : {}),
  };
}

/**
 * Testids the app DECLARED, without the ones merely observed in the DOM.
 *
 * The difference carries meaning the merged list cannot. `knownEmptyState` asks "did the app NAME
 * this element as part of its testable surface?", which is how a zero-match query against
 * `cart-empty-region` is told apart from a broken selector. Every testid on the page is observed, so
 * answering that over the merged list makes it true whenever the page has any testid at all — the
 * same as not asking.
 */
export function declaredTestids(): string[] {
  return [...capabilities.testids];
}

/**
 * Whether the app has a testable surface at all (used in the HELLO flag).
 *
 * Answered over the OBSERVED surface as well as the declared one. It used to be answerable only by
 * declaration, so an app with two hundred testids in its DOM and a live Redux store reported
 * `hasCapabilities: false` until somebody typed those facts into a config file — and the agent
 * reading that flag concluded, correctly by the flag and wrongly in fact, that there was nothing to
 * drive.
 */
export function hasCapabilities(): boolean {
  return (
    capabilities.signals.length > 0 ||
    capabilities.flows.length > 0 ||
    union(capabilities.testids, liveTestids()).length > 0 ||
    union(capabilities.stores, liveStores()).length > 0
  );
}
