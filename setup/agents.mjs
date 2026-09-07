/**
 * Register the Reticle MCP server with every coding agent on the machine — and leave a record for
 * the ones that arrive later.
 *
 * `reticle init` already covers eight clients. This covers the rest, and the difference matters:
 * an agent whose config we never write is an agent whose user has no reticle_* tools and no way to
 * know why. VS Code's USER-scope mcp.json is the sharpest example — it exists on machines today and
 * init only ever writes the project-scope `.vscode/mcp.json`.
 *
 * Three rules, and the second is the one that keeps this honest:
 *
 * 1. A path with OFFICIAL documentation is written even when the agent is absent, so a later
 *    install picks it up with no action. That is the "future installs" case.
 * 2. A path that is only COMMUNITY-sourced is written only when the agent is detected. Cline's and
 *    Roo's live under VS Code globalStorage, which moves under Insiders, portable installs, and a
 *    custom --user-data-dir. Writing a guessed path produces a file nobody reads, which is
 *    indistinguishable from success — the exact failure mode this whole effort exists to remove.
 * 3. A format we cannot safely merge (TOML, YAML, JSONC with comments) is never rewritten. We print
 *    the snippet instead. Reformatting somebody's config to add one entry is not ours to do.
 */

import { homedir, platform } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Join the way the TARGET platform joins, not the way this machine does.
 *
 * Every planner here already takes an `os` and picks a per-platform path from it, then joined the
 * pieces with the host's own separator. On a Windows machine that produced `C:\\Users\\me/Library/...`
 * for the darwin rows, so the planners were only ever correct for the platform they ran on. The CLI
 * had the identical defect and the identical fix; `agents.test.mjs` asserts every platform's rows
 * from one host, so it fails on Windows and passes on macOS until the join follows the argument.
 */
const joinFor = (os) => ('win32' === os ? win32.join : posix.join);

export const Confidence = { OFFICIAL: 'official', COMMUNITY: 'community' };

/** The server entry, in each shape the various clients expect. */
const STDIO = { command: 'npx', args: ['@reticlehq/server', 'mcp'] };

/**
 * Every client we know how to register, and where.
 *
 * `paths` is keyed by platform; a missing key means "same as posix". Paths are relative to home
 * unless they start with a platform variable.
 */
