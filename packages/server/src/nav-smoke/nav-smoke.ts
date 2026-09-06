import {
  ActionType,
  EventType,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { routeFromUrl, routesFromEvents } from '../project/learned-routes.js';
import { ReticleTool } from '../tools/tool-names.js';
import { asRecord, asString } from '../tools/tools-helpers.js';

/** Bounds so a nav smoke always terminates and each click has time to settle. */
export const NAV_SMOKE_DEFAULTS = {
  /** Max internal nav links clicked in one run (then `truncated:true`). */
  MAX_LINKS: 25,
  /** ms to wait for a click's reaction to land in the buffer before classifying. */
  SETTLE_MS: 300,
  /** Default scope: links inside a `<nav>` landmark. */
  SCOPE: 'nav',
} as const;

/** Why a discovered link was not clicked. */
export const NavSmokeSkipReason = {
  EXTERNAL_HREF: 'external-href',
  DUPLICATE_HREF: 'duplicate-href',
  MISSING_HREF: 'missing-href',
} as const;

export const NAV_SMOKE_HONESTY_NOTE =
  'each row only proves the destination rendered without new console errors in the settle window — not that the route or feature works';

export interface NavSmokeRow {
  label: string;
  href?: string;
  route?: string;
  renderedWithoutConsoleErrors: boolean;
  consoleErrors: number;
  skipped?: string;
}

export interface NavSmokeReport {
  linksFound: number;
  linksVisited: number;
  rows: NavSmokeRow[];
  truncated: boolean;
  note: string;
  scopeMissing?: boolean;
}

export interface NavSmokeOptions {
  maxLinks?: number;
  settleMs?: number;
  scope?: string;
}

export type NavSmokeSleep = (ms: number) => Promise<void>;

/** The slice of Session nav smoke needs — tests inject a fake without a live browser. */
export interface NavSmokeSession {
  url: string;
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  elapsed(): number;
  eventsSince(cursor: number): ReticleEvent[];
  beginAction?(tool: string, args: Record<string, unknown>): void;
  finishAction?(error?: string, settled?: boolean, settleMs?: number): void;
}

interface NavLinkCandidate {
  ref: string;
  name: string;
  href?: string;
  skip?: string;
}

function isConsoleError(event: ReticleEvent): boolean {
  return event.type === EventType.CONSOLE_ERROR || event.type === EventType.ERROR_UNCAUGHT;
}

function parseQueryElements(result: unknown): NavLinkCandidate[] {
  const elements = asRecord(result)['elements'];
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((entry) => {
    const item = asRecord(entry);
    const ref = asString(item['ref']);
    if (ref === undefined) return [];
    const name = asString(item['name']) ?? '';
    const href = asString(asRecord(item['attrs'])['href']);
    return [{ ref, name, ...(href === undefined ? {} : { href }) }];
  });
}

function isSameOrigin(baseUrl: string, href: string): boolean {
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(href, base);
    return resolved.origin === base.origin;
  } catch {
    return false;
  }
}

function normalizeHref(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function latestRoute(events: readonly ReticleEvent[], fallbackUrl: string): string | undefined {
  const routes = routesFromEvents(events);
  const last = routes.at(-1);
  if (last !== undefined) return last;
  return routeFromUrl(fallbackUrl);
}

function classifyLinks(baseUrl: string, elements: NavLinkCandidate[]): NavLinkCandidate[] {
  const seen = new Set<string>();
  const out: NavLinkCandidate[] = [];
  for (const element of elements) {
    if (element.href === undefined) {
      out.push({ ...element, skip: NavSmokeSkipReason.MISSING_HREF });
      continue;
    }
    if (!isSameOrigin(baseUrl, element.href)) {
      out.push({ ...element, skip: NavSmokeSkipReason.EXTERNAL_HREF });
      continue;
    }
    const key = normalizeHref(baseUrl, element.href);
    if (seen.has(key)) {
      out.push({ ...element, skip: NavSmokeSkipReason.DUPLICATE_HREF });
      continue;
    }
    seen.add(key);
    out.push(element);
  }
  return out;
}

function rowFromSkipped(link: NavLinkCandidate): NavSmokeRow {
  return {
    label: link.name,
    ...(link.href === undefined ? {} : { href: link.href }),
    renderedWithoutConsoleErrors: false,
    consoleErrors: 0,
    ...(link.skip === undefined ? {} : { skipped: link.skip }),
  };
}

/** Walk primary nav links and report one honest row per destination. */
export async function navSmoke(
  session: NavSmokeSession,
  opts: NavSmokeOptions,
  sleep: NavSmokeSleep,
): Promise<NavSmokeReport> {
  const maxLinks = opts.maxLinks ?? NAV_SMOKE_DEFAULTS.MAX_LINKS;
  const settleMs = opts.settleMs ?? NAV_SMOKE_DEFAULTS.SETTLE_MS;
  const scope = opts.scope ?? NAV_SMOKE_DEFAULTS.SCOPE;

  const queryResult = await session.command(ReticleCommand.QUERY, {
    by: QueryBy.ROLE,
    value: 'link',
    scope,
    attrs: ['href'],
    limit: maxLinks * 2,
  });

  if (!queryResult.ok) {
    return {
      linksFound: 0,
      linksVisited: 0,
      rows: [],
      truncated: false,
      note: queryResult.error ?? 'query failed',
    };
  }

  const payload = asRecord(queryResult.result);
  const scopeMissing = true === payload['scopeMissing'];
  const elements = parseQueryElements(queryResult.result);
  const count = payload['count'];
  const linksFound = 'number' === typeof count ? count : elements.length;
  const classified = classifyLinks(session.url, elements);
  const clickable = classified.filter((link) => link.skip === undefined);
  const skipped = classified.filter((link) => link.skip !== undefined);
  const toVisit = clickable.slice(0, maxLinks);

  const rows: NavSmokeRow[] = [];

  for (const link of toVisit) {
    const since = session.elapsed();
    session.beginAction?.(ReticleTool.NAV_SMOKE, { ref: link.ref, action: ActionType.CLICK });
    let actOk = false;
    try {
      const actResult = await session.command(ReticleCommand.ACT, {
        ref: link.ref,
        action: ActionType.CLICK,
      });
      await sleep(settleMs);
      actOk = true === actResult.ok;
    } finally {
      session.finishAction?.();
    }

    const events = session.eventsSince(since);
    const consoleErrors = events.filter(isConsoleError).length;
    const route = latestRoute(events, session.url);
    rows.push({
      label: link.name,
      ...(link.href === undefined ? {} : { href: link.href }),
      ...(route === undefined ? {} : { route }),
      renderedWithoutConsoleErrors: actOk && 0 === consoleErrors,
      consoleErrors,
    });
  }

  for (const link of skipped) rows.push(rowFromSkipped(link));

  return {
    linksFound,
    linksVisited: toVisit.length,
    rows,
    truncated: clickable.length > maxLinks,
    note: NAV_SMOKE_HONESTY_NOTE,
    ...(scopeMissing ? { scopeMissing: true } : {}),
  };
}
