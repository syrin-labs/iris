/**
 * Removing the Accept button, for the tools Reticle owns and nothing else.
 *
 * A drive that stops on a per-call approval dialog is not automated, and the dialog is per CALL:
 * a single verification run makes dozens, so a human sits there clicking through a loop that was
 * supposed to run without them. Every client below documents a way to pre-approve a named server,
 * and this writes exactly that rule, at install time, in the client's own spelling.
 *
 * Two limits, both deliberate:
 *
 * 1. ONLY `reticle` is allowed. Not `mcp(*)`, not a global auto-run switch. Reticle's tools drive
 *    the user's own dev server on their own machine, which is what makes pre-approving them
 *    defensible; the same edit made globally would hand the same pass to every other MCP server
 *    they ever install, including ones that reach the network. Their approval gate is not ours to
 *    dismantle, only ours to step out of.
 * 2. Nothing is written for an agent that is not installed. An absent agent has no Accept button to
 *    remove, and the file would be litter — Cursor's especially, since that one TAKES OVER from an
 *    allowlist we cannot read.
 *
 * Codex is absent by design: its approval policy is global (`approval_policy`), so there is no
 * reticle-shaped rule to write, and its config is TOML, which this repo never rewrites. Its
 * headless form, `codex exec`, does not prompt at all — which is the form the drive uses.
 */

import { joinFor, type PlatformPaths } from './agent-configs.js';
import type { AgentWriterIo } from './agent-writer.js';

const RETICLE_KEY = 'reticle';
const INDENT = 2;

/** A documented way to pre-approve one MCP server, in one client's own spelling. */
export interface ApprovalGrant {
  readonly id: string;
  readonly name: string;
  /** Home-relative, per platform. */
  readonly paths: PlatformPaths;
  /** Present if ANY of these exist. An agent that is not installed is not configured. */
  readonly markers: readonly PlatformPaths[];
  /** The rule, in the client's words, for the plan output. */
  readonly rule: string;
  /** Adds our rule to a parsed config, leaving everything else exactly as it was. */
  readonly grant: (current: Record<string, unknown>) => Record<string, unknown>;
  /**
   * True where creating this file supersedes an in-app allowlist we cannot read, so the user has to
   * be told rather than have their other servers quietly start prompting again.
   */
  readonly supersedesInApp?: boolean;
}

const home = (path: string): PlatformPaths => ({ darwin: path, linux: path, win32: path });

/** Append to a nested array, without duplicating and without disturbing what is already in it. */
function addToList(
  current: Record<string, unknown>,
  outer: string | null,
  key: string,
  value: string,
): Record<string, unknown> {
  const scope: Record<string, unknown> =
    null === outer
      ? current
      : 'object' === typeof current[outer] && null !== current[outer]
        ? { ...(current[outer] as Record<string, unknown>) }
        : {};
  const list = Array.isArray(scope[key]) ? (scope[key] as unknown[]) : [];
  if (list.includes(value)) return current;
  const next = { ...scope, [key]: [...list, value] };
  return null === outer ? next : { ...current, [outer]: next };
}

export const APPROVAL_GRANTS: readonly ApprovalGrant[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    paths: home('.claude/settings.json'),
    markers: [home('.claude')],
    rule: 'permissions.allow += "mcp__reticle"',
    grant: (c) => addToList(c, 'permissions', 'allow', 'mcp__reticle'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    paths: home('.cursor/permissions.json'),
    markers: [home('.cursor')],
    rule: 'mcpAllowlist += "reticle:*"',
    // Documented: "when a key appears in permissions.json, it fully replaces the in-app allowlist
    // for that type". Merging keeps everything already in the FILE; it cannot restore what was only
    // ever clicked in the UI, so the user is told.
    supersedesInApp: true,
    grant: (c) => addToList(c, null, 'mcpAllowlist', `${RETICLE_KEY}:*`),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    paths: home('.gemini/antigravity-cli/settings.json'),
    markers: [
      {
        darwin: 'Library/Application Support/Antigravity',
        linux: '.config/Antigravity',
        win32: 'AppData/Roaming/Antigravity',
      },
      home('.gemini/antigravity-cli'),
    ],
    rule: 'permissions.allow += "mcp(reticle/*)"',
    grant: (c) => addToList(c, 'permissions', 'allow', `mcp(${RETICLE_KEY}/*)`),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    paths: home('.gemini/settings.json'),
    markers: [home('.gemini')],
    rule: 'mcpServers.reticle.trust = true',
    // Gemini has no allowlist: trust is a property of the server entry itself, so this reaches into
    // the entry init already wrote rather than adding a rule beside it.
    grant: (c) => {
      const servers =
        'object' === typeof c['mcpServers'] && null !== c['mcpServers']
          ? { ...(c['mcpServers'] as Record<string, unknown>) }
          : {};
      const entry =
        'object' === typeof servers[RETICLE_KEY] && null !== servers[RETICLE_KEY]
          ? (servers[RETICLE_KEY] as Record<string, unknown>)
          : {};
      return { ...c, mcpServers: { ...servers, [RETICLE_KEY]: { ...entry, trust: true } } };
    },
  },
];