export const CLIENTS = [
  {
    id: 'vscode-user',
    name: 'VS Code (user scope)',
    confidence: Confidence.OFFICIAL,
    format: 'jsonc',
    key: 'servers',
    entry: { type: 'stdio', ...STDIO },
    paths: {
      darwin: 'Library/Application Support/Code/User/mcp.json',
      linux: '.config/Code/User/mcp.json',
      win32: 'AppData/Roaming/Code/User/mcp.json',
    },
    marker: {
      darwin: 'Library/Application Support/Code/User',
      linux: '.config/Code/User',
      win32: 'AppData/Roaming/Code/User',
    },
  },
  {
    id: 'zed',
    name: 'Zed',
    confidence: Confidence.OFFICIAL,
    format: 'jsonc',
    // NOT `mcpServers`. Zed calls them context servers, and the wrong key writes a file it ignores.
    key: 'context_servers',
    entry: { ...STDIO, env: {} },
    paths: {
      darwin: '.config/zed/settings.json',
      linux: '.config/zed/settings.json',
      win32: 'AppData/Roaming/Zed/settings.json',
    },
    marker: { darwin: '.config/zed', linux: '.config/zed', win32: 'AppData/Roaming/Zed' },
    skillDir: '.agents/skills/reticle',
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin: '.copilot/mcp-config.json',
      linux: '.copilot/mcp-config.json',
      win32: '.copilot/mcp-config.json',
    },
    marker: { darwin: '.copilot', linux: '.copilot', win32: '.copilot' },
  },
  {
    id: 'warp',
    name: 'Warp',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: { darwin: '.warp/.mcp.json', linux: '.warp/.mcp.json', win32: '.warp/.mcp.json' },
    marker: { darwin: '.warp', linux: '.warp', win32: '.warp' },
  },
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: { type: 'stdio', ...STDIO },
    paths: { darwin: '.factory/mcp.json', linux: '.factory/mcp.json', win32: '.factory/mcp.json' },
    marker: { darwin: '.factory', linux: '.factory', win32: '.factory' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin: '.kiro/settings/mcp.json',
      linux: '.kiro/settings/mcp.json',
      win32: '.kiro/settings/mcp.json',
    },
    marker: { darwin: '.kiro', linux: '.kiro', win32: '.kiro' },
    skillDir: '.kiro/steering',
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer CLI',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin: '.aws/amazonq/mcp.json',
      linux: '.aws/amazonq/mcp.json',
      win32: '.aws/amazonq/mcp.json',
    },
    marker: { darwin: '.aws/amazonq', linux: '.aws/amazonq', win32: '.aws/amazonq' },
  },
  {
    id: 'cline-cli',
    name: 'Cline CLI',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: { darwin: '.cline/mcp.json', linux: '.cline/mcp.json', win32: '.cline/mcp.json' },
    marker: { darwin: '.cline', linux: '.cline', win32: '.cline' },
  },
  {
    id: 'amp',
    name: 'Amp',
    confidence: Confidence.OFFICIAL,
    format: 'json',
    // A DOTTED key at the top level, not nested under "amp". Nesting it writes a file Amp ignores.
    key: 'amp.mcpServers',
    entry: STDIO,
    paths: {
      darwin: '.config/amp/settings.json',
      linux: '.config/amp/settings.json',
      win32: '.config/amp/settings.json',
    },
    marker: { darwin: '.config/amp', linux: '.config/amp', win32: '.config/amp' },
  },
  {
    id: 'cline',
    name: 'Cline (VS Code extension)',
    // Community-sourced, and it moves under Insiders / portable / --user-data-dir.
    confidence: Confidence.COMMUNITY,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin:
        'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      linux:
        '.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      win32:
        'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    },
    marker: {
      darwin: 'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev',
      linux: '.config/Code/User/globalStorage/saoudrizwan.claude-dev',
      win32: 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev',
    },
    // The host's own user directory. Its presence is evidence this machine uses the STANDARD VS
    // Code layout rather than Insiders, a portable install, or a custom --user-data-dir — which is
    // the only thing that made these paths a guess. With that evidence, pre-creating for a
    // not-yet-installed extension is reasonable; without it we still refuse.
    parentMarker: {
      darwin: 'Library/Application Support/Code/User',
      linux: '.config/Code/User',
      win32: 'AppData/Roaming/Code/User',
    },
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    confidence: Confidence.COMMUNITY,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin:
        'Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
      linux:
        '.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
      win32:
        'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    },
    marker: {
      darwin: 'Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline',
      linux: '.config/Code/User/globalStorage/rooveterinaryinc.roo-cline',
      win32: 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline',
    },
    parentMarker: {
      darwin: 'Library/Application Support/Code/User',
      linux: '.config/Code/User',
      win32: 'AppData/Roaming/Code/User',
    },
  },
  {
    id: 'continue',
    name: 'Continue',
    confidence: Confidence.OFFICIAL,
    // YAML, and `mcpServers` is a LIST whose items carry a `name`. We do not rewrite YAML.
    format: 'yaml-manual',
    key: 'mcpServers',
    paths: {
      darwin: '.continue/config.yaml',
      linux: '.continue/config.yaml',
      win32: '.continue/config.yaml',
    },
    marker: { darwin: '.continue', linux: '.continue', win32: '.continue' },
  },
];

const p = (spec, os) => spec[os] ?? spec.linux;

/**
 * What to do for each client, without touching the disk.
 *
 * `exists(path)` is injected so this is testable on any machine, for any platform, against any
 * pretend filesystem — which is the only way the Windows rows get checked from a Mac.
 */
export function planAgents({ home = homedir(), os = platform(), exists, readFile }) {
  return CLIENTS.map((c) => {
    const file = joinFor(os)(home, p(c.paths, os));
    const detected = exists(joinFor(os)(home, p(c.marker, os)));
    // Writing a NEW yaml file is safe — there is nobody's formatting to destroy. Editing one is
    // not: `mcpServers` there is a list of named entries, and a naive rewrite loses comments,
    // anchors and ordering. So: create when absent, hand it to a human when present.
    if (c.format === 'yaml-manual') {
      if (exists(file))
        return {
          id: c.id,
          name: c.name,
          file,
          action: 'manual',
          why: 'its config is YAML and already exists — rewriting it would lose comments and ordering',
        };
      return {
        id: c.id,
        name: c.name,
        file,
        action: 'create-yaml',
        why: 'no config yet, so a valid one can be written outright',
      };
    }
    const layoutKnown =
      c.parentMarker !== undefined && exists(joinFor(os)(home, p(c.parentMarker, os)));
    if (!detected && c.confidence === Confidence.COMMUNITY && !layoutKnown) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: 'skip',
        why: "not installed, and without its host's standard layout on this machine its path is a guess — a guessed path creates a file nobody reads",
      };
    }
    if (!exists(file)) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: 'create',
        key: c.key,
        entry: c.entry,
        why: detected
          ? 'installed, no config yet'
          : 'documented path, so a later install finds it already wired',
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFile(file));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: 'manual',
        key: c.key,
        entry: c.entry,
        why: "existing config is not plain JSON (comments or trailing commas) — rewriting it would reformat somebody else's file",
      };
    }
    const already = parsed?.[c.key]?.reticle;
    if (already !== undefined) {
      const ours = JSON.stringify(already) === JSON.stringify(c.entry);
      return {
        id: c.id,
        name: c.name,
        file,
        action: ours ? 'already' : 'manual',
        key: c.key,
        entry: c.entry,
        why: ours
          ? 'already registered'
          : 'a different `reticle` entry is there and is not ours to replace',
      };
    }
    return {
      id: c.id,
      name: c.name,
      file,
      action: 'merge',
      key: c.key,
      entry: c.entry,
      why: 'adding our key beside the servers already there',
    };
  });
}

