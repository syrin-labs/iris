import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advertisedTools } from '../mcp/mcp.js';
import { TOOLS } from './tools.js';
import {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES,
  TOOL_SURFACE,
  TOOL_PROFILE_ENV,
  ADVERTISE_ALL_ENV,
  describeToolSurface,
  filterTools,
  resolveToolSurface,
} from './tool-surface.js';
import { ReticleTool } from './tool-names.js';
import { PAUSE_HINT } from '../session/control-envelope.js';
import { buildSessionLease } from '../session/session-lease.js';

describe('tool profiles', () => {
  const original = process.env[TOOL_PROFILE_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[TOOL_PROFILE_ENV];
    else process.env[TOOL_PROFILE_ENV] = original;
  });
  beforeEach(() => {
    delete process.env[TOOL_PROFILE_ENV];
  });

  it('1: the HYBRID filter returns exactly the core tool set', () => {
    const names = filterTools(TOOLS, TOOL_SURFACE.DEFAULT).map((t) => t.name);
    expect(new Set(names)).toEqual(CORE_TOOL_NAMES);
    expect(names).toHaveLength(CORE_TOOL_NAMES.size);
  });

  // `all` was the whole registry until the advertised count became a hard budget: editors cap tools
  // across every connected MCP server (Cursor at 40), so a server advertising everything it owns can
  // evict a user's other servers. It is now the extended surface, and the registry is deliberately
  // larger than it. Everything omitted is still callable via `reticle_run`.
  it('2: the ALL filter returns core plus the extended set, and is SMALLER than the registry', () => {
    const tools = filterTools(TOOLS, TOOL_SURFACE.ALL);
    const names = new Set(tools.map((t) => t.name));
    expect(tools.length).toBeLessThan(TOOLS.length);
    for (const name of CORE_TOOL_NAMES) expect(names.has(name), name).toBe(true);
    for (const name of EXTENDED_TOOL_NAMES) expect(names.has(name), name).toBe(true);
    expect(tools).toHaveLength(CORE_TOOL_NAMES.size + EXTENDED_TOOL_NAMES.size);
  });

  it('3: every EXTENDED_TOOL_NAMES entry actually exists in TOOLS (no dangling name)', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const name of EXTENDED_TOOL_NAMES) expect(all.has(name), name).toBe(true);
  });

  it('4: core and extended never overlap, or the count is a lie', () => {
    for (const name of EXTENDED_TOOL_NAMES) expect(CORE_TOOL_NAMES.has(name), name).toBe(false);
  });

  it('3: every CORE_TOOL_NAMES entry actually exists in TOOLS (no dangling name)', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const name of CORE_TOOL_NAMES) expect(all.has(name)).toBe(true);
  });

  it('4: the core set is a strict subset — fewer tools than FULL', () => {
    expect(CORE_TOOL_NAMES.size).toBeLessThan(TOOLS.length);
  });

  /**
   * An instruction the agent cannot follow is worse than no instruction.
   *
   * These two blocks are not suggestions and not documentation — they are spliced onto tool RESULTS,
   * every session (the lease) and on every refusal while paused (the pause hint), and each names
   * exactly one tool as the required next call. The lease says "call reticle_session {action:
   * 'yield'}"; the pause hint says resuming is the only way out. Neither tool was on the default
   * surface, so an agent that did as it was told got `unknown tool` — and an agent that did not,
   * left the panel reading "live" forever.
   *
   * The RETICLE_LOOP_GUIDE deliberately is NOT covered here: it names reticle_record/reticle_replay
   * as optional next steps, which reticle_run reaches fine. Mandatory ≠ suggested.
   */
  it('4a: a tool an always-on instruction ORDERS the agent to call is advertised', () => {
    for (const block of [PAUSE_HINT, buildSessionLease('s1', 0).IMPORTANT]) {
      const named = block.match(/reticle_[a-z_]+/g) ?? [];
      // Reword the instruction to drop the literal tool name and this loop runs zero
      // times, forever green — which is the defect the guard was written to catch.
      expect(named.length, `no tool name in "${block}" — nothing was checked`).toBeGreaterThan(0);
      for (const tool of named) {
        expect(CORE_TOOL_NAMES.has(tool), `${tool} is ordered by "${block}"`).toBe(true);
      }
    }
  });

  it('4b: server-management ops are NOT on the MCP surface (CLI-only — they restart the daemon)', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const retired of ['reticle_version_info', 'reticle_apply_update', 'reticle_rollback'])
      expect(names.has(retired)).toBe(false);
  });

  it('5: resolveToolSurface — an explicit value wins over the environment', () => {
    process.env[TOOL_PROFILE_ENV] = 'full';
    expect(resolveToolSurface(TOOL_SURFACE.DEFAULT)).toBe(TOOL_SURFACE.DEFAULT);
  });

  it('6: resolveToolSurface — falls back to the retired env var when no explicit value', () => {
    process.env[TOOL_PROFILE_ENV] = 'full';
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.ALL);
  });

  it('7: resolveToolSurface — defaults to HYBRID, an unknown value fails open to HYBRID, explicit full is honored', () => {
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.DEFAULT);
    expect(resolveToolSurface('bogus')).toBe(TOOL_SURFACE.DEFAULT);
    expect(resolveToolSurface(TOOL_SURFACE.ALL)).toBe(TOOL_SURFACE.ALL);
  });
});

