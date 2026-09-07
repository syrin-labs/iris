/**
 * Answer `initialize` when the daemon cannot.
 *
 * The proxy queues every client message until the daemon's SSE endpoint frame arrives. `initialize`
 * is a client message, so when the daemon port is held by something that accepts connections and
 * never serves SSE — a wedged daemon, a foreign process, a daemon leaked by another project — the
 * handshake waits on a thing that is never coming. Reported from the field as "initialize never
 * answers, no tools run at all"; reproduced with a listener that simply never responds.
 *
 * A hang is the worst possible outcome here: no tools, no diagnosis, nothing to retry. Completing
 * the handshake locally gives the agent a working surface whose FIRST tool call reports the real
 * problem through the no-session diagnostics that already exist.
 *
 * Safe because the proxy replays the client's own `initialize` to the daemon whenever a session is
 * finally established (see `replayLines`), so the daemon still gets its handshake in order.
 */
import { SERVER_VERSION } from '../version/server-version.js';
import { MCP_SERVER_NAME } from '@reticlehq/core';

/** The version we answer with if the client proposed none. */
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

/**
 * The protocol's own way to say "the tool list you have is out of date, fetch it again".
 *
 * Load-bearing here rather than a nicety. When we answer `initialize` ourselves the catalog we serve
 * is one we made up, and it is usually empty. Nothing else in the protocol ever corrects that: a
 * client re-lists only when told to, and every other recovery path in the proxy is driven by the
 * NEXT client request, which a client holding no tools never makes. Without this the session is
 * connected, initialized and toolless until a human notices.
 */
export const TOOLS_CHANGED_NOTIFICATION = 'notifications/tools/list_changed';

interface JsonRpcLike {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown };
}

function parseLine(line: string): JsonRpcLike | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return 'object' === typeof parsed && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** True when this queued client line is the handshake we answered ourselves. */
export function isHandshakeLine(line: string): boolean {
  const msg = parseLine(line);
  return 'initialize' === msg?.method || 'notifications/initialized' === msg?.method;
}

export function localInitializeResponse(
  line: string,
  /**
   * What the daemon would have advertised, so the client is not left with none.
   *
   * A client reads `instructions` ONCE, at initialize, and this response is sent precisely when no
   * daemon is up to send its own — which is the first run of a fresh install. So the block telling
   * someone that having these tools is not the same as being set up was permanently absent for the
   * exact population it addresses, and the daemon's later correct instructions arrive at a client
   * that will never read the field again.
   *
   * Empty means "nothing to say", and the field is then omitted rather than sent blank.
   */
  instructions = '',
): string | null {
  const msg = parseLine(line);
  if (null === msg || msg.method !== 'initialize') return null;
  // A notification carries no id and expects no reply; answering one is a protocol error.
  if (msg.id === undefined || null === msg.id) return null;
  const proposed = msg.params?.protocolVersion;
  return JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      // Echo what the client asked for: answering with a version it did not offer is its own
      // handshake failure.
      protocolVersion: 'string' === typeof proposed ? proposed : FALLBACK_PROTOCOL_VERSION,
      // `listChanged` is not decoration: a client that was not told the list can change has no
      // reason to honour the notification we send when the daemon finally arrives, and declaring a
      // capability we then rely on is the difference between a fix and a message into the void.
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION },
      ...('' === instructions ? {} : { instructions }),
    },
  });
}

/**
 * The line that tells a client its tool list is stale, or null when there is nothing to correct.
 *
 * When a daemon arrives after we answered the handshake ourselves, the client is holding a tool list
 * we invented, and on a cold start that list is empty. Nothing else in this protocol corrects it: a
 * client re-lists only when told to, and every other recovery path in the proxy is driven by the
 * NEXT client request, which a client holding no tools never makes. Connected, initialized and
 * toolless for the rest of the session, with a human required to notice and reconnect by hand.
 *
 * Sent only when the catalog was ours. A client that completed a real handshake with the daemon
 * already has the true list, and telling it to refetch would be a round trip for nothing.
 *
 * Lives here rather than in the proxy because it belongs to the locally-answered handshake, which is
 * this module's subject.
 *
 * Worth knowing before relying on it: this is a best-effort correction, not the mechanism. Research
 * into the four clients we target found that only some honour `notifications/tools/list_changed` at
 * all, so the catalog still has to be right in the FIRST answer for the rest. This closes the gap
 * where it is honoured and costs one line where it is not.
 */
export function toolsChangedNotification(catalogWasLocal: boolean): string | null {
  if (!catalogWasLocal) return null;
  return JSON.stringify({ jsonrpc: '2.0', method: TOOLS_CHANGED_NOTIFICATION });
}

