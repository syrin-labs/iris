/**
 * The MCP proxy's POST leg: its own socket pool, and the one retry that is safe to make.
 *
 * Split out of `mcp-proxy.ts` when that file passed the 1000-line backstop after two independent
 * hardenings of this path met in a merge. It earns its own module rather than being an arbitrary
 * slice: everything here is about ONE thing — getting a single JSON-RPC line into the daemon, or
 * saying honestly that it never arrived — and the file it came from is about the SSE stream.
 */

import * as http from 'node:http';
import { log } from '../log.js';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { reconnectDelayMs } from './proxy-backoff.js';

/** One bounded pool for the short-lived POST side of each MCP SSE session. */
export const MCP_PROXY_HTTP_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  timeout: 60_000,
  maxSockets: 8,
  scheduling: 'lifo',
} as const satisfies http.AgentOptions;
const MCP_PROXY_HTTP_AGENT = new http.Agent(MCP_PROXY_HTTP_AGENT_OPTIONS);

/**
 * POST one JSON-RPC line into the daemon's session. Resolves null on success, or a structured
 * failure when the request never reached a server that will answer it.
 *
 * It used to resolve `void` in every case, logging the failure and moving on. That is the THIRD way
 * a call goes unanswered, and the only one neither `streamLossReplies` nor the queue timer can see:
 * the SSE stream is healthy (so nothing drops) and the request was forwarded (so nothing is queued),
 * but the POST leg is its own TCP connection and an ECONNRESET on it means the daemon never received
 * the call. Nobody was ever going to reply, and the caller waited for its own timeout.
 */
const RETRYABLE_UNSENT_POST_ERRORS = new Set(['ENOBUFS', 'ERR_NO_BUFFER_SPACE', 'EADDRNOTAVAIL']);

export function shouldRetryUnsentPost(
  error: unknown,
  bytesWritten: number,
  retryCount: number,
): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return 0 === retryCount && 0 === bytesWritten && RETRYABLE_UNSENT_POST_ERRORS.has(String(code));
}

export interface PostFailure {
  reason: string;
  transport: boolean;
  attempts: number;
}

type HttpRequest = (
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export function postToSession(
  url: string,
  body: string,
  request: HttpRequest = (options, callback) => http.request(options, callback),
): Promise<PostFailure | null> {
  const send = (retryCount: number): Promise<PostFailure | null> =>
    new Promise<PostFailure | null>((resolve) => {
      const parsed = new URL(url);
      const bodyBuf = Buffer.from(body, 'utf8');
      const options: http.RequestOptions = {
        host: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        agent: MCP_PROXY_HTTP_AGENT,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.byteLength,
        },
      };
      // A keep-alive socket carries historical bytes; retry safety depends on this request's delta.
      let socket: import('node:net').Socket | undefined;
      let socketBytesBeforeRequest = 0;
      let settled = false;
      const req = request(options, (res) => {
        if (settled) return;
        settled = true;
        const status = res.statusCode ?? 0;
        const rejected = status < 200 || status >= 300;
        if (rejected) {
          // A non-2xx from the daemon MCP endpoint used to be swallowed, hanging the JSON-RPC call
          // client-side with no diagnostic. It is a refusal: no response is coming over the stream.
          log('reticle_mcp_proxy_post_non2xx', { status, path: options.path });
        } else if (retryCount > 0) {
          getSessionMetrics().recordPostRetrySaved();
        }
        res.resume(); // drain so the socket is reused
        resolve(
          rejected
            ? {
                reason: `daemon rejected the call with HTTP ${String(status)}`,
                transport: false,
                attempts: retryCount + 1,
              }
            : null,
        );
      });
      req.once('socket', (assigned) => {
        socket = assigned;
        socketBytesBeforeRequest = assigned.bytesWritten;
      });
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        // Invisible to mcp_connection_lost (SSE is up) and to tool_refused (handler never ran).
        getSessionMetrics().recordPostSocketFailure();
        const bytesWritten =
          socket === undefined ? 0 : Math.max(0, socket.bytesWritten - socketBytesBeforeRequest);
        if (shouldRetryUnsentPost(err, bytesWritten, retryCount)) {
          const retryInMs = reconnectDelayMs(retryCount + 1);
          log('reticle_mcp_proxy_post_retry', {
            code: (err as NodeJS.ErrnoException).code,
            retryInMs,
          });
          setTimeout(() => void send(retryCount + 1).then(resolve), retryInMs);
          return;
        }
        log('reticle_mcp_proxy_post_error', { error: err.message });
        resolve({
          reason: `post failed: ${err.message}`,
          transport: true,
          attempts: retryCount + 1,
        });
      });
      req.end(bodyBuf);
    });

  return send(0);
}
