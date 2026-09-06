/**
 * Where each agent keeps its MCP config, and how to write ours into it.
 *
 * `init` knew two clients: Claude Code (a CLI shell-out) and Cursor (a JSON merge). Everything else
 * got a printed snippet. That is the blocker under the whole release matrix — a per-client release
 * artifact for a client `init` cannot wire measures whether somebody pasted JSON correctly, not
 * whether the product works.
 *
 * Every path and shape below was read from the client's own documentation rather than recalled,
 * because they differ in ways that look like they should not:
 *
 *   Cursor / Windsurf / Gemini   `mcpServers: { name: { command, args } }` — one shape, three paths
 *   VS Code                      `servers:` — a different key entirely
 *   OpenCode                     `mcp: { name: { type, command: [cmd, ...args] } }` — an ARRAY
 *   Codex                        TOML
 *
 * A single "write mcp.json" assuming the Cursor shape would produce a file three of these ignore:
 * an install that reports success and registers nothing, which is the exact failure class this
 * repo's install gate exists to catch.
 */
import { NPX, MCP_SERVER_NAME, npxServerArgs, isReticleRegistration } from './mcp.js';
import { codexServerTokens } from './codex-toml.js';

export const McpClient = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  WINDSURF: 'windsurf',
  OPENCODE: 'opencode',
  ANTIGRAVITY: 'antigravity',
  CODEX: 'codex',
  GEMINI: 'gemini',
  VSCODE: 'vscode',
} as const;
export type McpClient = (typeof McpClient)[keyof typeof McpClient];

/** Where the config lives. `cli` means the client owns registration and we shell out to it. */
export const ConfigScope = {
  HOME: 'home',
  PROJECT: 'project',
  CLI: 'cli',
} as const;
export type ConfigScope = (typeof ConfigScope)[keyof typeof ConfigScope];

/** How the file is written. `toml` is deliberately never auto-merged — see mergeClientConfig. */
export const ConfigFormat = {
  JSON: 'json',
  TOML: 'toml',
  CLI: 'cli',
} as const;
export type ConfigFormat = (typeof ConfigFormat)[keyof typeof ConfigFormat];

export interface ClientSpec {
  id: McpClient;
  label: string;
  scope: ConfigScope;
  /** Relative to `$HOME` for `home`, to the project root for `project`. Empty for `cli`. */
  relPath: string;
  format: ConfigFormat;
  /** The object key holding the server map — `mcpServers`, `servers`, or `mcp`. */
  serversKey: string;
  /** Our entry, in THIS client's shape. */
  entry: () => unknown;
  /** Where the shape came from, so the next person can re-check it rather than trust this file. */
  docs: string;
}

/** The `{ command, args }` entry Cursor, Windsurf, Gemini and VS Code all take. */
function commandArgsEntry(): Record<string, unknown> {
  return { command: NPX, args: npxServerArgs() };
}

/**
 * OpenCode's entry. `command` is a single ARRAY containing the executable and its arguments, and
 * `enabled` is explicit — a server registered but disabled is the quietest possible failure.
 */
function openCodeEntry(): Record<string, unknown> {
  return { type: 'local', command: [NPX, ...npxServerArgs()], enabled: true };
}