/** The `/reticle` instruction we leave for agents that load skills from a directory. */
export const SKILL_BODY = `---
name: reticle
description: Verify a change against the running app, from inside it, before calling it done.
---

Reticle exposes the running app to you as \`reticle_*\` MCP tools. Look, act, observe, assert.

Only \`reticle_act_and_wait\` and \`reticle_assert\` produce a verdict. Everything else moves or
reads the app and proves nothing, so a drive that ends without one of those has no result however
many tools it used.

\`verified: "unknown"\` is not a pass — it means Reticle could not tell what happened.
\`verified: "no-fault"\` is not a pass either — nothing was declared to prove. Never weaken a check
to make it pass.

The cheapest path that answers the question:
- "did my edit break anything?" -> \`reticle_run({ tool: "reticle_verify", args: { action: "change", files: [...] } })\`
- "does this known journey still work?" -> \`reticle_run({ tool: "reticle_flow_replay", args: { flowName: "..." } })\`
- "does this new behaviour work?" -> \`reticle_act_sequence\` for setup, then ONE \`reticle_act_and_wait\`
`;

/**
 * Carry out a plan. Returns one line per client, and writes nothing it was not asked to.
 *
 * `merge` only ever adds our key: the rest of somebody's config is copied through untouched, and
 * indentation is two spaces because that is what every one of these files already uses.
 */
export function applyAgents(rows, io) {
  const done = [];
  for (const r of rows) {
    if (r.action === 'skip' || r.action === 'already') {
      done.push(r);
      continue;
    }
    if (r.action === 'manual') {
      done.push(r);
      continue;
    }
    try {
      if (r.action === 'create-yaml') {
        io.mkdir(r.file.slice(0, r.file.lastIndexOf('/')));
        io.writeFile(
          r.file,
          'mcpServers:\n  - name: reticle\n    type: stdio\n    command: npx\n    args: ["@reticlehq/server", "mcp"]\n',
        );
        done.push({ ...r, action: 'created' });
        continue;
      }
      const current = r.action === 'merge' ? JSON.parse(io.readFile(r.file)) : {};
      const next = { ...current, [r.key]: { ...(current[r.key] ?? {}), reticle: r.entry } };
      io.mkdir(r.file.slice(0, r.file.lastIndexOf('/')));
      io.writeFile(r.file, `${JSON.stringify(next, null, 2)}\n`);
      done.push({ ...r, action: r.action === 'merge' ? 'merged' : 'created' });
    } catch (err) {
      done.push({
        ...r,
        action: 'manual',
        why: `could not write it: ${String(err.message ?? err)}`,
      });
    }
  }
  return done;
}

/** Skill files, for the agents that load them from a directory. */
export function applySkills(io, { home = homedir(), os = platform() } = {}) {
  const written = [];
  for (const c of CLIENTS) {
    if (c.skillDir === undefined) continue;
    if (!io.exists(joinFor(os)(home, p(c.marker, os)))) continue; // never scaffold a skills tree for an absent agent
    const dir = joinFor(os)(home, c.skillDir);
    try {
      io.mkdir(dir);
      io.writeFile(joinFor(os)(dir, 'SKILL.md'), SKILL_BODY);
      written.push({ id: c.id, file: joinFor(os)(dir, 'SKILL.md') });
    } catch {
      /* an unwritable home directory is not a reason to fail an install */
    }
  }
  return written;
}
