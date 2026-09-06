/**
 * A recorded flow that backtracks across pages cannot replay.
 *
 * The recorder stores clicks, not navigations. A drive that opens a product and then returns to
 * search saves both clicks; replay lands on the product page and looks for a control that only
 * exists on search. That shape is visible from the route list with no change to the flow file, so
 * stop/save can warn instead of writing a flow that fails on the next click.
 */
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { routePathOf } from '../events/predicate-route.js';

function asString(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

/**
 * The page a recording step sat on, comparable across path routers and hash routers.
 *
 * A startPath is stored as pathname+hash (`/#/search`); a ROUTE_CHANGE carries them separately.
 * Without this, every hash-router page compares as `/` and a backtrack is invisible.
 */
export function recordingRouteOf(pathname: string, hash = ''): string {
  const hashIdx = pathname.indexOf('#/');
  if (hashIdx >= 0) {
    return routePathOf(pathname.slice(0, hashIdx) || '/', pathname.slice(hashIdx));
  }
  const fragment = hash.startsWith('#') ? hash : 0 === hash.length ? '' : `#${hash}`;
  if (fragment.startsWith('#/'))
    return routePathOf(0 === pathname.length ? '/' : pathname, fragment);
  return pathname;
}

function collapseConsecutive(routes: readonly string[]): string[] {
  const out: string[] = [];
  for (const route of routes) {
    if (0 === route.length) continue;
    if (out.at(-1) === route) continue;
    out.push(route);
  }
  return out;
}

/**
 * Warn when the journey left a page and came back. Linear A→B→C is silent: that still cannot
 * replay either if a later click needs a previous page, but the reported failure is specifically
 * the backtrack, and inventing a warning for every multi-page drive would teach agents to ignore it.
 */
export function recordingBacktrackWarning(routes: readonly string[]): string | undefined {
  const path = collapseConsecutive(routes);
  const seen = new Set<string>();
  for (const route of path) {
    if (seen.has(route)) {
      return (
        `this recording returned to ${route} after leaving it — replay has no navigation steps, so ` +
        'the next click looks for a control that only exists on a page the tab is no longer on. ' +
        `Journey: ${path.join(' → ')}. Split into one flow per page, or record the control that navigates back.`
      );
    }
    seen.add(route);
  }
  return undefined;
}

/** Ordered pages the recording sat on, startPath first, consecutive stays collapsed. */
export function routesFromRecording(
  startPath: string | undefined,
  events: readonly ReticleEvent[],
): string[] {
  const raw: string[] = [];
  if (undefined !== startPath) raw.push(recordingRouteOf(startPath));
  for (const event of events) {
    if (EventType.ROUTE_CHANGE !== event.type) continue;
    const pathname = asString(event.data['pathname']) ?? asString(event.data['to']);
    if (undefined === pathname) continue;
    raw.push(recordingRouteOf(pathname, asString(event.data['hash']) ?? ''));
  }
  return collapseConsecutive(raw);
}