/**
 * There is ONE tool surface. Everything else is a retired name or a verification switch.
 *
 * Measured off the real wire, fresh daemon per reading:
 *
 *   dynamic     2 tools    1,543 B     ~386 tok/turn
 *   core       16 tools   18,183 B   ~4,546 tok/turn
 *   hybrid     16 tools   18,183 B   ~4,546 tok/turn
 *   standard   33 tools   32,234 B   ~8,059 tok/turn
 *   full       48 tools  127,903 B  ~31,976 tok/turn
 *
 * `core` was byte-identical to `hybrid`. `standard` charged ~3,500 tokens every turn for reach that
 * `reticle_run` already provided. `dynamic` was selected by nothing in this repo and is contradicted
 * by our own measurement — a pure on-demand surface does not hold accuracy with a generic model.
 *
 * `full` is the one that survives, and NOT as a profile: it is the only mode that advertises
 * `outputSchema`, which is what makes the MCP layer validate tool OUTPUT. Folding that into the
 * default was measured at 18,183 -> 41,117 bytes (2.26x, +5,733 tok/turn), so it cannot be the
 * default; deleting it would lose the defect class the surface sweep catches. So it is a switch,
 * named for what it does, and no user is asked to choose it.
 *
 * Every retired value still resolves, because they were a published env var.
 */
