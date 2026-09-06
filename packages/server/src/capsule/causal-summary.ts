import { EventType, PerfMetric, isDevToolingUrl, type ReticleEvent } from '@reticlehq/core';
import { routePathOf } from '../events/predicate-route.js';

/**
 * The causal summary (Tier 1) — the bounded ~50–100 token block on EVERY act, green included: what the
 * app did in the act's window, as counts + a headline, not a raw event dump. Diffs come from the
 * storage/state events; attribution from. Pure composition over the attributed event window.
 */
interface StateDiff {
  path: string;
  from: unknown;
  to: unknown;
  /**
   * WHEN this path moved, in the session's elapsed ms.
   *
   * The whole reason a transient was invisible. A store that ends internally consistent can have been
   * inconsistent on the way there, and a from→to pair cannot express that — measured on a real
   * merchant dashboard, an account switch moved `accountId` immediately and `payments` 160 ms later,
   * so for 160 ms the header named one tenant while the rows belonged to another. Both diffs were
   * reported; nothing said they were 160 ms apart, and waiting for the page to settle is by
   * construction waiting for the evidence to disappear. The timestamp was on the event all along.
   */
  atMs: number;
}
interface StorageDiff {
  key: string;
  from?: unknown;
  to?: unknown;
}
export interface CausalSummary {
  /**
   * `total`/`errors` describe the APP's traffic. `ignoredDevTooling` is the count of calls the dev
   * toolchain made about itself (Next's error overlay, HMR, the Vite client — see
   * `DevToolingChannel`), which Reticle deliberately leaves out of the settle decision and out of
   * contradiction hunting. Present only when there were any: a trim is never silent, so an agent can
   * always see that something was ignored and go read it in the timeline.
   */
  net: { total: number; errors: number; ignoredDevTooling?: number; headline?: string };
  consoleErrors: number;
  statePathsChanged: string[];
  storageKeysChanged: string[];
  /** Before→after for each changed store path — the diffs, not just the names. Values capped. */
  stateDiffs: StateDiff[];
  /**
   * How long the store took to stop moving: last state change − first, in ms. Present only when more
   * than one path changed, because with a single change there is no interval to describe.
   *
   * A FACT, not a verdict. Many apps update progressively and that is fine; calling every stagger a
   * defect would make this a noise generator. But a non-zero value is the exact window in which the
   * UI showed a MIXTURE of old and new, and that window is where the tenant-mismatch class of bug
   * lives — so it is stated once, cheaply, and the agent decides.
   */
  stateSettleMs?: number;
  /** Before→after for each changed storage key. Values capped. */
  storageDiffs: StorageDiff[];
  /**
   * How many entries each list dropped to stay within MAX_SUMMARY_ENTRIES. Present only when
   * something was dropped, so a trim is never silent — the same rule `ignoredDevTooling` follows.
   */
  elided?: Partial<Record<CappedList, number>>;
  route?: string;
  signals: string[];
  layoutShift?: number;
  longTasks: number;
  /**
   * TRUE when no store was subscribed, so `statePathsChanged`/`stateDiffs` are empty because nothing
   * was watching — not because the app changed nothing.
   *
   * The two readings are the same empty list, and the wrong one is the one an agent takes: "state
   * did not change" is a claim about the app, and this codebase would rather say "I could not see"
   * than say something confident and wrong. Present only when the channel is dark, so a wired app
   * pays nothing and the field's PRESENCE is what carries the meaning — the same rule
   * `stateSettleMs` and `elided` follow.
   */
  stateUnwatched?: true;
}

/** What only the SESSION knows — level facts the event window cannot contain. See `stateUnwatched`. */
interface SummaryContext {
  stateUnwatched?: boolean;
}

/**
 * THE INVARIANT: every field of this summary has a bounded size that does not depend on how much the
 * app did. A verdict travels in the same payload as its evidence, so an unbounded evidence field is
 * an unbounded chance that the verdict is the part a client truncates — and an agent that cannot read
 * the verdict has run the verification and got nothing, which is indistinguishable from not running
 * it. Measured: one click on a page with a registered TanStack Query store returned ~363KB, because
 * `capValue` bounded each diff and nothing bounded the COUNT of them.
 *
 * 20 keeps the signal that is actually read — the first paths to move, and the settle window over all
 * of them — while the full names of everything that changed stay one `reticle_state` call away.
 */
export const MAX_SUMMARY_ENTRIES = 20;

/** The lists that are capped, named so `elided` can say which one lost entries. */
type CappedList =
  'statePathsChanged' | 'storageKeysChanged' | 'stateDiffs' | 'storageDiffs' | 'signals';

/** Trim one list to the cap and report the loss. Order is arrival order, so the head is the earliest. */
function cap<T>(list: T[], name: CappedList, elided: Partial<Record<CappedList, number>>): T[] {
  if (list.length <= MAX_SUMMARY_ENTRIES) return list;
  elided[name] = list.length - MAX_SUMMARY_ENTRIES;
  return list.slice(0, MAX_SUMMARY_ENTRIES);
}

function pushUnique(list: string[], value: unknown): void {
  if ('string' === typeof value && value.length > 0 && !list.includes(value)) list.push(value);
}

