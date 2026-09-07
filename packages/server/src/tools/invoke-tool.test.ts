import { beforeEach, describe, expect, it } from 'vitest';
import { SessionState, UNSCRIPTABLE_TAB_RECOMMENDATION, TRANSPORT_LIMITS } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { EnvelopeKey } from './tool-kit.js';
import { getSessionMetrics, resetSessionMetrics } from '../telemetry/session-metrics.js';
import { buildDynamicTools } from './dynamic-tools.js';
import { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './invoke-tool.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

const ROOT = '/tmp/reticle-invoke-test/.reticle';
const now = (): number => 0;

/** A throttled fake session (complete enough to drive real read-only handlers) whose health
 * carries the un-scriptable recommendation. */
function throttledSession(overrides: Partial<Session> = {}): Session {
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    command: () => Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    blindSpots: () => ({}),
    health: () => ({
      lastSeenMs: 99_999,
      throttled: true,
      focused: false,
      recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
    }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
    ...overrides,
  };
  return stub as Session;
}

function fakeDeps(session: Session = throttledSession()): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const fs = createNodeFileSystem();
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
  };
}

/** A minimal ToolDef wrapping a fixed return value, named so it lands in the bound/exempt set. */
function stubTool(name: string, returns: unknown): ToolDef {
  return { name, description: '', inputSchema: {}, handler: () => Promise.resolve(returns) };
}

