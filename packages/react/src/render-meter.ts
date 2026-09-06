/**
 * React render meter — counts commits the way React DevTools does, via the global
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` callback (one call per committed render). This is
 * the Reticle-only perf signal: Playwright/DevTools-MCP cannot observe a single React render, so a page
 * that is thrashing (committing many times a second) while the DOM stays visually identical — a
 * wasted-render storm — looks idle to them. Reticle sees the commit rate.
 *
 * Exposed as a registered store (`__reticle_renders`) so it reads through the normal `reticle_state` path —
 * no new wire surface. Total commits is the robust, version-tolerant signal; we deliberately do NOT
 * attribute per-component (React clears the per-fiber work flags during commit, before this fires, so
 * a post-commit walk can't reliably tell which component re-rendered without the profiler build).
 *
 * HOST-SAFE BY CONSTRUCTION: everything is wrapped in try/catch and React itself guards its calls to
 * the devtools hook in try/catch, so a fault here can never break the host app's rendering. If a real
 * React DevTools hook is already present we AUGMENT it (call the original too); otherwise we install a
 * complete minimal hook. MUST be installed before `react-dom` initializes (React reads the hook at
 * renderer-inject time) — import this as the first side-effect in the app entry, before React.
 */
import { RETICLE_RENDER_PREHOOK, RETICLE_RENDERS_STORE } from '@reticlehq/core';
import { registerStore } from '@reticlehq/browser';
import { HYDRATION_COMPLETE_SIGNAL, createHydrationTracker } from './hydration.js';
import { createCommitAggregator } from './commit-aggregator.js';
import { autoRegisterStores } from './auto-stores.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const RENDER_STORE = RETICLE_RENDERS_STORE;

// Fire the hydration-complete signal (once, on the first commit) via the SDK instance if it is present.
// Structural access avoids importing the whole Reticle type into this tooling module.
const hydration = createHydrationTracker(() => {
  const instance = (globalThis as { __reticleInstance?: { signal?: (name: string) => void } })
    .__reticleInstance;
  instance?.signal?.(HYDRATION_COMPLETE_SIGNAL);
});

// Access the SDK instance structurally (avoids importing the whole Reticle type into this tooling module).
function reticleInstance(): { renderCommit?: (n: number) => void } | undefined {
  return (globalThis as { __reticleInstance?: { renderCommit?: (n: number) => void } })
    .__reticleInstance;
}

// Emit the render stream as aggregated RENDER_COMMIT events, throttled to one flush per frame so a commit
// storm is one event of magnitude N, never a per-render flood. requestAnimationFrame when available.
const commitStream = createCommitAggregator({
  schedule: (fn) => {
    if ('function' === typeof requestAnimationFrame) requestAnimationFrame(() => fn());
    else setTimeout(fn, 16);
  },
  flush: (n) => reticleInstance()?.renderCommit?.(n),
});

/**
 * How many commits to keep looking for providers over.
 *
 * Discovery has to happen AFTER a commit — at install time the tree is empty and there is nothing to
 * find — and it cannot be a one-shot on the first commit either, because a provider can mount late
 * (a lazy route, a QueryClient created in an effect). A handful of attempts covers both without
 * turning a walk of the whole fiber tree into a per-commit cost for the life of the session.
 */
const DISCOVERY_COMMITS = 10;

/**
 * Counted separately from `commits`, which is seeded from the pre-hook's total and reset by
 * `resetRenderMeter`. Either would have decided how many discovery attempts we get on grounds that
 * have nothing to do with discovery — a page that had already committed 50 times before `install()`
 * ran would have got none at all.
 */
let discoveryAttempts = 0;

/** One React commit: bump the counter, fire hydration on the first, and feed the throttled stream. */
function onReactCommit(): void {
  commits += 1;
  hydration.onCommit();
  commitStream.onCommit();
  if (discoveryAttempts < DISCOVERY_COMMITS && 'undefined' !== typeof document) {
    discoveryAttempts += 1;
    // Never allowed to break a render: this runs inside React's own commit callback.
    try {
      autoRegisterStores(document);
    } catch {
      /* discovery is a bonus, not a contract */
    }
  }
}

interface DevtoolsHook {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (renderer: unknown) => number;
  onScheduleFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberRoot?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
}

let commits = 0;

/**
 * Take over a count that started before this module existed.
 *
 * The pre-hook has been counting since page parse; discarding that and starting at zero would report
 * a freshly-loaded app as having rendered nothing, which is the same "empty vs unseen" confusion the
 * rest of this layer refuses to make.
 */
function seedCommits(prior: number): void {
  if (Number.isFinite(prior) && prior > commits) commits = prior;
}
let installed = false;

function noop(): void {
  /* React calls these; a no-op keeps a freshly-installed hook complete. */
}

/** The render stats surfaced via the `__reticle_renders` store (read with reticle_state). */
export interface RenderStats {
  /** Total React commits observed since install (monotonic; diff over a window for a rate). */
  commits: number;
}

export function getRenderStats(): RenderStats {
  return { commits };
}

/** Reset the commit counter — call before a measured window so the count is window-scoped. */
export function resetRenderMeter(): void {
  commits = 0;
}

/**
 * Install (or augment) the React commit hook + register the `__reticle_renders` store. Idempotent and
 * never throws. Call BEFORE react-dom loads.
 */
export function installRenderMeter(): void {
  if (installed) return;
  installed = true;
  try {
    const root = globalThis as unknown as Record<string, DevtoolsHook | undefined>;
    // Adopt the pre-hook if the Vite plugin installed one.
    //
    // Installing the hook from here is a race this module cannot win under the plugin's auto-inject:
    // it arrives as a module script, which runs after the app's entry, and React reads the hook when
    // react-dom evaluates. The pre-hook runs during parse instead and has been counting since then —
    // so the honest thing is to take its numbers rather than start from zero and report a quiet page.
    const pre = (globalThis as Record<string, unknown>)[RETICLE_RENDER_PREHOOK] as
      { commits: number; sinks: ((...args: unknown[]) => void)[] } | undefined;
    if (pre !== undefined) {
      seedCommits(pre.commits);
      pre.sinks.push(onReactCommit);
      registerStore(RENDER_STORE, () => getRenderStats());
      return;
    }
    const existing = root[HOOK_KEY];
    if (existing === undefined) {
      root[HOOK_KEY] = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onScheduleFiberRoot: noop,
        onCommitFiberRoot: onReactCommit,
        onPostCommitFiberRoot: noop,
        onCommitFiberUnmount: noop,
      };
    } else {
      const original =
        'function' === typeof existing.onCommitFiberRoot
          ? existing.onCommitFiberRoot.bind(existing)
          : undefined;
      existing.onCommitFiberRoot = (...args: unknown[]) => {
        onReactCommit();
        if (original !== undefined) {
          try {
            original(...args);
          } catch {
            /* a real DevTools hook faulting must not be our problem */
          }
        }
      };
    }
    registerStore(RENDER_STORE, () => getRenderStats());
  } catch {
    /* never break the host app */
  }
}
