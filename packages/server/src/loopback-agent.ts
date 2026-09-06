import * as http from 'node:http';

/**
 * The one HTTP agent every loopback call in this process goes through.
 *
 * Without an `agent:`, Node hands the request to `http.globalAgent`, whose idle timeout is 5
 * seconds. The MCP proxy's POST leg is one request per JSON-RPC message and an agent thinks for
 * longer than five seconds between tool calls essentially always — so every single tool call opened
 * a fresh TCP socket. On Windows that is the ephemeral-port / non-paged-pool exhaustion pattern, and
 * the `ENOBUFS` it eventually raises killed the call outright.
 *
 * The numbers, each one a decision and not a taste:
 *
 * - `keepAlive: true` — the whole point: hold the socket open between calls so there is no churn to
 *   exhaust anything with.
 * - `timeout: LOOPBACK_IDLE_MS` (45s) — how long an idle socket is kept for reuse. It has to outlast
 *   a model's think-time between two tool calls (which is what 5s failed to do) and it has to stay
 *   BELOW the daemon's own keep-alive timeout, so that the client is always the side that retires a
 *   socket. If the server closed first we would keep picking up sockets it had already closed, and
 *   that failure looks exactly like the one case we refuse to retry (see `isRetryableConnectError`).
 *   The daemon's side of that pact is `HTTP_KEEP_ALIVE_TIMEOUT_MS` in `http-server.ts`.
 * - `keepAliveMsecs: 10_000` — TCP-level keep-alive probes on an idle socket, so a daemon that died
 *   without a FIN is noticed rather than handed back out as a live connection.
 * - `maxSockets: 8` — the proxy multiplexes ONE MCP client, whose calls are near enough serial; 8 is
 *   generous headroom for overlapping notifications while capping the worst case far below anything
 *   a port table would notice. Exceeding it queues rather than fails.
 */
export const LOOPBACK_IDLE_MS = 45_000;

/** Named separately because `http.Agent` does not expose its options back to a caller (or a test). */
export const LOOPBACK_AGENT_OPTIONS: http.AgentOptions = {
  keepAlive: true,
  keepAliveMsecs: 10_000,
  timeout: LOOPBACK_IDLE_MS,
  maxSockets: 8,
};

export const loopbackAgent = new http.Agent(LOOPBACK_AGENT_OPTIONS);

/**
 * Socket-level failures worth another attempt — every one of them a statement about this machine's
 * networking stack, not about the request.
 *
 * The list is deliberately narrow. It is not the retry decision on its own: the caller must ALSO
 * know the request never reached the daemon. What the code check buys is that a programming error
 * (`ERR_INVALID_URL`, a bad argument) cannot be retried — those fail before a socket too, and would
 * otherwise burn the whole attempt budget on a bug that will never succeed.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'ENOBUFS', // Windows: non-paged pool / ephemeral port exhaustion — the reported failure
  'EADDRNOTAVAIL', // no ephemeral port left to bind
  'EMFILE', // per-process fd limit
  'ENFILE', // system-wide fd limit
  'ECONNREFUSED', // daemon restarting, listener not back yet
  'ECONNRESET', // peer closed the connection
  'ETIMEDOUT', // connect never completed
]);

export function isRetryableConnectError(err: unknown): boolean {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  return 'string' === typeof code && RETRYABLE_CODES.has(code);
}
