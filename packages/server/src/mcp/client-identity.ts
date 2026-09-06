/**
 * WHICH agent is on the other end of this daemon.
 *
 * MCP clients announce themselves in the `initialize` handshake — `claude-code`, `cursor-vscode`,
 * `windsurf`, and so on. That claim is the ONLY honest source for this: an env-var table
 * (`CLAUDECODE`, `CURSOR_TRACE_ID`, …) is a guess that silently rots every time a vendor renames a
 * variable, and it cannot see a client nobody has added to the table yet.
 *
 * Read through a hook rather than a stored value because the handshake happens after the server is
 * constructed, and a session can reconnect under a different client entirely.
 *
 * Lives here, not in telemetry, because it stopped being a telemetry detail the moment a
 * verification RUN needed to record which agent produced it — and `runs/` must not import
 * `telemetry/` to find out.
 *
 * Note what is NOT available and cannot be: the MODEL. `clientInfo` carries a name, a title and a
 * version; MCP has no concept of a model, so the transport genuinely cannot tell us. Anything
 * claiming to know it would be inventing it.
 */

interface McpClientIdentity {
  name?: string;
  version?: string;
}

/** Caps, so a hostile or broken client cannot write unbounded strings into an artifact. */
const MAX_NAME = 64;
const MAX_VERSION = 32;

let hook: (() => McpClientIdentity | undefined) | undefined;

export function setMcpClientIdentityHook(next: () => McpClientIdentity | undefined): void {
  hook = next;
}

/** For tests, and for a daemon that is reused across transports. */
export function clearMcpClientIdentityHook(): void {
  hook = undefined;
}

/**
 * The client's own name and version, trimmed and bounded. Empty object when no MCP peer has
 * introduced itself — a plain CLI run has no client, and reporting one would be a fabrication.
 */
export function mcpClientIdentity(): McpClientIdentity {
  try {
    const info = hook?.();
    const name = info?.name;
    const version = info?.version;
    return {
      ...(name !== undefined && '' !== name ? { name: name.slice(0, MAX_NAME) } : {}),
      ...(version !== undefined && '' !== version
        ? { version: version.slice(0, MAX_VERSION) }
        : {}),
    };
  } catch {
    // A hook that throws must never fail the thing that asked — this is descriptive, not load-bearing.
    return {};
  }
}
