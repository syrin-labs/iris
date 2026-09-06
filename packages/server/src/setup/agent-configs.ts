/**
 * The coding agents `init`'s own MCP registration does not reach, and where their config lives.
 *
 * `init` covers eight clients and only where it already finds them. That leaves real holes: VS
 * Code's USER-scope mcp.json exists on machines today and init only ever writes the project-scope
 * one, so a VS Code user has no tools outside the directory they ran init in. Zed, Warp, Kiro, Amp,
 * Copilot CLI, Amazon Q, Factory Droid, Cline and Roo are not covered at all.
 *
 * Three rules, and the second is what keeps this honest:
 *
 * 1. A path with OFFICIAL documentation is written even when the agent is absent, so a later
 *    install finds itself already wired.
 * 2. A path we cannot evidence is REFUSED. Cline's and Roo's live under VS Code globalStorage,
 *    which moves under Insiders, portable installs and a custom --user-data-dir; they are written
 *    only where the host's standard layout is present. A config file at a guessed location is one
 *    nobody reads, which is indistinguishable from success.
 * 3. A format we cannot merge safely is never rewritten. TOML, an existing YAML, JSONC carrying
 *    comments: we print the snippet instead. Reformatting somebody's config to add one entry is
 *    not ours to do.
 */

import { posix, win32 } from 'node:path';

export const AgentConfidence = {
  /** Documented by the vendor. Safe to create before the agent exists. */
  OFFICIAL: 'official',
  /** Community-sourced. Only written where the host's own layout proves the path. */
  COMMUNITY: 'community',
} as const;
export type AgentConfidence = (typeof AgentConfidence)[keyof typeof AgentConfidence];

export const AgentAction = {
  CREATE: 'create',
  CREATE_YAML: 'create-yaml',
  MERGE: 'merge',
  ALREADY: 'already',
  MANUAL: 'manual',
  SKIP: 'skip',
} as const;
export type AgentAction = (typeof AgentAction)[keyof typeof AgentAction];

const NPX = 'npx';
const SERVER_PACKAGE = '@reticlehq/server';
const MCP_SUBCOMMAND = 'mcp';
const RETICLE_KEY = 'reticle';
/** The stdio entry, in the shape most clients expect. */
const STDIO = { command: NPX, args: [SERVER_PACKAGE, MCP_SUBCOMMAND] } as const;

/** Per-platform relative paths, from the user's home directory. */
export interface PlatformPaths {
  readonly darwin: string;
  readonly linux: string;
  readonly win32: string;
}

interface AgentClient {
  readonly id: string;
  readonly name: string;
  readonly confidence: AgentConfidence;
  /** `json` merges; `yaml-manual` is only ever created fresh, never edited. */
  readonly format: 'json' | 'yaml-manual';
  /** Where the server map lives. Getting this wrong writes a file the client silently ignores. */
  readonly key: string;
  readonly entry?: Readonly<Record<string, unknown>> | undefined;
  readonly paths: PlatformPaths;
  /** Existence proves the agent is installed. */
  readonly marker: PlatformPaths;
  /** The HOST's directory, when the marker belongs to an extension rather than the app. */
  readonly parentMarker?: PlatformPaths | undefined;
  /** Where this agent loads reusable skills from, when it has such a place. */
  readonly skillDir?: string | undefined;
}

const VSCODE_USER: PlatformPaths = {
  darwin: 'Library/Application Support/Code/User',
  linux: '.config/Code/User',
  win32: 'AppData/Roaming/Code/User',
};

