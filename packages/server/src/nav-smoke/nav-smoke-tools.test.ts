import { describe, expect, it } from 'vitest';
import {
  EventType,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { NAV_SMOKE_TOOLS } from './nav-smoke-tools.js';
import { NavSmokeSkipReason, type NavSmokeReport } from './nav-smoke.js';
import type { Session, SessionManager } from '../session/session.js';

function tool(name: string): ToolDef {
  const found = TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const navSmokeAction = (deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> =>
  tool(ReticleTool.VERIFY).handler(deps, { ...args, action: 'nav_smoke' });

function ok(result: unknown): Promise<CommandResult> {
  return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
}

describe('reticle_nav_smoke tool', () => {
  it('walks internal nav links and reports honest per-route rows', async () => {
    let clock = 0;
    const buffer: ReticleEvent[] = [];
    const session = {
      id: 'demo',
      url: 'http://localhost:3000/dashboard',
      elapsed: () => clock,
      eventsSince: (since: number) => buffer.filter((event) => event.t > since),
      command: (name: string, args?: Record<string, unknown>) => {
        if (name === ReticleCommand.QUERY) {
          expect(args?.['by']).toBe(QueryBy.ROLE);
          expect(args?.['value']).toBe('link');
          expect(args?.['scope']).toBe('nav');
          return ok({
            count: 2,
            elements: [
              { ref: 'e1', name: 'Tickets', attrs: { href: '/tickets' } },
              { ref: 'e2', name: 'Team', attrs: { href: '/team' } },
            ],
          });
        }
        if (name === ReticleCommand.ACT) {
          clock += 1;
          const href = 'e1' === args?.['ref'] ? '/tickets' : '/team';
          buffer.push({
            t: clock,
            type: EventType.ROUTE_CHANGE,
            sessionId: 'demo',
            data: { pathname: href },
          });
          return ok({ dispatched: true });
        }
        return ok({});
      },
    } as unknown as Session;

    const routes: string[] = [];
    const deps = {
      sessions: { resolve: () => session } as SessionManager,
      project: { recordRoutes: (next: readonly string[]) => Promise.resolve(routes.push(...next)) },
    } as unknown as ToolDeps;

    const report = (await navSmokeAction(deps, { settleMs: 0 })) as NavSmokeReport;
    expect(report.linksFound).toBe(2);
    expect(report.linksVisited).toBe(2);
    expect(report.rows).toEqual([
      {
        label: 'Tickets',
        href: '/tickets',
        route: '/tickets',
        renderedWithoutConsoleErrors: true,
        consoleErrors: 0,
      },
      {
        label: 'Team',
        href: '/team',
        route: '/team',
        renderedWithoutConsoleErrors: true,
        consoleErrors: 0,
      },
    ]);
    expect(report.note).toContain('not that the route or feature works');
    expect(routes).toEqual(['/dashboard', '/tickets', '/team']);
  });

  it('marks a row false when console errors land in the settle window', async () => {
    let clock = 0;
    const buffer: ReticleEvent[] = [];
    const session = {
      id: 'demo',
      url: 'http://localhost:3000/',
      elapsed: () => clock,
      eventsSince: (since: number) => buffer.filter((event) => event.t > since),
      command: (name: string) => {
        if (name === ReticleCommand.QUERY) {
          return ok({
            count: 1,
            elements: [{ ref: 'e1', name: 'Broken', attrs: { href: '/broken' } }],
          });
        }
        if (name === ReticleCommand.ACT) {
          clock += 1;
          buffer.push({
            t: clock,
            type: EventType.CONSOLE_ERROR,
            sessionId: 'demo',
            data: { message: 'boom' },
          });
          return ok({ dispatched: true });
        }
        return ok({});
      },
    } as unknown as Session;

    const deps = {
      sessions: { resolve: () => session } as SessionManager,
      project: { recordRoutes: () => Promise.resolve() },
    } as unknown as ToolDeps;

    const report = (await navSmokeAction(deps, { settleMs: 0 })) as NavSmokeReport;
    expect(report.rows[0]).toMatchObject({
      label: 'Broken',
      renderedWithoutConsoleErrors: false,
      consoleErrors: 1,
    });
  });

  it('skips external and duplicate hrefs without clicking them', async () => {
    let acted = 0;
    const session = {
      id: 'demo',
      url: 'http://localhost:3000/',
      elapsed: () => 0,
      eventsSince: () => [],
      command: (name: string, args?: Record<string, unknown>) => {
        if (name === ReticleCommand.QUERY) {
          return ok({
            count: 3,
            elements: [
              { ref: 'e1', name: 'Docs', attrs: { href: 'https://example.test/docs' } },
              { ref: 'e2', name: 'Home', attrs: { href: '/' } },
              { ref: 'e3', name: 'Home duplicate', attrs: { href: '/' } },
            ],
          });
        }
        if (name === ReticleCommand.ACT) {
          acted += 1;
          expect(args?.['ref']).toBe('e2');
          return ok({ dispatched: true });
        }
        throw new Error(`unexpected command: ${name}`);
      },
    } as unknown as Session;

    const deps = {
      sessions: { resolve: () => session } as SessionManager,
      project: { recordRoutes: () => Promise.resolve() },
    } as unknown as ToolDeps;

    const report = (await navSmokeAction(deps, { settleMs: 0 })) as NavSmokeReport;
    expect(acted).toBe(1);
    expect(report.linksVisited).toBe(1);
    expect(report.rows[0]).toMatchObject({
      label: 'Home',
      href: '/',
      renderedWithoutConsoleErrors: true,
      consoleErrors: 0,
    });
    expect(report.rows.find((row) => row.skipped === NavSmokeSkipReason.EXTERNAL_HREF)?.label).toBe(
      'Docs',
    );
    expect(
      report.rows.find((row) => row.skipped === NavSmokeSkipReason.DUPLICATE_HREF)?.label,
    ).toBe('Home duplicate');
  });

  it('is registered on the merged reticle_verify surface', () => {
    const found = NAV_SMOKE_TOOLS.find((entry) => entry.name === ReticleTool.NAV_SMOKE);
    expect(found).toBeDefined();
    expect(tool(ReticleTool.VERIFY).inputSchema).toHaveProperty('action');
  });
});
