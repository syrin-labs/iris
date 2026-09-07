/**
 * The documented profile sizes must match the real ones.
 *
 * Three generations of prose got them wrong, each time in a comment that had just finished promising
 * not to restate them — the historical "here is what it used to say" clause goes stale exactly like
 * the claim it corrects. So no count is written down in this file except EXPECTED_SIZE, and none is
 * written down in the docs except the one gated table in SKILL.md.
 *
 * Prose cannot be trusted to stay in step with a list that grows every release, so the numbers live
 * here where a gate reads them, and every other file points at this one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_SURFACE, type ToolSurface } from './tool-surface.js';
import { advertisedTools } from '../mcp/mcp.js';
import { TOOLS } from './tools.js';
import { buildDynamicTools } from './dynamic-tools.js';

/** The advertised size of each surface. Update WITH the surface, never after it. */
const EXPECTED_SIZE: Record<ToolSurface, number> = {
  // The verify loop plus the two meta-tools that reach everything else. 18 since
  // `reticle_capabilities` was demoted to the extended surface: it was added as an explicit bet that
  // orientation replaces exploratory snapshots, the measurement that would settle that was never
  // run, and an unproven entry is the right one to give up when the budget is a hard count.
  [TOOL_SURFACE.DEFAULT]: 18,
  // The extended surface. NOT "everything" — see ADVERTISED_CAP. Was 28 after change/flows/
  // affected/coverage/crawl merged into `reticle_verify`; 29 now that `reticle_intent` joins it.
  // Intent lands here rather than in DEFAULT on the same terms the capabilities demotion set: it is
  // new and its claim is unmeasured, so it does not take a default-surface slot from a tool that has
  // earned one. Still one `reticle_run` hop away for any agent that wants it. 30 now that
  // `reticle_context` joins it on exactly those terms, which puts the extended surface ON the cap:
  // the next tool added here has to displace one, and that is the budget working as designed.
  [TOOL_SURFACE.ALL]: 30,
  // The smallest surface that can still return a verdict: one acting tool that resolves its own
  // target, plus the two meta-tools that reach the rest. See tool-surface.ts for why it is not the
  // default.
  [TOOL_SURFACE.VERIFY]: 3,
  // The experimental middle: the four evidence tools plus look, act-with-a-verdict and assert, and
  // the two meta-tools. Sized against `verify`'s measured failure — that surface saved 37% and
  // tripled false alarms, and only the observation cut caused the second half. Membership itself is
  // pinned in lean-surface.test.ts; this is only its count.
  [TOOL_SURFACE.LEAN]: 10,
};

/**
 * No surface may advertise more than this, ever.
 *
 * Cursor enforces a hard limit of 40 tools across ALL connected MCP servers combined, so a server
 * that advertises 48 on its own can make a user's other servers unusable, or be silently dropped.
 * The budget is a COUNT, not a byte size, which is why this is a count and why trimming prose does
 * not help it.
 *
 * This is the cap the surface is DESIGNED against rather than a description of it, so it is asserted
 * on every surface rather than on the one that happens to be largest today.
 */
const ADVERTISED_CAP = 30;

