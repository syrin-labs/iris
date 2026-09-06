/**
 * Carrying out an agent-config plan.
 *
 * The plan decides; this writes. Kept apart because the deciding is where the judgement is — which
 * paths are evidenced, which formats are safe to touch — and it is worth testing against a pretend
 * filesystem rather than a real one.
 *
 * One rule governs everything here: only our key is ever written. The rest of somebody's config is
 * copied through untouched, and a file we cannot parse is left exactly as it is. A config file is
 * not ours, and the cost of being wrong about that is not a failed install but a broken editor.
 */

import {
  AgentAction,
  AGENT_CLIENTS,
  type AgentPlanStep,
  type PlatformPaths,
  joinFor,
} from './agent-configs.js';

/** The filesystem, injected so the writer is testable without one. */
export interface AgentWriterIo {
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, contents: string) => void;
  readonly mkdirp: (dir: string) => void;
}

/** Two spaces, because that is what every one of these files already uses. */
const INDENT = 2;
const RETICLE_KEY = 'reticle';

/** A fresh Continue config. YAML is only ever created, never edited. */
const CONTINUE_YAML =
  'mcpServers:\n  - name: reticle\n    type: stdio\n    command: npx\n    args: ["@reticlehq/server", "mcp"]\n';

interface AgentWriteResult {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  /** What actually happened, which is not always what was planned. */
  readonly action: AgentAction | 'created' | 'merged';
  readonly why: string;
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Write what the plan says to write, and nothing else.
 *
 * A step that fails becomes a `manual` result rather than an exception: one unwritable config on a
 * machine with a dozen agents is not a reason to abandon the other eleven, and the user needs to be
 * told which one to do by hand.
 */
export function applyAgentPlan(
  plan: readonly AgentPlanStep[],
  io: AgentWriterIo,
): AgentWriteResult[] {
  return plan.map((step): AgentWriteResult => {
    const base = { id: step.id, name: step.name, file: step.file, why: step.why };
    if (
      AgentAction.SKIP === step.action ||
      AgentAction.ALREADY === step.action ||
      AgentAction.MANUAL === step.action
    ) {
      return { ...base, action: step.action };
    }
    try {
      io.mkdirp(parentOf(step.file));
      if (AgentAction.CREATE_YAML === step.action) {
        io.writeFile(step.file, CONTINUE_YAML);
        return { ...base, action: 'created' };
      }
      const key = step.key;
      if (undefined === key || undefined === step.entry) {
        return {
          ...base,
          action: AgentAction.MANUAL,
          why: 'the plan named no key or entry to write',
        };
      }
      // Only our key. Everything else in the file is read and written back untouched.
      const current: Record<string, unknown> =
        AgentAction.MERGE === step.action
          ? (JSON.parse(io.readFile(step.file)) as Record<string, unknown>)
          : {};
      const bucket = current[key];
      const servers =
        'object' === typeof bucket && null !== bucket ? (bucket as Record<string, unknown>) : {};
      const next = { ...current, [key]: { ...servers, [RETICLE_KEY]: step.entry } };
      io.writeFile(step.file, `${JSON.stringify(next, null, INDENT)}\n`);
      return { ...base, action: AgentAction.MERGE === step.action ? 'merged' : 'created' };
    } catch (err) {
      return {
        ...base,
        action: AgentAction.MANUAL,
        why: `could not write it (${String((err as Error)?.message ?? err).slice(0, 120)})`,
      };
    }
  });
}

/** The `/reticle` instruction, for agents that load skills from a directory. */
export const RETICLE_SKILL = `---
name: reticle
description: Verify a change against the running app, from inside it, before calling it done.
---

Reticle exposes the running app to you as \`reticle_*\` MCP tools. Look, act, observe, assert.

Only \`reticle_act_and_wait\` and \`reticle_assert\` produce a verdict. Everything else moves or
reads the app and proves nothing, so a drive that ends without one of those has no result however
many tools it used.

\`verified: "unknown"\` is not a pass: it means Reticle could not tell what happened.
\`verified: "no-fault"\` is not a pass either, because nothing was declared to prove. Never weaken a
check to make it pass.

The cheapest path that answers the question:

- "did my edit break anything?" -> \`reticle_run({ tool: "reticle_verify", args: { action: "change", files: [...] } })\`
- "does this known journey still work?" -> \`reticle_run({ tool: "reticle_flow_replay", args: { flowName: "..." } })\`
- "does this new behaviour work?" -> \`reticle_act_sequence\` for the setup, then ONE \`reticle_act_and_wait\`
`;

interface SkillWriteResult {
  readonly id: string;
  readonly file: string;
}

/**
 * Write the skill for agents that have somewhere to put it, and only where they are installed.
 *
 * Scaffolding a skills tree for software somebody does not have is litter, and unlike a config file
 * it is not even inert: it is a directory that appears in their home for no reason they can trace.
 */
export function applyAgentSkills(
  io: AgentWriterIo,
  where: { readonly home: string; readonly platform: keyof PlatformPaths },
): SkillWriteResult[] {
  const written: SkillWriteResult[] = [];
  const join = joinFor(where.platform);
  for (const client of AGENT_CLIENTS) {
    const dir = client.skillDir;
    if (undefined === dir) continue;
    if (!io.exists(join(where.home, client.marker[where.platform]))) continue;
    try {
      const target = join(where.home, dir);
      io.mkdirp(target);
      io.writeFile(join(target, 'SKILL.md'), RETICLE_SKILL);
      written.push({ id: client.id, file: join(target, 'SKILL.md') });
    } catch {
      /* an unwritable home directory is not a reason to fail an install */
    }
  }
  return written;
}