describe('runTool — universal session-health invariant', () => {
  it('1: splices health onto a session-bound tool returning a plain object', async () => {
    const r = (await runTool(stubTool(ReticleTool.ACT, { ok: true }), fakeDeps(), {})) as {
      session?: { throttled?: boolean; recommendation?: string };
    };
    expect(r.session?.throttled).toBe(true);
    expect(r.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('2: does NOT add health to an exempt (disk/lifecycle) tool', async () => {
    const r = (await runTool(stubTool(ReticleTool.PROJECT, { ok: true }), fakeDeps(), {})) as {
      session?: unknown;
    };
    expect('session' in r).toBe(false);
  });

  it('3: is idempotent — a handler that already added session is left untouched', async () => {
    const existing = { ok: true, session: { throttled: false, lastSeenMs: 1 } };
    const r = (await runTool(stubTool(ReticleTool.ACT, existing), fakeDeps(), {})) as {
      session: { throttled: boolean };
    };
    expect(r.session.throttled).toBe(false); // not overwritten
  });

  it('4: never corrupts a non-object result (array / primitive pass through)', async () => {
    const name = ReticleTool.ACT;
    expect(await runTool(stubTool(name, [1, 2, 3]), fakeDeps(), {})).toEqual([1, 2, 3]);
    expect(await runTool(stubTool(name, 42), fakeDeps(), {})).toBe(42);
  });

  it('5: STRUCTURAL GUARD — every sessionId-bearing tool is classified bound XOR exempt', () => {
    const overlap = [...SESSION_BOUND_TOOLS].filter((n) => SESSION_EXEMPT_TOOLS.has(n));
    expect(overlap).toEqual([]); // a tool may not be in both sets
    for (const tool of TOOLS) {
      const hasSessionId = Object.keys(tool.inputSchema).includes('sessionId');
      if (!hasSessionId) continue;
      const classified = SESSION_BOUND_TOOLS.has(tool.name) || SESSION_EXEMPT_TOOLS.has(tool.name);
      expect(classified, `${tool.name} carries sessionId but is neither bound nor exempt`).toBe(
        true,
      );
    }
  });

  it('5b: lease + age-warning are spliced even when the handler already returned a session block', async () => {
    // A throttled/backgrounded tab's handler returns its own `session` health — this must NOT skip
    // the one-time lease reminder + age cleanup nudge (the long-running leak case).
    const lease = { sessionId: 'demo', opened_at: 0, IMPORTANT: 'release when done' };
    const session = throttledSession({
      takeSessionLease: () => lease,
      ageWarning: () => 'age-note',
    });
    const handlerResult = { ok: true, session: { throttled: false, lastSeenMs: 1 } };
    const r = (await runTool(
      stubTool(ReticleTool.ACT, handlerResult),
      fakeDeps(session),
      {},
    )) as Record<string, unknown>;
    expect(r['session_lease']).toEqual(lease);
    expect(r['session_age_warning']).toBe('age-note');
    expect((r['session'] as { throttled: boolean }).throttled).toBe(false); // handler's health kept
  });

  it('6: every name in the bound/exempt sets is a real tool (no dangling names)', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const n of [...SESSION_BOUND_TOOLS, ...SESSION_EXEMPT_TOOLS])
      expect(all.has(n)).toBe(true);
  });

  it('8: touches the AUTO-SELECTED session lease when sessionId is omitted (not the raw undefined arg)', async () => {
    // The leak: with no sessionId the raw arg is undefined, so pool.touch was skipped — yet the handler
    // auto-selects and drives a real leased session, whose lease then never refreshes and the reaper can
    // reclaim it mid-drive. Touch must target the RESOLVED session id.
    const touched: string[] = [];
    const session = throttledSession({ id: 'auto-picked' });
    const deps = fakeDeps(session);
    (deps as { pool?: { touch(id: string): void } }).pool = {
      touch: (id: string) => touched.push(id),
    };
    await runTool(stubTool(ReticleTool.ACT, { ok: true }), deps, {}); // no sessionId
    expect(touched).toEqual(['auto-picked']);
  });

  it('7: real handlers — previously-bare tools now carry health through runTool', async () => {
    const deps = fakeDeps();
    const tool = (name: string): ToolDef => {
      const t = TOOLS.find((x) => x.name === name);
      if (t === undefined) throw new Error(`no tool ${name}`);
      return t;
    };
    for (const name of ['reticle_network', 'reticle_console', 'reticle_state']) {
      const r = (await runTool(tool(name), deps, {})) as { session?: { throttled?: boolean } };
      expect(r.session?.throttled, `${name} should carry health`).toBe(true);
    }
  });
});

/**
 * The escape hatch must carry the same envelope as the front door.
 *
 * Reported: `reticle_console { sessionId }` returned a `session_lease` block and
 * `reticle_run { tool: "reticle_console", sessionId }` did not — measured back to back on one
 * session. Under the default profile `reticle_run` is the ONLY way to reach an unadvertised tool,
 * so an agent driving through the hatch would be exactly the one never told it is holding the
 * human's page, and the HUD would read "live" until the session timed out. `reticle_run` is 111 of
 * 1049 tool calls in a day, so it is not a rare path.
 *
 * The premise turned out to be wrong — see the second test — but the guard the report asked for is
 * worth having either way: it is a decorator applied at one layer and two call paths through it,
 * which is a shape that WILL drift the next time something is spliced onto only one of them.
 */
describe('reticle_run carries the same session envelope as a direct call', () => {
  const LEASE = { sessionId: 'demo', opened_at: 0, IMPORTANT: 'release when done' };

  /**
   * Driven through the REAL `reticle_run` handler, not through a hand-rolled `runTool(target, …)`
   * that models what it does. The whole defect class here is "a decorator applied at one layer, two
   * call paths through it", so a test that reimplements the second path would only ever confirm my
   * reading of it.
   */
  for (const toolName of [ReticleTool.ACT, ReticleTool.QUERY, ReticleTool.SNAPSHOT]) {
    it(`${toolName} via reticle_run still gets session_lease`, async () => {
      const session = throttledSession({ takeSessionLease: () => LEASE });
      const target = stubTool(toolName, { ok: true });
      const run = buildDynamicTools([target]).find((t) => t.name === ReticleTool.RUN);
      expect(run, 'reticle_run is not on the dynamic surface').toBeDefined();
      const r = (await run?.handler(fakeDeps(session), { tool: toolName })) as Record<
        string,
        unknown
      >;
      expect(
        r['session_lease'],
        `${toolName} reached through reticle_run lost the lease reminder`,
      ).toEqual(LEASE);
    });
  }

  /**
   * Why the original report saw what it saw. `takeSessionLease()` is fire-once per session
   * (`session.ts:610` — `#firstCommandDone`), so measuring a direct call and then a `reticle_run`
   * call back to back on ONE session will always show the block on the first and never the second,
   * whichever order they run in. The path was never dropping it.
   */
  it('the lease is fire-once per session, which is what the back-to-back measurement showed', async () => {
    let taken = false;
    const session = throttledSession({
      takeSessionLease: () => {
        if (taken) return undefined;
        taken = true;
        return LEASE;
      },
    });
    const deps = fakeDeps(session);
    const first = (await runTool(stubTool(ReticleTool.QUERY, { ok: true }), deps, {})) as Record<
      string,
      unknown
    >;
    const second = (await runTool(stubTool(ReticleTool.QUERY, { ok: true }), deps, {})) as Record<
      string,
      unknown
    >;
    expect(first['session_lease']).toEqual(LEASE);
    expect(
      second['session_lease'],
      'a second call getting no lease is correct — it is once per session, not once per call',
    ).toBeUndefined();
  });
});

/**
 * An oversized argument must be REFUSED, not deserialised and acted on.
 *
 * `tool-fuzz-test` failed CI on the invariant that matters most — `every tool answers every hostile
 * call` — for `reticle_replay/huge-string`, a ~100KB argument. Seen twice with different tools; the
 * earlier one came back `-32001 … sse_aborted` with the tool surface dropping 48→17 afterwards,
 * which is a RESTARTED daemon. So the shape is: oversized argument → the daemon dies → the proxy
 * answers the in-flight call with transport loss, and the fuzz's next assertion is talking to a
 * different daemon.
 *
 * An unanswered call is a hung agent, and it is the one failure the whole transport layer is shaped
 * around. `TRANSPORT_LIMITS.MAX_STRING_LENGTH` already bounds what crosses the BRIDGE, but a tool
 * argument arrives over MCP stdio and never met it — `reticle_replay` and `reticle_flow_verify` both
 * deserialise their argument before any bound is applied.
 *
 * The guard goes in `runTool`, the one place every tool invocation routes through, so a tool added
 * later inherits it rather than having to remember. A refusal is a normal answer: the agent learns
 * the argument was too big, which is a thing it can fix, instead of waiting forever.
 */
describe('an argument larger than the transport allows is refused, not run', () => {
  const OVERSIZED = 'x'.repeat(TRANSPORT_LIMITS.MAX_STRING_LENGTH + 1);

  it('refuses before the handler ever sees it', async () => {
    let handlerRan = false;
    const tool = stubTool(ReticleTool.QUERY, { ok: true });
    const spy: typeof tool = {
      ...tool,
      handler: () => {
        handlerRan = true;
        return Promise.resolve({ ok: true });
      },
    };
    const r = (await runTool(spy, fakeDeps(), { value: OVERSIZED })) as Record<string, unknown>;

    expect(handlerRan, 'the handler ran on a payload the transport would refuse').toBe(false);
    expect(String(r['error'])).toMatch(/larger than/i);
    expect(String(r['error']), 'the agent must know nothing happened').toContain('Nothing ran');
  });

  it('names the parameter and the limit, so the agent can act', async () => {
    const r = (await runTool(stubTool(ReticleTool.QUERY, { ok: true }), fakeDeps(), {
      value: OVERSIZED,
    })) as Record<string, unknown>;
    expect(String(r['error'])).toContain('value');
    expect(String(r['error'])).toContain(String(TRANSPORT_LIMITS.MAX_STRING_LENGTH));
  });

  it('ANSWERS rather than throwing — an unanswered call is the failure being prevented', async () => {
    await expect(
      runTool(stubTool(ReticleTool.QUERY, { ok: true }), fakeDeps(), { value: OVERSIZED }),
    ).resolves.toBeDefined();
  });

  it('finds an oversized string nested inside args, where the fuzz puts it', async () => {
    const r = (await runTool(stubTool(ReticleTool.ACT, { ok: true }), fakeDeps(), {
      ref: 'e1',
      args: { value: OVERSIZED },
    })) as Record<string, unknown>;
    expect(
      String(r['error']),
      'the nested path must be named, not just the top-level key',
    ).toContain('args.value');
  });

  it('lets a normal argument through untouched', async () => {
    const r = (await runTool(stubTool(ReticleTool.QUERY, { ok: true }), fakeDeps(), {
      value: 'Save',
    })) as Record<string, unknown>;
    expect(r['error']).toBeUndefined();
    expect(r['ok']).toBe(true);
  });
});

/**
 * `feedbackPrompted` is the denominator that says whether inviting mid-task works or is decoration,
 * and it read as near-empty on almost every session. It was not unset and not unserialised: the
 * count sat BELOW the session-bound early return, behind two conditions that between them exclude
 * most friction there is. A session-EXEMPT tool never reached it, and a tool that THREW never got
 * there either — and a throw is the commonest refusal shape by a wide margin, which is exactly the
 * `refused` friction the invitation is written for.
 */
describe('the feedback invitation is counted wherever friction actually happens', () => {
  beforeEach(() => {
    resetSessionMetrics();
  });

  it('invites and counts on a session-EXEMPT tool, which never reached the count before', async () => {
    const exempt: ToolDef = {
      name: ReticleTool.FLOW_VERIFY,
      description: '',
      inputSchema: {},
      handler: () => Promise.resolve({ error: 'no flows to verify' }),
    };
    const result = await runTool(exempt, fakeDeps(), {});
    expect(result).toHaveProperty(EnvelopeKey.FEEDBACK_INVITE);
    expect(getSessionMetrics().summarize(true).feedbackPrompted).toBe(1);
  });

  it('counts the ask an unrecognised THROW earns, which is the commonest refusal there is', async () => {
    const throwing: ToolDef = {
      name: ReticleTool.SNAPSHOT,
      description: '',
      inputSchema: {},
      handler: () => Promise.reject(new Error('a completely novel failure nobody has seen')),
    };
    await expect(runTool(throwing, fakeDeps(), {})).rejects.toThrow();
    expect(getSessionMetrics().summarize(true).feedbackPrompted).toBe(1);
  });

  /**
   * #688: under skew, CDP tools used to surface Playwright's "Target page has been closed" while
   * the page was still dialled in. Refuse with the skew sentence instead — before the provider runs,
   * and if one still throws the closed-target class, rewrite it on the way out.
   */
  it('refuses a CDP tool with the session skew sentence before Playwright runs', async () => {
    const SKEW = 'version skew: the page is 2.2.1; this daemon is 2.4.1. run reticle update';
    let handlerRan = false;
    const screenshot: ToolDef = {
      name: ReticleTool.SCREENSHOT,
      description: '',
      inputSchema: {},
      handler: () => {
        handlerRan = true;
        return Promise.resolve({ saved: true });
      },
    };
    await expect(
      runTool(screenshot, fakeDeps(throttledSession({ versionSkew: SKEW })), {}),
    ).rejects.toThrow(SKEW);
    expect(handlerRan).toBe(false);
  });

  it('rewrites a Playwright closed-target throw to the session skew sentence', async () => {
    const SKEW = 'version skew: the page is 2.2.1; this daemon is 2.4.1. run reticle update';
    const throwing: ToolDef = {
      name: ReticleTool.SNAPSHOT,
      description: '',
      inputSchema: {},
      handler: () =>
        Promise.reject(
          new Error('page.screenshot: Target page, context or browser has been closed'),
        ),
    };
    await expect(
      runTool(throwing, fakeDeps(throttledSession({ versionSkew: SKEW })), {}),
    ).rejects.toThrow(SKEW);
  });

  /**
   * A recognised error gets a concrete recovery INSTEAD of the ask, so counting it would inflate the
   * denominator with invitations nobody was ever shown — the same error in the other direction.
   */
  it('does not count a throw the agent was given a recovery for instead of an ask', async () => {
    const known: ToolDef = {
      name: ReticleTool.SNAPSHOT,
      description: '',
      inputSchema: {},
      handler: () => Promise.reject(new Error('no browser session connected')),
    };
    await expect(runTool(known, fakeDeps(), {})).rejects.toThrow();
    expect(getSessionMetrics().summarize(true)).not.toHaveProperty('feedbackPrompted');
  });

  /**
   * `reticle_run` is a WRAPPER: its handler calls runTool on the real tool, which already invited
   * under the real tool's name. Counting the echo halves the feedback rate.
   */
  it('does not count the reticle_run wrapper twice for one refusal', async () => {
    const wrapper: ToolDef = {
      name: ReticleTool.RUN,
      description: '',
      inputSchema: {},
      handler: () => Promise.resolve({ error: 'no browser session connected' }),
    };
    await runTool(wrapper, fakeDeps(), {});
    expect(getSessionMetrics().summarize(true)).not.toHaveProperty('feedbackPrompted');
  });
});