export const MCP_CLIENTS: readonly ClientSpec[] = [
  {
    id: McpClient.CLAUDE_CODE,
    label: 'Claude Code',
    scope: ConfigScope.CLI,
    relPath: '',
    format: ConfigFormat.CLI,
    serversKey: 'mcpServers',
    entry: commandArgsEntry,
    docs: 'registered via `claude mcp add -s user` — see init/mcp.ts',
  },
  {
    id: McpClient.CURSOR,
    label: 'Cursor',
    scope: ConfigScope.HOME,
    relPath: '.cursor/mcp.json',
    format: ConfigFormat.JSON,
    serversKey: 'mcpServers',
    entry: commandArgsEntry,
    docs: 'https://docs.cursor.com — global ~/.cursor/mcp.json, or ./.cursor/mcp.json per project',
  },
  {
    id: McpClient.WINDSURF,
    label: 'Windsurf',
    scope: ConfigScope.HOME,
    relPath: '.codeium/windsurf/mcp_config.json',
    format: ConfigFormat.JSON,
    serversKey: 'mcpServers',
    entry: commandArgsEntry,
    docs: 'Windsurf docs — ~/.codeium/windsurf/mcp_config.json (same shape as Cursor, different path)',
  },
  {
    id: McpClient.GEMINI,
    label: 'Gemini CLI',
    scope: ConfigScope.HOME,
    relPath: '.gemini/settings.json',
    format: ConfigFormat.JSON,
    serversKey: 'mcpServers',
    entry: commandArgsEntry,
    docs: 'https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html',
  },
  {
    id: McpClient.VSCODE,
    label: 'VS Code (Copilot)',
    scope: ConfigScope.PROJECT,
    relPath: '.vscode/mcp.json',
    format: ConfigFormat.JSON,
    // NOT `mcpServers`. Writing that key here registers nothing and reports success.
    serversKey: 'servers',
    entry: commandArgsEntry,
    docs: 'VS Code MCP docs — .vscode/mcp.json, key is `servers`',
  },
  {
    id: McpClient.OPENCODE,
    label: 'OpenCode',
    /**
     * HOME, not PROJECT — OpenCode is installed globally and configured globally, like Cursor.
     *
     * It was project-scoped as `opencode.json`, and registration is gated on the marker already
     * existing, so a project that had never written one was skipped in SILENCE: the user has OpenCode
     * installed, `init` says nothing about it, and the tools never appear. In the field every OpenCode
     * user connected a client and produced zero tool calls and zero app connections, which is what
     * "you were never wired" looks like from outside.
     *
     * Path verified against a real install (OpenCode 1.3.17), not recalled. The extension is `.jsonc`,
     * which the old project marker could not have matched even where a project config existed. JSONC
     * permits comments, and a config that genuinely has them fails to parse — which `mergeClientConfig`
     * already answers with MANUAL and a printed block, rather than rewriting somebody's file and
     * dropping their comments.
     */
    scope: ConfigScope.HOME,
    relPath: '.config/opencode/opencode.jsonc',
    format: ConfigFormat.JSON,
    serversKey: 'mcp',
    entry: openCodeEntry,
    docs: 'https://opencode.ai/docs/config — `mcp` key, type:"local", command is an array',
  },
  {
    id: McpClient.ANTIGRAVITY,
    label: 'Antigravity',
    /**
     * Nine users connected an MCP client through Antigravity and drove nothing at all.
     *
     * `init` did not know this client, so they hand-wired a registration - the connections are in the
     * field data, so they got that far - and then never ran `init`, never instrumented an app, and
     * never called a tool. Nothing in that state tells anyone there is a second half.
     *
     * Path and shape from Google's documentation rather than recall: `mcpServers`, at
     * `~/.gemini/config/mcp_config.json`, and one file serves the 2.0 IDE, the CLI and the SDK. Same
     * `command`/`args` object Cursor, Windsurf and Gemini CLI already use.
     *
     * It shares the `~/.gemini` tree with Gemini CLI, which is why the marker matters: registration is
     * gated on the marker DIRECTORY, and these resolve to `.gemini/config` and `.gemini` respectively,
     * so having one installed cannot make `init` write a config for the other.
     *
     * NOT verified against a running install. The path is documented, the merge is the shared JSON
     * path that every other client here uses, and an unparseable config still degrades to a printed
     * block rather than a rewrite.
     */
    scope: ConfigScope.HOME,
    relPath: '.gemini/config/mcp_config.json',
    format: ConfigFormat.JSON,
    serversKey: 'mcpServers',
    entry: commandArgsEntry,
    docs: 'https://antigravity.google/docs/mcp — ~/.gemini/config/mcp_config.json, `mcpServers` key',
  },
  {
    id: McpClient.CODEX,
    label: 'Codex CLI',
    scope: ConfigScope.HOME,
    relPath: '.codex/config.toml',
    format: ConfigFormat.TOML,
    serversKey: 'mcp_servers',
    entry: commandArgsEntry,
    docs: 'https://developers.openai.com/codex/mcp — ~/.codex/config.toml, [mcp_servers.<name>]',
  },
];