export const ApprovalOutcome = {
  GRANTED: 'granted',
  ALREADY: 'already',
  ABSENT: 'absent',
  /** Deliberately left for an explicit run, because doing it unattended costs the user something. */
  DEFERRED: 'deferred',
  FAILED: 'failed',
} as const;
export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export interface ApprovalResult {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly outcome: ApprovalOutcome;
  readonly rule: string;
  /** Set where the user has to be told something the write alone does not say. */
  readonly warn?: string;
}

interface ApprovalWhere {
  readonly home: string;
  readonly platform: keyof PlatformPaths;
}

interface ApprovalOptions {
  /**
   * Refuse any grant that would CREATE a file superseding an allowlist we cannot read.
   *
   * Set on the unattended path. Writing Cursor's permissions.json for the first time takes over
   * from what the user approved inside the app, which is a fair trade when they just ran a command
   * and can read the line saying so, and not a fair trade at all when a version bump did it behind
   * them: their OTHER MCP servers would start prompting again and nothing would connect that to us.
   * Merging into a file they already own stays safe either way.
   */
  readonly onlyIfNoSupersede?: boolean;
}

/**
 * Pre-approve Reticle's tools everywhere the machine has an agent that would otherwise ask.
 *
 * A client that cannot be written is reported, never thrown: one unwritable settings file is not a
 * reason to leave the other three prompting.
 */
export function grantAutoApproval(
  io: AgentWriterIo,
  where: ApprovalWhere,
  grants: readonly ApprovalGrant[] = APPROVAL_GRANTS,
  options: ApprovalOptions = {},
): ApprovalResult[] {
  const join = joinFor(where.platform);
  return grants.map((grant): ApprovalResult => {
    const file = join(where.home, grant.paths[where.platform]);
    const base = { id: grant.id, name: grant.name, file, rule: grant.rule };
    const installed = grant.markers.some((m) => io.exists(join(where.home, m[where.platform])));
    if (!installed) return { ...base, outcome: ApprovalOutcome.ABSENT };
    try {
      const existed = io.exists(file);
      if (true === options.onlyIfNoSupersede && true === grant.supersedesInApp && !existed) {
        return {
          ...base,
          outcome: ApprovalOutcome.DEFERRED,
          warn: `creating ${file} would supersede what you approved inside ${grant.name}, which is not something to do unannounced. Run: npx @reticlehq/server init --files-only`,
        };
      }
      // A settings file we cannot parse is left exactly as it is. Reformatting somebody's config to
      // add one line is a worse outcome than one dialog they have to click.
      const current = existed
        ? (JSON.parse(io.readFile(file)) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
      const next = grant.grant(current);
      if (next === current) return { ...base, outcome: ApprovalOutcome.ALREADY };
      io.mkdirp(file.slice(0, Math.max(0, file.lastIndexOf('/'))));
      io.writeFile(file, `${JSON.stringify(next, null, INDENT)}\n`);
      const warn =
        true === grant.supersedesInApp && !existed
          ? `${file} now governs which MCP tools run without asking; anything you had approved inside ${grant.name} itself will ask again until it is listed here too`
          : undefined;
      return { ...base, outcome: ApprovalOutcome.GRANTED, ...(undefined === warn ? {} : { warn }) };
    } catch (err) {
      return {
        ...base,
        outcome: ApprovalOutcome.FAILED,
        warn: String((err as Error)?.message ?? err).slice(0, 120),
      };
    }
  });
}