/**
 * What a locally-answered handshake must say about itself.
 *
 * The proxy answering `initialize` is right — a hang gives the agent no tools AND no diagnosis — but
 * the response it sent was INDISTINGUISHABLE from a daemon's. Same `serverInfo`, same capabilities,
 * same `instructions`. So the client marked the server installed and enabled, the agent got a tool
 * list that was cached at best and empty at worst, and nothing anywhere connected the two facts.
 *
 * Reported from the field, from two different agent hosts at once: the marketplace showed Reticle
 * installed with the whole tool surface enabled, and the agent asked to verify a flow reported that
 * RETICLE WAS NOT PRESENT ON THE MACHINE — while the daemon was running and a browser session was
 * live. That conclusion is the reasonable reading of an empty surface with no explanation attached,
 * and it is unrecoverable: the proxy's own recovery is "the next client request re-probes the port",
 * and a client holding zero tools never makes another request.
 *
 * `instructions` is the channel because it is the only one that survives an empty catalog. It rides
 * on the initialize result, which SUCCEEDED, and every host we target puts it in front of the model.
 * A tool description cannot reach an agent that was handed no tools.
 *
 * The healthy block is kept underneath rather than replaced: an agent that IS about to get a working
 * surface (the common case — the first call wakes a daemon) still needs to know how to drive it.
 */
export function degradedInstructions(healthy: string, port: number, reason: string): string {
  return `DEGRADED SURFACE — READ THIS BEFORE ANY reticle_* CALL: no Reticle daemon answered on port ${String(port)} (${reason}), so this handshake was completed by the Reticle MCP proxy itself, not by Reticle's daemon. Any tool list you were handed came from a cache or is empty — it is not evidence that anything is behind it.

Reticle IS installed: this process is Reticle. Do NOT report it as missing, not present, or not installed — that is the wrong diagnosis and it is the one this state reliably produces. The right one is that the daemon is not reachable yet.

Your next reticle_* call starts a daemon and then either works or fails with the specific reason. If you have NO reticle_* tools at all, say exactly that to the user and tell them to run \`reticle doctor\` in a terminal — it reports what is holding port ${String(port)} and whether a daemon can start at all.

${healthy}`;
}

/**
 * The largest single JSON-RPC line the proxy will accumulate from a client.
 *
 * Generous — a tool call with a big argument payload is legitimate — but finite, because without a
 * ceiling the buffer grows to whatever is sent and the process is one `cat bigfile` away from an
 * out-of-memory exit that would take the agent's whole tool surface with it.
 */
export const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024;

interface DrainedLines {
  /** Complete lines, in order. Empty when the chunk carried no newline. */
  lines: string[];
  /** The trailing partial line, carried into the next chunk. */
  rest: string;
  /** A single line exceeded the cap and was discarded rather than accumulated. */
  overflowed: boolean;
  /**
   * Mid-discard: an oversized line was dropped and the REST of it is still arriving.
   *
   * Carried back in on the next call, and it is what makes dropping safe rather than merely tidy.
   * Without it the tail of the discarded line arrives looking like a complete line and is forwarded
   * as a JSON-RPC message — a fragment of something nobody sent, failing to parse, on a link where
   * the client is waiting for answers to real requests.
   */
  discarding: boolean;
}

/**
 * Append a chunk and split off whatever complete lines it produced.
 *
 * The reason this is not `(buffer + chunk).split('\n')` inline: that re-scans the WHOLE accumulated
 * buffer on every chunk, so a single large line costs O(n²) in the size of the line. Measured
 * against the real proxy, a 32 MB line took ~8s and a 50 MB line ~35s — with the event loop pinned
 * throughout, so every other tool call on that link was frozen with no response and no error. The
 * client sees the whole MCP surface hang.
 *
 * A chunk with no newline in it cannot complete a line, so there is nothing to split and the cost is
 * the concatenation alone. Only a chunk that actually carries a newline pays for a scan.
 */
export function drainLines(
  buffer: string,
  chunk: string,
  maxLineBytes = MAX_STDIN_LINE_BYTES,
  discarding = false,
): DrainedLines {
  // Finish discarding first. Everything up to and including the next newline belongs to the line
  // that was already dropped, and only what follows it is a message again.
  if (discarding) {
    const cut = chunk.indexOf('\n');
    if (-1 === cut) return { lines: [], rest: '', overflowed: true, discarding: true };
    return {
      ...drainLines('', chunk.slice(cut + 1), maxLineBytes),
      overflowed: true,
    };
  }
  const next = buffer + chunk;
  if (!chunk.includes('\n')) {
    // Nothing can be complete yet. Cap here rather than on the split path: this is the branch an
    // oversized line stays on, so it is the only one that can grow without bound. Dropping the
    // buffer is half the job — the rest of that line is still coming, hence `discarding`.
    if (next.length > maxLineBytes) {
      return { lines: [], rest: '', overflowed: true, discarding: true };
    }
    return { lines: [], rest: next, overflowed: false, discarding: false };
  }
  const parts = next.split('\n');
  const rest = parts.pop() ?? '';
  // A completed line over the cap is dropped, not truncated: half a JSON-RPC message is not a
  // message, and forwarding a prefix would be a parse error attributed to the client. Its newline
  // has already arrived, so there is nothing left to swallow for it.
  const oversizedLine = parts.some((line) => line.length > maxLineBytes);
  const restOversized = rest.length > maxLineBytes;
  return {
    lines: oversizedLine ? parts.filter((line) => line.length <= maxLineBytes) : parts,
    rest: restOversized ? '' : rest,
    overflowed: oversizedLine || restOversized,
    discarding: restOversized,
  };
}