describe('one surface, plus two switches', () => {
  /**
   * The rule this pins is "no MENU", not "no more than two entries". Four profiles were retired
   * because they were near-duplicates a user was invited to shop among, and nothing here may
   * reintroduce that.
   *
   * `verify` is admitted on the same terms as `all`: named for what it does, never offered as a
   * choice, and justified by a measurement rather than a taste. A verification that names its own
   * target is one `act_and_wait` call, and 5,480 of its 5,909 tokens are the surface re-sent for
   * that single turn — the answers cost 430. It is off by default precisely because the retired
   * `dynamic` profile was measured to lose accuracy on a lean surface, and that finding stands
   * until re-measured on the same 30-bug set.
   *
   * If that measurement fails, the entry comes out. An unmeasured third surface IS a menu.
   *
   * `lean` is admitted on strictly narrower terms again: it is not offered, not documented as a
   * recommendation, and exists to RUN the measurement that `verify` failed — same 30-bug set,
   * observation tools retained. `verify` proved the token saving and the accuracy loss come from two
   * different cuts; `lean` pays for only one of them. It is an EXPERIMENT with the same exit as the
   * others: if it does not hold detection and false alarms against `default`, the entry comes out.
   */
  it('offers exactly four internal surfaces, each a switch rather than a choice', () => {
    expect(new Set(Object.values(TOOL_SURFACE))).toEqual(
      new Set([TOOL_SURFACE.DEFAULT, TOOL_SURFACE.ALL, TOOL_SURFACE.VERIFY, TOOL_SURFACE.LEAN]),
    );
  });

  it('verify still reaches every other tool, or it is a trap rather than a saving', () => {
    const names = new Set(advertisedTools(TOOL_SURFACE.VERIFY).map((t) => t.name));
    expect(names).toContain('reticle_tools');
    expect(names).toContain('reticle_run');
  });

  it('verify is the smallest surface, and is not reachable by accident', () => {
    expect(advertisedTools(TOOL_SURFACE.VERIFY).length).toBeLessThan(
      advertisedTools(TOOL_SURFACE.DEFAULT).length,
    );
    expect(resolveToolSurface(undefined), 'never the default').toBe(TOOL_SURFACE.DEFAULT);
  });

  it.each([['core'], ['standard'], ['hybrid'], ['dynamic']])(
    'resolves the retired value %s to the one default surface',
    (name) => {
      expect(resolveToolSurface(name)).toBe(TOOL_SURFACE.DEFAULT);
    },
  );

  it('resolves the retired value full to the ALL surface, so a script that set it still works', () => {
    expect(resolveToolSurface('full')).toBe(TOOL_SURFACE.ALL);
  });

  it('says the setting retired, and points at the switch that replaced it', () => {
    const origin = describeToolSurface(TOOL_SURFACE.DEFAULT, 'standard');
    expect(origin.source).toMatch(/RETIRED/);
    expect(origin.source).toMatch(/RETICLE_ADVERTISE_ALL_TOOLS/);
  });

  it('says so for a value that was never even one of its names', () => {
    const origin = describeToolSurface(TOOL_SURFACE.DEFAULT, 'banana');
    expect(origin.source).toMatch(/RETIRED/);
    expect(origin.source).toMatch(/banana/);
  });

  it('turns the ALL surface on from the switch', () => {
    process.env[ADVERTISE_ALL_ENV] = '1';
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.ALL);
    delete process.env[ADVERTISE_ALL_ENV];
  });

  it('treats a non-truthy switch value as off, rather than as "set"', () => {
    process.env[ADVERTISE_ALL_ENV] = '0';
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.DEFAULT);
    delete process.env[ADVERTISE_ALL_ENV];
  });
});

/**
 * The advertised surface must contain the tool that prevents the biggest loop in the data.
 *
 * In the field `reticle_act` is called overwhelmingly more often than
 * `reticle_act_sequence` **7 times**. `act` also leads the repeat table — **110 consecutive-repeat
 * runs**, and inside those sessions the repeated calls are **98 clicks and 21 fills**, i.e. a login
 * form driven one round trip at a time. 23 of the 30 looping sessions recorded abandoned actions.
 *
 * The repeats are not retries: looping sessions have a LOWER error rate (0.051) than non-looping
 * ones (0.078). The calls succeed and are simply repeated, because the batching tool that
 * `SKILL.md` already recommends was reachable only through `reticle_run` — so an agent had to
 * already know it existed.
 */
describe('the surface advertises the tools that prevent looping and produce verdicts', () => {
  it('advertises reticle_act_sequence, not just reticle_act', () => {
    expect(
      CORE_TOOL_NAMES.has(ReticleTool.ACT_SEQUENCE),
      'act dominates act_sequence — the batching tool was invisible',
    ).toBe(true);
  });

  it('advertises both verdict-producing tools', () => {
    // Verdict-less sessions overwhelmingly never call either of these once.
    expect(CORE_TOOL_NAMES.has(ReticleTool.ACT_AND_WAIT)).toBe(true);
    expect(CORE_TOOL_NAMES.has(ReticleTool.ASSERT)).toBe(true);
  });

  it('stays under 20 advertised tools — the surface is a budget, not a dumping ground', () => {
    // Every tool here is re-sent on every turn. The measured floor for accuracy was about cutting
    // to 8 (5/5 -> 3/5); the ceiling is the per-turn schema cost. 20 is the agreed cap.
    expect(CORE_TOOL_NAMES.size).toBeLessThanOrEqual(18);
  });
});