describe('advertised surface sizes', () => {
  it.each(Object.entries(EXPECTED_SIZE))('%s advertises %i tools', (profile, size) => {
    expect(advertisedTools(profile as ToolSurface)).toHaveLength(size);
  });

  it('NO surface exceeds the cap, on any surface, because the budget is shared with other servers', () => {
    for (const surface of Object.values(TOOL_SURFACE)) {
      expect(advertisedTools(surface).length, surface).toBeLessThanOrEqual(ADVERTISED_CAP);
    }
  });

  /**
   * The cap removes tools from the LIST, never from reach. `reticle_run { tool, args }` invokes any
   * tool in the registry by name, and `reticle_tools` still catalogs every one of them, so an agent
   * discovers and calls an unadvertised tool in two calls instead of zero. That is the whole trade:
   * the cold tail costs a hop, and nothing becomes unreachable.
   *
   * Asserted rather than described, because "it is still reachable" is exactly the kind of claim
   * that quietly stops being true when someone changes how the catalog is built.
   */
  it('every tool the cap leaves unadvertised is still reachable and still discoverable', () => {
    const advertised = new Set(advertisedTools(TOOL_SURFACE.ALL).map((t) => t.name));
    const hidden = TOOLS.filter((t) => !advertised.has(t.name));
    expect(hidden.length, 'the cap is meant to be hiding something').toBeGreaterThan(0);
    const catalog = new Set(
      buildDynamicTools(TOOLS, { active: TOOL_SURFACE.ALL, source: 'test' }).map((t) => t.name),
    );
    expect(catalog, 'the catalog tool must be advertised or the tail is lost').toContain(
      'reticle_tools',
    );
    for (const tool of hidden) {
      expect(
        TOOLS.some((t) => t.name === tool.name),
        tool.name,
      ).toBe(true);
    }
  });

  it("EVERY profile can look up a tool's parameters", () => {
    // Recovery messages across the server say "Call reticle_tools { names: [...] }". A profile that
    // does not advertise it turns our own advice into a dead end — `full` used to be exactly that.
    for (const profile of Object.values(TOOL_SURFACE)) {
      const names = advertisedTools(profile).map((t) => t.name);
      expect(names, profile).toContain('reticle_tools');
      expect(names, profile).toContain('reticle_run');
    }
  });

  it('every trimmed profile is smaller than full, or it is not a trim', () => {
    const full = advertisedTools(TOOL_SURFACE.ALL).length;
    for (const profile of [
      TOOL_SURFACE.DEFAULT,
      TOOL_SURFACE.DEFAULT,
      TOOL_SURFACE.DEFAULT,
      TOOL_SURFACE.DEFAULT,
    ]) {
      expect(advertisedTools(profile).length, profile).toBeLessThan(full);
    }
  });
});

/**
 * The same defect, one directory away — and the first attempt at this gate could not catch it.
 *
 * `toContain(String(n))` passes on a file that states BOTH 46 and 48, and "16" was already satisfied
 * by an unrelated "Next 16" elsewhere in SKILL.md — so the assertion guarded nothing while both docs
 * told readers the counts were "gated". Presence is the wrong property. The property that holds is
 * SINGULARITY: exactly one place in the docs may state a size, it must be the current one, and
 * anything anywhere else that reads like a surface count is a contradiction waiting to happen.
 */
describe('docs state a surface size exactly once, correctly', () => {
  const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
  /** The one sentence in the docs allowed to carry counts. Built from the numbers the gate proves. */
  const CANONICAL = `\`default\` ${String(EXPECTED_SIZE[TOOL_SURFACE.DEFAULT])}, \`all\` ${String(EXPECTED_SIZE[TOOL_SURFACE.ALL])}`;
  /**
   * Anything that reads like a count of the surface: "46 tools", "33 advertised", "`=full` (48)".
   * Deliberately blind to whether the number is right — a SECOND statement of it is the defect, because
   * the two drift apart and the reader cannot tell which one to believe.
   */
  const COUNT_CLAIM =
    /\b\d{1,3}\s+(?:tools|advertised)\b|(?:hybrid|standard|full|core|dynamic)`?\s*\(\d{1,3}\)/gi;
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

  it('SKILL.md carries the canonical table, with the CURRENT numbers', () => {
    const text = read('SKILL.md');
    expect(
      text.split(CANONICAL).length - 1,
      `SKILL.md must state "${CANONICAL}" exactly once`,
    ).toBe(1);
  });

  it.each(['SKILL.md', 'docs/agent-cheatsheet.md'])('%s states no OTHER surface count', (rel) => {
    const text = read(rel).split(CANONICAL).join('');
    expect(
      text.match(COUNT_CLAIM) ?? [],
      `${rel}: counts belong only in the canonical table`,
    ).toEqual([]);
  });
});
