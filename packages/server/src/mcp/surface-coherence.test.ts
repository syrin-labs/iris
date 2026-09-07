import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_NAMES } from '../tools/tool-surface.js';
import { ReticleTool } from '../tools/tool-names.js';
import { buildServerInstructions } from './server-instructions.js';

/**
 * Three sources describe the tool surface, and they have to agree.
 *
 * The advertised list is what `tools/list` returns. The MCP instructions block is what every agent
 * reads at the handshake. `SKILL.md` is what a user pastes. Nothing tied them together, so all three
 * drifted in both directions at once, and each direction fails differently:
 *
 * A tool NAMED but not callable is the worse half. An agent reads "use reticle_state", looks at the
 * list it was handed, does not find it, and burns a call proving the instructions wrong. After that
 * it has no way to tell which of the remaining advice is real. Guidance that lies once is guidance
 * that gets ignored, and it is being read by something that cannot ask.
 *
 * A tool ADVERTISED but named nowhere is the quieter half, and `reticle_observe` is the case that
 * shows why it matters: TOOL_SURFACE.VERIFY records the measurement, where dropping the observation
 * tools TRIPLED false alarms. The model stops observing and reaches for the verdict without the
 * evidence. A tool that load-bearing, handed over as a name and a one-line description with no word
 * on when to reach for it, is a tool the model will not reach for.
 *
 * So: named implies reachable, advertised implies mentioned. The advertised set is read from
 * `CORE_TOOL_NAMES` rather than restated here, because a hand-maintained copy of the surface is the
 * same defect one level up.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SKILL = join(REPO, 'SKILL.md');

/** Any `reticle_*` token. Narrowed against DECLARED below: most of them were never tools. */
const ANY_TOOL_MENTION = /reticle_[a-z0-9_]+/g;

/**
 * The supported shape for reaching a tool that is not advertised. Naming one WITHOUT this is the
 * defect; naming one WITH it is the fix, and is how the skill already reaches `reticle_verify`.
 */
const RUN_FORM = /reticle_run\(\{\s*tool:\s*"([a-z0-9_]+)"/g;

/** Only a name that was declared a tool is evidence. Telemetry codes and store names are not. */
const DECLARED: ReadonlySet<string> = new Set<string>(Object.values(ReticleTool));

/**
 * The two meta-tools. Always advertised, on every surface, and they are the thing the run form is
 * written with, so requiring them to be reachable through themselves is circular.
 */
const META: ReadonlySet<string> = new Set<string>([ReticleTool.RUN, ReticleTool.TOOLS]);

/**
 * What an agent actually reads out of the instructions module: the shipped strings, not the
 * docblocks around them. The comments in that file discuss tools at length by name, and counting
 * those as guidance would let a source comment satisfy a rule about what the agent is told.
 */
function instructionProse(): string {
  return [true, false].map((c) => buildServerInstructions({ previouslyConnected: c })).join('\n');
}

interface Source {
  readonly label: string;
  readonly text: string;
}

function sources(): Source[] {
  return [
    {
      label: 'the MCP instructions (packages/server/src/mcp/server-instructions.ts)',
      text: instructionProse(),
    },
    { label: 'SKILL.md', text: readFileSync(SKILL, 'utf8') },
  ];
}

function mentionedTools(text: string): Set<string> {
  return new Set((text.match(ANY_TOOL_MENTION) ?? []).filter((n) => DECLARED.has(n)));
}

function runFormTools(text: string): Set<string> {
  return new Set([...text.matchAll(RUN_FORM)].map((m) => m[1] ?? ''));
}

describe('the instructions, SKILL.md and the advertised surface describe the same product', () => {
  it('derives the advertised set from the surface module, not from a list in this file', () => {
    // The derivation being LIVE is the point: if CORE_TOOL_NAMES is what this reads, a tool added
    // there arrives here on its own. Pinned against the two anchors the checks below depend on.
    expect(CORE_TOOL_NAMES.size).toBeGreaterThan(10);
    expect(CORE_TOOL_NAMES.has(ReticleTool.OBSERVE)).toBe(true);
    expect(CORE_TOOL_NAMES.has(ReticleTool.CONTEXT)).toBe(false);
  });

  it('finds both sources, with enough text in each to judge', () => {
    for (const { label, text } of sources()) {
      expect(text.length, `${label} is empty`).toBeGreaterThan(500);
    }
  });

  it('every tool a document names is either advertised or shown with its reticle_run call', () => {
    const unreachable: string[] = [];
    for (const { label, text } of sources()) {
      const reachable = runFormTools(text);
      for (const name of mentionedTools(text)) {
        if (CORE_TOOL_NAMES.has(name) || META.has(name) || reachable.has(name)) continue;
        unreachable.push(`${label}: ${name}`);
      }
    }
    expect(
      unreachable,
      'These documents name a tool that is not on the advertised surface and never show how to ' +
        'reach it, so an agent that follows the advice gets "unknown tool". FIX: write the call as ' +
        '`reticle_run({ tool: "<name>", args: {...} })` where the document names it, or advertise ' +
        `the tool by adding it to CORE_TOOL_NAMES in tools/tool-surface.ts:\n${unreachable.join('\n')}`,
    ).toEqual([]);
  });

  it('every advertised tool is named in at least one of them', () => {
    const combined = sources()
      .map((s) => s.text)
      .join('\n');
    const named = mentionedTools(combined);
    const silent = [...CORE_TOOL_NAMES].filter((n) => !named.has(n));
    expect(
      silent,
      'These tools are advertised on every turn and no document an agent reads mentions them, so ' +
        'the agent has a name and a one-line description and nothing about WHEN to reach for it. ' +
        'That is not free: dropping the observation tools tripled false alarms (see ' +
        'TOOL_SURFACE.VERIFY). FIX: say what each is for in server-instructions.ts or SKILL.md, or ' +
        `drop it from CORE_TOOL_NAMES if it does not earn its per-turn cost:\n${silent.join('\n')}`,
    ).toEqual([]);
  });
});