/** Keep a diff value bounded so the per-act summary never bloats: primitives capped to a short string. */
const MAX_DIFF_LEN = 140;
/** Truncate to at most MAX_DIFF_LEN chars total, including the ellipsis marker. */
function truncate(text: string): string {
  return text.length > MAX_DIFF_LEN ? `${text.slice(0, MAX_DIFF_LEN - 1)}…` : text;
}
function capValue(value: unknown): unknown {
  if (value === undefined || null === value) return value;
  if ('string' === typeof value) return truncate(value);
  if ('number' === typeof value || 'boolean' === typeof value) return value;
  // Objects/arrays: a shallow, length-capped JSON repr (never a deep dump on the hot path).
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

/**
 * The span over which the store was still moving — and therefore possibly self-inconsistent.
 *
 * Omitted for 0 or 1 diffs (no interval) and for a spread of 0 (everything landed in one tick), so a
 * store that updates atomically pays nothing and the field's PRESENCE is what carries the meaning.
 */
function stateSettle(diffs: readonly StateDiff[]): { stateSettleMs?: number } {
  if (diffs.length < 2) return {};
  const times = diffs.map((d) => d.atMs);
  const spread = Math.max(...times) - Math.min(...times);
  return spread > 0 ? { stateSettleMs: spread } : {};
}

export function causalSummary(
  events: readonly ReticleEvent[],
  context: SummaryContext = {},
): CausalSummary {
  let netTotal = 0;
  let netErrors = 0;
  let ignoredDevTooling = 0;
  let headline: string | undefined;
  let consoleErrors = 0;
  const statePathsChanged: string[] = [];
  const storageKeysChanged: string[] = [];
  const stateDiffs: StateDiff[] = [];
  const storageDiffs: StorageDiff[] = [];
  let route: string | undefined;
  const signals: string[] = [];
  let layoutShift: number | undefined;
  let longTasks = 0;

  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case EventType.NET_REQUEST: {
        if (isDevToolingUrl('string' === typeof data['url'] ? data['url'] : undefined)) {
          ignoredDevTooling += 1;
          break;
        }
        netTotal += 1;
        const status = data['status'];
        const failed = false === data['ok'] || ('number' === typeof status && status >= 400);
        if (failed) {
          netErrors += 1;
          // Headline is the first failing request — the thing most worth the agent's eye.
          headline ??= `${String(data['method'])} ${String(data['url'])} ${String(status)}`;
        }
        break;
      }
      case EventType.CONSOLE_ERROR:
      case EventType.ERROR_UNCAUGHT:
        consoleErrors += 1;
        break;
      case EventType.STATE_CHANGE: {
        pushUnique(statePathsChanged, data['name']);
        // The subscribed-store observer emits { name, path, value, old } — `value` is the AFTER side
        // (`new` is accepted too for any producer that uses it). Presence of either makes it a real
        // before→after diff rather than a bare reading.
        const path = 'string' === typeof data['path'] ? data['path'] : data['name'];
        const hasAfter = 'value' in data || 'new' in data;
        if ('string' === typeof path && path.length > 0 && ('old' in data || hasAfter)) {
          const after = 'value' in data ? data['value'] : data['new'];
          stateDiffs.push({
            path,
            from: capValue(data['old']),
            to: capValue(after),
            atMs: event.t,
          });
        }
        break;
      }
      case EventType.STORAGE_CHANGE: {
        pushUnique(storageKeysChanged, data['key']);
        const key = data['key'];
        if ('string' === typeof key && key.length > 0) {
          storageDiffs.push({ key, from: capValue(data['old']), to: capValue(data['new']) });
        }
        break;
      }
      case EventType.ROUTE_CHANGE:
        // The ROUTER's path. Reporting the document pathname left `route: "/"` on every action of a
        // hash-routed app — the same reading that made a route predicate unsatisfiable there, and an
        // agent reasoning off this field would conclude the route never changed. See routePathOf.
        if ('string' === typeof data['pathname']) {
          route = routePathOf(
            data['pathname'],
            'string' === typeof data['hash'] ? data['hash'] : '',
          );
        }
        break;
      case EventType.SIGNAL:
        pushUnique(signals, data['name']);
        break;
      case EventType.PERF:
        if (data['metric'] === PerfMetric.CLS && 'number' === typeof data['value']) {
          layoutShift = Math.max(layoutShift ?? 0, data['value']);
        } else if (data['metric'] === PerfMetric.LONGTASK) {
          longTasks += 1;
        }
        break;
      default:
        break;
    }
  }

  const elided: Partial<Record<CappedList, number>> = {};
  // `stateSettleMs` is computed over EVERY diff, before the cap: the interval is a fact about the
  // store, and shrinking it because the evidence was trimmed would make the transient window read as
  // narrower than it was — the one number here that must survive the trim intact.
  const settle = stateSettle(stateDiffs);
  return {
    net: {
      total: netTotal,
      errors: netErrors,
      ...(0 === ignoredDevTooling ? {} : { ignoredDevTooling }),
      ...(headline === undefined ? {} : { headline }),
    },
    consoleErrors,
    statePathsChanged: cap(statePathsChanged, 'statePathsChanged', elided),
    storageKeysChanged: cap(storageKeysChanged, 'storageKeysChanged', elided),
    stateDiffs: cap(stateDiffs, 'stateDiffs', elided),
    ...settle,
    storageDiffs: cap(storageDiffs, 'storageDiffs', elided),
    ...(route === undefined ? {} : { route }),
    signals: cap(signals, 'signals', elided),
    ...(0 === Object.keys(elided).length ? {} : { elided }),
    ...(layoutShift === undefined ? {} : { layoutShift }),
    longTasks,
    ...(true === context.stateUnwatched ? { stateUnwatched: true as const } : {}),
  };
}
