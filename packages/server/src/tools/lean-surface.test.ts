/**
 * The `lean` surface is an EXPERIMENT, and an experiment whose independent variable can drift is not
 * an experiment. These pin the three things a mid-flight edit could silently change: which tools it
 * advertises, that nothing it drops became unreachable, and that `default` — the control arm — is
 * still the same list it was before `lean` existed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advertisedConfig, advertisedTools } from '../mcp/mcp.js';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';
import {
  CORE_TOOL_NAMES,
  LEAN_TOOL_NAMES,
  TOOL_SURFACE,
  TOOL_PROFILE_ENV,
  type ToolSurface,
  filterTools,
  resolveToolSurface,
} from './tool-surface.js';

/** The composition under measurement. Changing this changes what the numbers mean — see CHANGELOG. */
const PINNED_LEAN = [
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ASSERT,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.STATE,
];

/**
 * The control arm. `lean` is only measurable against a `default` that did not move, so this is a
 * literal transcription of the set as it stood when the experiment was set up, not a re-derivation.
 */
const PINNED_DEFAULT = [
  ReticleTool.SESSIONS,
  ReticleTool.NAVIGATE,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.STATE,
  ReticleTool.INSPECT,
  ReticleTool.FEEDBACK,
  ReticleTool.SESSION,
];

/**
 * The advertised PROSE of a surface, in bytes.
 *
 * Not the exact wire payload — that is measured off a real `tools/list` by
 * bench/harness/schema-tax.mjs — but the component the surface controls: descriptions are re-sent
 * every turn, and per the measurement in tool-surface.ts the tool description plus its parameter
 * descriptions are the bulk of what an output-schema-free surface puts on the wire. A gate over an
 * approximation that moves WITH the payload beats no gate over the exact one.
 */
function advertisedProseBytes(surface: ToolSurface): number {
  const advertised = advertisedTools(surface);
  let bytes = 0;
  for (const tool of advertised) {
    const config = advertisedConfig(tool, advertised, surface);
    bytes += Buffer.byteLength(`${tool.name}${config.description}`, 'utf8');
    for (const shape of Object.values(config.inputSchema)) {
      bytes += Buffer.byteLength(shape.description ?? '', 'utf8');
    }
  }
  return bytes;
}

describe('the lean surface', () => {
  const original = process.env[TOOL_PROFILE_ENV];
  beforeEach(() => {
    delete process.env[TOOL_PROFILE_ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[TOOL_PROFILE_ENV];
    else process.env[TOOL_PROFILE_ENV] = original;
  });

  it('resolves from the tool-profile setting', () => {
    process.env[TOOL_PROFILE_ENV] = TOOL_SURFACE.LEAN;
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.LEAN);
  });

  it('resolves from an explicit request, so a caller never depends on process env', () => {
    expect(resolveToolSurface(TOOL_SURFACE.LEAN)).toBe(TOOL_SURFACE.LEAN);
  });

  it('advertises EXACTLY the pinned composition, plus the two meta-tools', () => {
    const filtered = filterTools(TOOLS, TOOL_SURFACE.LEAN)
      .map((t) => t.name)
      .sort();
    expect(filtered).toEqual([...PINNED_LEAN].sort());
    expect(new Set(LEAN_TOOL_NAMES)).toEqual(new Set(PINNED_LEAN));
    const advertised = advertisedTools(TOOL_SURFACE.LEAN).map((t) => t.name);
    expect(advertised).toContain(ReticleTool.RUN);
    expect(advertised).toContain(ReticleTool.TOOLS);
  });

  it('leaves every tool it drops reachable through the escape hatch', () => {
    const advertised = new Set(advertisedTools(TOOL_SURFACE.LEAN).map((t) => t.name));
    expect(advertised, 'without the hatch a trim is a removal').toContain(ReticleTool.RUN);
    const registry = new Set(TOOLS.map((t) => t.name));
    const unreachable = [...CORE_TOOL_NAMES].filter(
      (name) => !advertised.has(name) && !registry.has(name),
    );
    expect(unreachable, 'a dropped tool that is not in the registry is a capability LOSS').toEqual(
      [],
    );
  });

  it('does not move the control arm: default membership is unchanged', () => {
    expect([...CORE_TOOL_NAMES].sort()).toEqual([...PINNED_DEFAULT].sort());
    const filtered = filterTools(TOOLS, TOOL_SURFACE.DEFAULT)
      .map((t) => t.name)
      .sort();
    expect(filtered).toEqual([...PINNED_DEFAULT].sort());
  });

  it('puts materially less prose on the wire than default, or it buys nothing', () => {
    const lean = advertisedProseBytes(TOOL_SURFACE.LEAN);
    const fallback = advertisedProseBytes(TOOL_SURFACE.DEFAULT);
    expect(lean).toBeLessThan(fallback * 0.75);
  });
});
