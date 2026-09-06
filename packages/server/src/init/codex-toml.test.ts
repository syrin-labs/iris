/**
 * #681: `init` printed `[⚠] MCP server (Codex CLI) → ~/.codex/config.toml — add this by hand` on
 * machines whose config already held a working `[mcp_servers.reticle]` table with the same command
 * and args. Reported independently twice. The setup contract makes a `⚠` blocking, so the warning
 * sent an agent to hand-edit a global config for no reason.
 */
import { describe, expect, it } from 'vitest';
import { codexDeclaresOurServer, codexServerTokens } from './codex-toml.js';
import {
  ClientMergeStatus,
  ConfigFormat,
  McpClient,
  clientSpec,
  mergeClientConfig,
} from './mcp-clients.js';
import { NPX, npxServerArgs } from './mcp.js';

const KEY = 'mcp_servers';
const OURS = [NPX, ...npxServerArgs()];

const WIRED = `[mcp_servers.reticle]
command = "${NPX}"
args = [${npxServerArgs()
  .map((a) => `"${a}"`)
  .join(', ')}]
`;

describe('codexServerTokens', () => {
  it('reads the standard table Codex documents', () => {
    expect(codexServerTokens(WIRED, KEY).sort()).toEqual([...OURS].sort());
  });

  it('reads the table when other servers surround it', () => {
    const config = `model = "gpt-5"

[mcp_servers.other]
command = "node"
args = ["other.js"]

${WIRED}
[mcp_servers.third]
command = "python"
`;
    expect(codexServerTokens(config, KEY).sort()).toEqual([...OURS].sort());
  });

  it('reads a dotted inline assignment', () => {
    const config = `mcp_servers.reticle = { command = "${NPX}", args = ["${npxServerArgs().join('", "')}"] }\n`;
    expect(codexServerTokens(config, KEY).sort()).toEqual([...OURS].sort());
  });

  it('reads our key inside an [mcp_servers] table', () => {
    const config = `[mcp_servers]\nreticle = { command = "${NPX}", args = ["${npxServerArgs().join('", "')}"] }\n`;
    expect(codexServerTokens(config, KEY).sort()).toEqual([...OURS].sort());
  });

  it('accepts a quoted table key, which TOML treats as the same key', () => {
    expect(codexDeclaresOurServer(WIRED.replace('reticle]', '"reticle"]'), KEY)).toBe(true);
  });

  it('finds nothing when only another server is registered', () => {
    const config = `[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"]\n`;
    expect(codexServerTokens(config, KEY)).toEqual([]);
    expect(codexDeclaresOurServer(config, KEY)).toBe(false);
  });

  it('is not fooled by our name inside a comment or another table', () => {
    const config = `# [mcp_servers.reticle] was here
[mcp_servers.other]
command = "node"
args = ["reticle-shim.js"]
`;
    expect(codexServerTokens(config, KEY)).toEqual([]);
  });

  it('finds nothing in an absent or empty config', () => {
    expect(codexServerTokens(null, KEY)).toEqual([]);
    expect(codexServerTokens('', KEY)).toEqual([]);
  });
});

describe('mergeClientConfig for Codex', () => {
  const codex = clientSpec(McpClient.CODEX);

  it('is still a TOML client — nothing here starts writing TOML', () => {
    expect(codex.format).toBe(ConfigFormat.TOML);
  });

  it('reports a wired machine as already registered, not "add this by hand"', () => {
    const result = mergeClientConfig(codex, WIRED);
    expect(result.status).toBe(ClientMergeStatus.ALREADY);
    // Byte-identical: detection reads, it never rewrites.
    expect(result.content).toBe(WIRED);
  });

  it('still asks for a manual edit when the table is absent', () => {
    const other = `[mcp_servers.other]\ncommand = "node"\n`;
    expect(mergeClientConfig(codex, other).status).toBe(ClientMergeStatus.MANUAL);
    expect(mergeClientConfig(codex, null).status).toBe(ClientMergeStatus.MANUAL);
  });

  it('leaves a deliberate local-build registration alone', () => {
    // Not an @reticlehq/* npx invocation, so it is somebody's own choice — the same rule the JSON
    // clients apply in leaveEntryAlone.
    const local = `[mcp_servers.reticle]\ncommand = "node"\nargs = ["/home/me/reticle/dist/mcp.js"]\n`;
    expect(mergeClientConfig(codex, local).status).toBe(ClientMergeStatus.ALREADY);
  });

  it('keeps warning on a drifted registration of our own shape', () => {
    // `@reticlehq/core` has no `mcp` bin. It is ours to fix and it is wrong, so the snippet stays
    // the actionable output rather than a green "already registered".
    const stale = `[mcp_servers.reticle]\ncommand = "${NPX}"\nargs = ["@reticlehq/core", "mcp"]\n`;
    expect(mergeClientConfig(codex, stale).status).toBe(ClientMergeStatus.MANUAL);
  });

  it('reads a multi-line args array, which a formatter produces', () => {
    // Reading only the first line of `args = [` would leave a HALF-read entry that looks like
    // somebody else's registration, and a drifted one would then be reported green.
    const multiline = `[mcp_servers.reticle]\ncommand = "${NPX}"\nargs = [\n  "${npxServerArgs().join('",\n  "')}",\n]\n`;
    expect(mergeClientConfig(codex, multiline).status).toBe(ClientMergeStatus.ALREADY);
    const stale = `[mcp_servers.reticle]\ncommand = "${NPX}"\nargs = [\n  "@reticlehq/core",\n  "mcp",\n]\n`;
    expect(mergeClientConfig(codex, stale).status).toBe(ClientMergeStatus.MANUAL);
  });
});