export const AGENT_CLIENTS: readonly AgentClient[] = [
  {
    id: 'vscode-user',
    name: 'VS Code (user scope)',
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
    key: 'servers',
    entry: { type: 'stdio', ...STDIO },
    paths: {
      darwin: `${VSCODE_USER.darwin}/mcp.json`,
      linux: `${VSCODE_USER.linux}/mcp.json`,
      win32: `${VSCODE_USER.win32}/mcp.json`,
    },
    marker: VSCODE_USER,
  },
  {
    id: 'zed',
    name: 'Zed',
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
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
    confidence: AgentConfidence.OFFICIAL,
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
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: { darwin: '.warp/.mcp.json', linux: '.warp/.mcp.json', win32: '.warp/.mcp.json' },
    marker: { darwin: '.warp', linux: '.warp', win32: '.warp' },
  },
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: { type: 'stdio', ...STDIO },
    paths: { darwin: '.factory/mcp.json', linux: '.factory/mcp.json', win32: '.factory/mcp.json' },
    marker: { darwin: '.factory', linux: '.factory', win32: '.factory' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    confidence: AgentConfidence.OFFICIAL,
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
    confidence: AgentConfidence.OFFICIAL,
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
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: { darwin: '.cline/mcp.json', linux: '.cline/mcp.json', win32: '.cline/mcp.json' },
    marker: { darwin: '.cline', linux: '.cline', win32: '.cline' },
  },
  {
    id: 'amp',
    name: 'Amp',
    confidence: AgentConfidence.OFFICIAL,
    format: 'json',
    // A DOTTED key at the TOP level, not nested under "amp". Nesting writes a file Amp ignores.
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
    confidence: AgentConfidence.COMMUNITY,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin: `${VSCODE_USER.darwin}/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
      linux: `${VSCODE_USER.linux}/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
      win32: `${VSCODE_USER.win32}/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
    },
    marker: {
      darwin: `${VSCODE_USER.darwin}/globalStorage/saoudrizwan.claude-dev`,
      linux: `${VSCODE_USER.linux}/globalStorage/saoudrizwan.claude-dev`,
      win32: `${VSCODE_USER.win32}/globalStorage/saoudrizwan.claude-dev`,
    },
    parentMarker: VSCODE_USER,
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    confidence: AgentConfidence.COMMUNITY,
    format: 'json',
    key: 'mcpServers',
    entry: STDIO,
    paths: {
      darwin: `${VSCODE_USER.darwin}/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`,
      linux: `${VSCODE_USER.linux}/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`,
      win32: `${VSCODE_USER.win32}/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`,
    },
    marker: {
      darwin: `${VSCODE_USER.darwin}/globalStorage/rooveterinaryinc.roo-cline`,
      linux: `${VSCODE_USER.linux}/globalStorage/rooveterinaryinc.roo-cline`,
      win32: `${VSCODE_USER.win32}/globalStorage/rooveterinaryinc.roo-cline`,
    },
    parentMarker: VSCODE_USER,
  },
  {
    id: 'continue',
    name: 'Continue',
    confidence: AgentConfidence.OFFICIAL,
    // YAML, whose `mcpServers` is a LIST of named entries. We create one; we never rewrite one.
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

/** What to do for one client, decided without touching the disk. */
export interface AgentPlanStep {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly action: AgentAction;
  readonly key?: string | undefined;
  readonly entry?: Readonly<Record<string, unknown>> | undefined;
  readonly why: string;
}

interface AgentPlanInput {
  readonly home: string;
  readonly platform: keyof PlatformPaths;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
}

const forPlatform = (p: PlatformPaths, os: keyof PlatformPaths): string => p[os];

/**
 * Join for the platform the CALLER named, never the one this process happens to run on.
 *
 * Every planner here takes `platform` as an argument and claims to be pure over it — the doc below
 * says the Windows rows are "testable from any machine". `node:path`'s bare `join` broke that claim
 * silently in both directions: a mac planning win32 rows emitted `/` separators into paths Windows
 * cannot use, and a Windows host planning linux rows emitted `\`. The second half is what turned
 * the whole Windows CI job red — the pure planners returned `\home\u\.claude\settings.json`,
 * every injected filesystem is keyed by the POSIX path the caller asked for, so every lookup missed
 * and every row came back `absent`/`skip`. Twenty-eight tests failed for a reason that had nothing
 * to do with what they were testing, which left the platform with the most users unwatched.
 *
 * A separator is part of the answer, so it belongs to the platform being planned for.
 */
export const joinFor = (os: keyof PlatformPaths): ((...parts: string[]) => string) =>
  'win32' === os ? win32.join : posix.join;

/**
 * Decide what to do for every client. Pure: the filesystem arrives as two functions, which is what
 * makes the Windows rows testable from any machine.
 */
export function planAgentConfigs(input: AgentPlanInput): AgentPlanStep[] {
  const { home, platform, exists, readFile } = input;
  return AGENT_CLIENTS.map((c): AgentPlanStep => {
    const join = joinFor(platform);
    const file = join(home, forPlatform(c.paths, platform));
    const detected = exists(join(home, forPlatform(c.marker, platform)));

    // A NEW yaml file has nobody's formatting to destroy. An existing one does: `mcpServers` there
    // is a list of named entries, and a naive rewrite loses comments, anchors and ordering.
    if ('yaml-manual' === c.format) {
      return exists(file)
        ? {
            id: c.id,
            name: c.name,
            file,
            action: AgentAction.MANUAL,
            why: 'its config is YAML and already exists, so rewriting it would lose comments and ordering',
          }
        : {
            id: c.id,
            name: c.name,
            file,
            action: AgentAction.CREATE_YAML,
            why: 'no config yet, so a valid one can be written outright',
          };
    }

    const layoutKnown =
      c.parentMarker !== undefined && exists(join(home, forPlatform(c.parentMarker, platform)));
    if (!detected && c.confidence === AgentConfidence.COMMUNITY && !layoutKnown) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: AgentAction.SKIP,
        why: "not installed, and without its host's standard layout on this machine its path is a guess: a guessed path creates a file nobody reads",
      };
    }

    if (!exists(file)) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: AgentAction.CREATE,
        key: c.key,
        entry: c.entry,
        why: detected
          ? 'installed, with no config yet'
          : 'a documented path, so a later install finds it already wired',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(file));
    } catch {
      parsed = undefined;
    }
    if ('object' !== typeof parsed || null === parsed) {
      return {
        id: c.id,
        name: c.name,
        file,
        action: AgentAction.MANUAL,
        key: c.key,
        entry: c.entry,
        why: "the existing config is not plain JSON (comments or trailing commas), and rewriting it would reformat somebody else's file",
      };
    }

    const bucket = (parsed as Record<string, unknown>)[c.key];
    const existing =
      'object' === typeof bucket && null !== bucket
        ? (bucket as Record<string, unknown>)[RETICLE_KEY]
        : undefined;
    if (existing !== undefined) {
      const ours = JSON.stringify(existing) === JSON.stringify(c.entry);
      return {
        id: c.id,
        name: c.name,
        file,
        action: ours ? AgentAction.ALREADY : AgentAction.MANUAL,
        key: c.key,
        entry: c.entry,
        why: ours
          ? 'already registered'
          : 'a different `reticle` entry is there, and it is not ours to replace',
      };
    }

    return {
      id: c.id,
      name: c.name,
      file,
      action: AgentAction.MERGE,
      key: c.key,
      entry: c.entry,
      why: 'adding our key beside the servers already there',
    };
  });
}