export function clientSpec(id: McpClient): ClientSpec {
  const found = MCP_CLIENTS.find((spec) => spec.id === id);
  if (found === undefined) throw new Error(`no MCP client spec for '${id}'`);
  return found;
}

export const ClientMergeStatus = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type ClientMergeStatus = (typeof ClientMergeStatus)[keyof typeof ClientMergeStatus];

interface ClientMergeResult {
  status: ClientMergeStatus;
  /** Full file content to write. Byte-identical to `existing` when not `apply`. */
  content: string;
}

type ConfigShape = Record<string, unknown>;
type ParseResult = { ok: true; config: ConfigShape } | { ok: false };

function parseConfig(existing: string | null): ParseResult {
  if (null === existing || 0 === existing.trim().length) return { ok: true, config: {} };
  try {
    const parsed: unknown = JSON.parse(existing);
    // Valid JSON that is not a PLAIN OBJECT — `[]`, `3`, `"x"`, `null` — must not fall through to an
    // empty config, because the file then gets rewritten wholesale. Unparseable JSON was always
    // handled conservatively; this adjacent case destroyed the file instead.
    if (typeof parsed !== 'object' || null === parsed || Array.isArray(parsed))
      return { ok: false };
    return { ok: true, config: parsed as ConfigShape };
  } catch {
    return { ok: false };
  }
}

/**
 * Should this entry be left exactly as it is?
 *
 * Two different reasons to leave one alone, and only one is "it is correct":
 *   - it already matches what we would write; or
 *   - it is not an entry WE wrote. Somebody pointing `reticle` at their own local build made a
 *     deliberate choice, and replacing it with the published npx command breaks a setup to fix a
 *     problem they do not have.
 *
 * What IS repaired is a stale entry of our own shape — an old pin, a moved command — which
 * presence-only idempotency reported as "already registered" and never fixed, so an upgrade could
 * not repair the thing an upgrade exists to repair — and a WRONG one, naming a Reticle package that
 * has no MCP server in it (see isReticleRegistration).
 */
function leaveEntryAlone(existing: unknown, spec: ClientSpec): boolean {
  if (JSON.stringify(existing) === JSON.stringify(spec.entry())) return true;
  if (typeof existing !== 'object' || null === existing) return true;
  const record = existing as { command?: unknown; args?: unknown };
  // Both shapes carry the package name somewhere in a string; find it without assuming which field.
  const tokens = [record.command, record.args].flat().filter((v) => 'string' === typeof v);
  return !isReticleRegistration(tokens);
}

/**
 * Is this TOML config's existing entry one we should leave exactly as it is?
 *
 * The TOML half of {@link leaveEntryAlone}, over the strings the config declares rather than a
 * parsed object. `false` when the table is absent, when it is a Reticle registration that has
 * drifted from what we would write, and when the shape was not one the scanner reads — every one of
 * those keeps today's MANUAL answer, and the snippet is then the actionable thing to print.
 */
function tomlEntryIsSettled(spec: ClientSpec, existing: string | null): boolean {
  const tokens = codexServerTokens(existing, spec.serversKey);
  if (0 === tokens.length) return false;
  const expected = [NPX, ...npxServerArgs()];
  // Same strings, and no others: an entry carrying an extra flag is not the one we would write.
  if (tokens.length === expected.length && expected.every((t) => tokens.includes(t))) return true;
  // Not ours to touch. Somebody pointing `reticle` at their own local build made a deliberate
  // choice, and telling them to hand-edit it back is the same wrong answer as overwriting it.
  return !isReticleRegistration(tokens);
}

