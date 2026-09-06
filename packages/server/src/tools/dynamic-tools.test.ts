import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildDynamicTools } from './dynamic-tools.js';
import { ReticleTool } from './tool-names.js';
import { ADVERTISE_ALL_ENV, TOOL_PROFILE_ENV, TOOL_SURFACE } from './tool-surface.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * The two meta-tools are the answer to the per-turn tool-definition tax — they advertise just two
 * meta-tools and loads real tool detail on demand. A bug in the catalog (a tool missing, a summary that
 * isn't one line, params not surfaced on load) breaks discovery, and the model can't find or call the
 * tool. These pin the pure catalog logic; the actual invocation path (runTool) is covered elsewhere.
 */
const fakeTools: ToolDef[] = [
  {
    name: 'reticle_alpha',
    description:
      'Do the alpha thing. A second sentence that must NOT appear in the catalog summary.',
    inputSchema: { ref: z.string().describe('the element'), count: z.number().optional() },
    handler: () => Promise.resolve({ ok: true }),
  },
  {
    name: 'reticle_beta',
    description: 'Do beta.',
    inputSchema: {},
    handler: () => Promise.resolve({ ok: true }),
  },
];

const NO_DEPS = {} as ToolDeps; // the discover/catalog + unknown-tool paths never touch deps

describe('buildDynamicTools — the dynamic profile meta-tools', () => {
  it('exposes exactly reticle_tools and reticle_run, whatever the real surface size', () => {
    const dyn = buildDynamicTools(fakeTools);
    expect(dyn.map((t) => t.name)).toEqual([ReticleTool.TOOLS, ReticleTool.RUN]);
  });

  it('reticle_tools with no args lists every tool as name + one-line summary', async () => {
    const tools = buildDynamicTools(fakeTools);
    const discover = tools.find((t) => t.name === ReticleTool.TOOLS);
    const out = (await discover?.handler(NO_DEPS, {})) as {
      tools: { name: string; summary: string }[];
    };
    expect(out.tools.map((t) => t.name)).toEqual(['reticle_alpha', 'reticle_beta']);
    // The summary is the FIRST sentence only — the second sentence must be dropped.
    expect(out.tools[0]?.summary).toBe('Do the alpha thing.');
    expect(out.tools[0]?.summary).not.toContain('second sentence');
  });

  it('reticle_tools with names loads full params for known tools and flags unknown ones', async () => {
    const tools = buildDynamicTools(fakeTools);
    const discover = tools.find((t) => t.name === ReticleTool.TOOLS);
    const out = (await discover?.handler(NO_DEPS, { names: ['reticle_alpha', 'nope'] })) as {
      tools: { name: string; params?: { name: string }[]; error?: string; description?: string }[];
    };
    const alpha = out.tools.find((t) => 'reticle_alpha' === t.name);
    expect(alpha?.description).toContain('alpha');
    expect(alpha?.params?.map((p) => p.name)).toEqual(['ref', 'count']);
    expect(out.tools.find((t) => 'nope' === t.name)?.error).toBe('unknown tool');
  });

  /**
   * A renamed tool has to be reachable FROM THE SURFACE, not only from an error string.
   *
   * Guidance in the wild still names `reticle_crawl`. `reticle_run` has answered that name with its
   * replacement for a while, but the tool asked to DISCOVER tools said "unknown tool" — the wrong
   * answer in the one place an agent goes to resolve a name it is unsure of — and the catalogue
   * omitted the old name entirely, which reads as "no such capability" rather than "renamed".
   *
   * Instructions written against a previous version are a permanent fact of the product, so this is
   * not about `reticle_crawl`: it is about every tool that has been merged or will be.
   */
  it('reticle_tools names the replacement for a retired tool, not "unknown tool"', async () => {
    const tools = buildDynamicTools(fakeTools);
    const discover = tools.find((t) => t.name === ReticleTool.TOOLS);
    const out = (await discover?.handler(NO_DEPS, { names: [ReticleTool.CRAWL] })) as {
      tools: { name: string; error?: string; tool?: string; action?: string }[];
    };
    const crawl = out.tools.find((t) => ReticleTool.CRAWL === t.name);
    expect(crawl?.error).not.toBe('unknown tool');
    expect(crawl?.tool).toBe(ReticleTool.VERIFY);
    expect(crawl?.action).toBe('crawl');
    expect(crawl?.error).toContain(ReticleTool.VERIFY);
  });

  it('the catalog carries the tombstones, so a rename is discoverable without guessing it', async () => {
    const tools = buildDynamicTools(fakeTools);
    const discover = tools.find((t) => t.name === ReticleTool.TOOLS);
    const out = (await discover?.handler(NO_DEPS, {})) as {
      retired: Record<string, string>;
      tools: { name: string }[];
    };
    expect(out.retired[ReticleTool.CRAWL]).toContain(ReticleTool.VERIFY);
    expect(out.retired[ReticleTool.CRAWL]).toContain('crawl');
    // A name that was retired outright, with no action to pass, still says where it went.
    expect(out.retired[ReticleTool.REFRESH]).toContain(ReticleTool.NAVIGATE);
    // Tombstones are the names that are NO LONGER tools — a live one must not appear among them.
    expect(out.retired).not.toHaveProperty(ReticleTool.VERIFY);
    for (const listed of out.tools) expect(out.retired).not.toHaveProperty(listed.name);
  });

  /**
   * The surface is read by the DAEMON at startup, not by the client. Setting it in an agent's
   * environment while a daemon is already running changes nothing — which is how "standard and full
   * are the same 46 tools" got reported. The setting not taking effect must be OBSERVABLE, so the
   * catalog says which surface is live and where it came from.
   */
  it('reports the ACTIVE surface and where it came from, so a setting that did not take is visible', async () => {
    const tools = buildDynamicTools(fakeTools, {
      active: TOOL_SURFACE.DEFAULT,
      source: 'the one tool surface (RETICLE_ADVERTISE_ALL_TOOLS unset when the daemon started)',
    });
    const discover = tools.find((t) => t.name === ReticleTool.TOOLS);
    const out = (await discover?.handler(NO_DEPS, {})) as {
      profile: { active: string; source: string; note: string };
    };
    expect(out.profile.active).toBe(TOOL_SURFACE.DEFAULT);
    expect(out.profile.source).toContain('RETICLE_ADVERTISE_ALL_TOOLS');
    expect(out.profile.note).toContain('restart');
    expect(out.profile.note).toContain(ADVERTISE_ALL_ENV);
    expect(out.profile.note).not.toContain(TOOL_PROFILE_ENV);
  });

  it('reticle_run on an unknown tool returns the available names (no invocation)', async () => {
    const tools = buildDynamicTools(fakeTools);
    const run = tools.find((t) => t.name === ReticleTool.RUN);
    const out = (await run?.handler(NO_DEPS, { tool: 'reticle_missing' })) as {
      error: string;
      available: string[];
    };
    expect(out.error).toContain('reticle_missing');
    expect(out.available).toEqual(['reticle_alpha', 'reticle_beta']);
  });
});

/**
 * Under the DEFAULT profile most tools are reached through `reticle_run` — so whatever it does with
 * a failure is what an agent actually sees.
 *
 * It caught every error and answered `hint: "fix the arguments and call reticle_run again"`,
 * discarding the recovery the error boundary would have attached. A stale ref — the commonest
 * post-action condition there is, and one with a good, specific recovery ("refs are invalidated
 * whenever the DOM re-renders; call reticle_query again") — was reported to the agent as a bad
 * argument. The arguments were fine; the page had re-rendered. Wrong advice costs the retry.
 */
describe('reticle_run reports a failure the way the rest of the surface does', () => {
  const staleRef: ToolDef[] = [
    {
      name: 'reticle_alpha',
      description: 'Do the alpha thing.',
      inputSchema: { ref: z.string() },
      handler: () => {
        throw new Error("ref 'e1' no longer resolves to an element");
      },
    },
  ];

  it('keeps the real recovery instead of blaming the arguments', async () => {
    const run = buildDynamicTools(staleRef).find((t) => t.name === ReticleTool.RUN);
    const out = (await run?.handler(NO_DEPS, {
      tool: 'reticle_alpha',
      args: { ref: 'e1' },
    })) as { error?: string; recovery?: string; hint?: string };
    expect(out.error).toContain('no longer resolves');
    expect(out.recovery).toContain('reticle_query');
    expect(out.hint).toBeUndefined();
  });

  /**
   * `reticle_run` refused an unknown key inside `args` and silently dropped one beside them.
   *
   * Every other tool on the surface refuses an unknown parameter. This one takes `{tool, args}`, so
   * `reticle_run { tool, args, sessionId }` — the shape an agent writes when it has just used
   * `sessionId` on the tool it is now wrapping — dropped `sessionId` on the floor and ran the call
   * against whatever session auto-selection picked. The answer looks like an answer; it is an answer
   * to a different question, which is the exact wording the inner check already uses.
   */
  it('refuses an unknown TOP-LEVEL parameter, the way it already refuses one inside args', async () => {
    const run = buildDynamicTools(staleRef).find((t) => t.name === ReticleTool.RUN);
    const out = (await run?.handler(NO_DEPS, {
      tool: 'reticle_alpha',
      args: { ref: 'e1' },
      // NOT sessionId — that one is now accepted and FORWARDED, because reticle_run is the only way
      // to reach an unadvertised tool and on a multi-project daemon it has to be aimable. Reported
      // across 6 of 6 apps: it took sessionId, dropped it, resolved by the daemon's cwd project and
      // then failed naming the very session it had been handed. Refusing the key was more honest
      // than dropping it and still left the escape hatch un-aimable. See run-session-id.test.ts.
      nonsense: 'x',
    })) as { error?: string; params?: unknown };
    expect(out.error).toContain('nonsense');
    expect(out.error).toContain('NOT applied');
  });

  it('still points at the parameters when the arguments really are the problem', async () => {
    const run = buildDynamicTools(staleRef).find((t) => t.name === ReticleTool.RUN);
    const out = (await run?.handler(NO_DEPS, { tool: 'reticle_alpha', args: { nope: 1 } })) as {
      error?: string;
      params?: unknown;
    };
    expect(out.error).toContain('nope');
    expect(out.params).toBeDefined();
  });
});
