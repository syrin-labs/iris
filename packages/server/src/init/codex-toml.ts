/**
 * Read-only detection of an existing `[mcp_servers.reticle]` table in `~/.codex/config.toml`.
 *
 * `init` printed `[⚠] MCP server (Codex CLI) → ~/.codex/config.toml — add this by hand` on machines
 * whose config ALREADY held a working table with the same command and args, because
 * `mergeClientConfig` short-circuits every non-JSON format to MANUAL without ever reading the file
 * (#681, reported independently twice). The setup instructions tell an agent it MUST resolve a `⚠`,
 * and the install gate's own contract is zero `⚠`, so the warning sent people to hand-edit a global
 * config for no reason.
 *
 * This only ANSWERS a question; it never produces TOML to write. Editing TOML without a parser is
 * how a config gets corrupted, and a corrupted `~/.codex/config.toml` costs the user every server
 * they had — so writing stays MANUAL, exactly as before.
 *
 * A deliberately narrow scanner rather than a TOML parser, because the question is narrow: which
 * strings does one named table's `command` and `args` hold? Anything it cannot read confidently —
 * a multi-line array, an unfamiliar quoting, a shape it has no rule for — yields no tokens and
 * therefore no detection, which is today's behaviour. The failure mode stays "warn when we should
 * not have", never "stay quiet when the server is genuinely unregistered".
 */
import { MCP_SERVER_NAME } from './mcp.js';

/** Strip a `#` comment that is not inside a string literal. */
function withoutComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (undefined !== quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if ('"' === char || "'" === char) {
      quote = char;
      continue;
    }
    if ('#' === char) return line.slice(0, i);
  }
  return line;
}

/** `reticle`, `"reticle"` and `'reticle'` are the same key to TOML. */
function unquote(key: string): string {
  const trimmed = key.trim();
  const first = trimmed[0];
  if (('"' === first || "'" === first) && trimmed.endsWith(first) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Split a dotted TOML key path, respecting quoted segments. */
function keyPath(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of raw) {
    if (undefined !== quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if ('"' === char || "'" === char) {
      quote = char;
      current += char;
      continue;
    }
    if ('.' === char) {
      parts.push(unquote(current));
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(unquote(current));
  return parts.map((p) => p.trim()).filter((p) => 0 < p.length);
}

/** Every double- or single-quoted string in `value`, in order. */
function quotedStrings(value: string): string[] {
  return [...value.matchAll(/"([^"\\]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

/** The table path our server's entry lives under, e.g. `mcp_servers.reticle`. */
function ourTablePath(serversKey: string): string[] {
  return [serversKey, MCP_SERVER_NAME];
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * The `command` and `args` strings the config declares for our server, or `[]` when it declares
 * none — including when the shape was not one this scanner reads.
 *
 * Handles the three forms a Codex config actually takes: the standard table header, a dotted
 * assignment (`mcp_servers.reticle = { … }`), and a key inside an `[mcp_servers]` table.
 */
export function codexServerTokens(existing: string | null, serversKey: string): string[] {
  if (null === existing) return [];
  const want = ourTablePath(serversKey);
  const tokens: string[] = [];
  let table: string[] = [];
  let inOurTable = false;
  /** Set while a `[ ... ]` value is still open across lines; `true` when that value is ours. */
  let openArrayIsOurs: boolean | undefined;

  for (const rawLine of existing.split(/\r?\n/)) {
    const line = withoutComment(rawLine).trim();
    if (0 === line.length) continue;

    // `args = [` spread over several lines is the shape a formatter produces, and reading only the
    // first line of it would leave a HALF-read entry that looks like somebody else's registration.
    if (undefined !== openArrayIsOurs) {
      if (openArrayIsOurs) tokens.push(...quotedStrings(line));
      if (line.includes(']')) openArrayIsOurs = undefined;
      continue;
    }

    // A table header ends whatever table we were in, whether or not it is ours.
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (null !== header) {
      table = keyPath(header[1] ?? '');
      inOurTable = samePath(table, want);
      continue;
    }

    const assignment = /^([^=]+)=(.*)$/.exec(line);
    if (null === assignment) continue;
    const key = keyPath(assignment[1] ?? '');
    const value = assignment[2] ?? '';

    // Inside `[mcp_servers.reticle]`, the keys we care about are `command` and `args`.
    const ours =
      (inOurTable && 1 === key.length && ('command' === key[0] || 'args' === key[0])) ||
      // `mcp_servers.reticle = { command = "npx", args = [...] }` at the root, or
      // `reticle = { … }` inside an `[mcp_servers]` table.
      samePath([...table, ...key], want);
    if (ours) tokens.push(...quotedStrings(value));
    if (value.includes('[') && !value.includes(']')) openArrayIsOurs = ours;
  }
  return tokens;
}

/** Does this config already declare a Reticle server under our name? */
export function codexDeclaresOurServer(existing: string | null, serversKey: string): boolean {
  return 0 < codexServerTokens(existing, serversKey).length;
}