/**
 * Merge our server into this client's config.
 *
 * TOML is never auto-merged. Editing TOML without a parser is how a config file gets corrupted, and
 * a corrupted `~/.codex/config.toml` costs the user every server they had, not just ours. Printing
 * the exact block is honest; writing a guess is not — so Codex returns MANUAL with a snippet.
 *
 * Not writing it is no reason not to READ it, though. Reporting `add this by hand` to somebody who
 * already has the table is a warning they must not act on, and the setup contract makes a `⚠`
 * blocking (#681). Detection is read-only and cannot corrupt anything.
 */
export function mergeClientConfig(spec: ClientSpec, existing: string | null): ClientMergeResult {
  if (spec.format !== ConfigFormat.JSON) {
    if (ConfigFormat.TOML === spec.format && tomlEntryIsSettled(spec, existing)) {
      return { status: ClientMergeStatus.ALREADY, content: existing ?? '' };
    }
    return { status: ClientMergeStatus.MANUAL, content: existing ?? '' };
  }
  const parsed = parseConfig(existing);
  if (!parsed.ok) return { status: ClientMergeStatus.MANUAL, content: existing ?? '' };

  const config = parsed.config;
  const current = config[spec.serversKey];
  const servers: Record<string, unknown> =
    'object' === typeof current && null !== current && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};

  if (
    Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME) &&
    leaveEntryAlone(servers[MCP_SERVER_NAME], spec)
  ) {
    return { status: ClientMergeStatus.ALREADY, content: existing ?? '' };
  }

  // Only OUR key is replaced; every other server and top-level key is carried through untouched.
  const merged: ConfigShape = {
    ...config,
    [spec.serversKey]: { ...servers, [MCP_SERVER_NAME]: spec.entry() },
  };
  return { status: ClientMergeStatus.APPLY, content: `${JSON.stringify(merged, null, 2)}\n` };
}

/**
 * A block the user can paste, for a client we could not write.
 *
 * Every client gets one, including the ones we CAN write: when a merge comes back MANUAL because the
 * file could not be parsed, the snippet is the only actionable thing left to give.
 */
export function clientSnippet(spec: ClientSpec): string {
  if (spec.format === ConfigFormat.TOML) {
    const args = npxServerArgs()
      .map((a) => `"${a}"`)
      .join(', ');
    return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${NPX}"\nargs = [${args}]\n`;
  }
  if (spec.format === ConfigFormat.CLI) {
    return `claude mcp add -s user ${MCP_SERVER_NAME} -- ${NPX} ${npxServerArgs().join(' ')}\n`;
  }
  return `${JSON.stringify({ [spec.serversKey]: { [MCP_SERVER_NAME]: spec.entry() } }, null, 2)}\n`;
}

/**
 * The path whose existence means "this user has this client".
 *
 * Detection is deliberately conservative and one-directional: we write into a config a client
 * ALREADY has, and never create `~/.gemini/` or `~/.codeium/` for somebody who does not use them.
 * Littering a home directory to register a server nobody asked for is worse than printing a snippet.
 *
 * For a `home` client this is the directory above its config; for a `project` client it is the
 * config file (or its directory) inside the repo, which is unambiguous evidence somebody uses it
 * here. Same reasoning as Cursor's existing rule, which also accepts a project-level `.cursor/`
 * because a fresh Cursor profile has not written `~/.cursor` yet.
 */
export function clientMarkerRelPath(spec: ClientSpec): string {
  if (spec.scope === ConfigScope.CLI) return '';
  const parts = spec.relPath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : spec.relPath;
}

/**
 * Project-relative directory whose presence signals Cursor is in use for this repo.
 *
 * A fresh Cursor profile has not written `~/.cursor` yet, so the home marker alone misses real
 * users. A project-level `.cursor/` is unambiguous evidence somebody uses Cursor here.
 */
export const CURSOR_PROJECT_MARKER = '.cursor';

/** Clients `init` can wire by writing a file — everything but the CLI-registered one. */
export function fileBackedClients(): readonly ClientSpec[] {
  return MCP_CLIENTS.filter((spec) => spec.scope !== ConfigScope.CLI);
}
