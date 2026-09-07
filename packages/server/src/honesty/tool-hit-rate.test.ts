/**
 * Which tools a session actually called, crossed with how reachable each one was.
 *
 * The cut decision this feeds is "does this tool earn a slot on the advertised surface", so the two
 * halves have to come from the same place: the count from the one dispatch chokepoint, the tier from
 * the surface sets themselves. A restated list of what is advertised would rot the first time a tool
 * moved, and the report would then be confidently wrong about the only axis it exists to measure.
 */

import { describe, expect, it } from 'vitest';
import { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } from '../tools/tool-surface.js';
import { ReticleTool } from '../tools/tool-names.js';
import { ToolTier, foldToolHitRate, tierOfTool } from './tool-hit-rate.js';

const A_DEFAULT_TOOL = ReticleTool.SNAPSHOT;
const AN_EXTENDED_TOOL = ReticleTool.SCREENSHOT;
const A_RUN_ONLY_TOOL = ReticleTool.EXPLORE;
const TABLE = [A_DEFAULT_TOOL, AN_EXTENDED_TOOL, A_RUN_ONLY_TOOL];

describe('tier derivation', () => {
  it('reads every tier off the surface sets, so a tool that moves takes its tier with it', () => {
    for (const name of CORE_TOOL_NAMES) expect(tierOfTool(name)).toBe(ToolTier.DEFAULT);
    for (const name of EXTENDED_TOOL_NAMES) expect(tierOfTool(name)).toBe(ToolTier.EXTENDED);
  });

  it('calls a name on neither surface run-only, because reticle_run is the only way to it', () => {
    expect(CORE_TOOL_NAMES.has(A_RUN_ONLY_TOOL)).toBe(false);
    expect(EXTENDED_TOOL_NAMES.has(A_RUN_ONLY_TOOL)).toBe(false);
    expect(tierOfTool(A_RUN_ONLY_TOOL)).toBe(ToolTier.RUN_ONLY);
  });
});

describe('per-session tool hit rate', () => {
  it('counts a call per tool name', () => {
    const hits = foldToolHitRate({
      calls: new Map([
        [A_DEFAULT_TOOL, 3],
        [A_RUN_ONLY_TOOL, 1],
      ]),
      allTools: TABLE,
    });

    expect(hits.called).toEqual([
      { tool: A_DEFAULT_TOOL, tier: ToolTier.DEFAULT, calls: 3 },
      { tool: A_RUN_ONLY_TOOL, tier: ToolTier.RUN_ONLY, calls: 1 },
    ]);
  });

  it('classifies a default, an extended and a run-only tool into the cells the cut turns on', () => {
    const hits = foldToolHitRate({
      calls: new Map([
        [A_DEFAULT_TOOL, 1],
        [A_RUN_ONLY_TOOL, 2],
      ]),
      allTools: TABLE,
    });

    expect(hits.cells).toEqual({
      called: { default: 1, extended: 0, runOnly: 1 },
      neverCalled: { default: 0, extended: 1, runOnly: 0 },
    });
    expect(hits.neverCalled).toEqual([{ tool: AN_EXTENDED_TOOL, tier: ToolTier.EXTENDED }]);
  });

  it('reports not observed for a session carrying no ledger, never zero calls', () => {
    const hits = foldToolHitRate({ calls: undefined, allTools: TABLE });

    expect(hits).toEqual({ observed: false });
  });
});
