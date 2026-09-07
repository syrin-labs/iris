/**
 * The proxy's POST leg — one HTTP request per JSON-RPC message — used to be sent with no `agent`,
 * so it inherited `http.globalAgent` and its 5-second idle timeout. An agent thinks for longer than
 * five seconds between tool calls essentially always, so in practice every tool call opened a fresh
 * TCP socket. On Windows that is the ephemeral-port / non-paged-pool exhaustion pattern, and the
 * `ENOBUFS` it produces killed the call outright: the POST error resolved straight into a -32001
 * transport loss with no retry.
 *
 * Two bounds are pinned here, never a duration:
 *  - the POST leg reuses ONE socket across calls (the churn is gone at the source), and
 *  - a failure that happened before a socket ever connected is retried, while a failure after the
 *    request went onto a connected socket is NOT — because the daemon may already have acted on it.
 */

import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  loopbackAgent,
  isRetryableConnectError,
  LOOPBACK_AGENT_OPTIONS,
  LOOPBACK_IDLE_MS,
} from './loopback-agent.js';
import { createSharedServer } from './http-server.js';

const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' });

interface Started {
  url: string;
  connections: () => number;
  requests: () => number;
  close: () => Promise<void>;
}

/** A daemon stand-in that counts TCP connections and requests separately. */
async function start(handle: (res: http.ServerResponse, req: http.IncomingMessage) => void) {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on('end', () => handle(res, req));
  });
  server.on('connection', () => (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const started: Started = {
    url: `http://127.0.0.1:${String(port)}/message`,
    connections: () => connections,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return started;
}

describe('the shared loopback agent keeps its socket', () => {
  it('is configured for reuse rather than a socket per call', () => {
    expect(LOOPBACK_AGENT_OPTIONS.keepAlive).toBe(true);
    expect(LOOPBACK_AGENT_OPTIONS.maxSockets).toBeGreaterThan(0);
    expect(LOOPBACK_AGENT_OPTIONS.keepAliveMsecs).toBeGreaterThan(0);
  });

  it('sends two calls down ONE connection', async () => {
    const daemon = await start((res) => res.end('{}'));
    // Posted through the agent DIRECTLY. This used to go via the MCP proxy's poster, which has
    // since been given its own bounded pool (MCP_PROXY_HTTP_AGENT), so routing through it would
    // no longer be testing this agent at all.
    const post = (): Promise<void> =>
      new Promise((resolve, reject) => {
        // Spelled out rather than spread from a URL: a URL's fields are not RequestOptions, so
        // `{...new URL(u)}` silently loses the port and dials 80.
        const target = new URL(daemon.url);
        const req = http.request(
          {
            host: target.hostname,
            port: Number(target.port),
            path: target.pathname,
            method: 'POST',
            agent: loopbackAgent,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end(BODY);
      });
    await post();
    await post();
    // The bound, not a timing: two requests arrived, and the second one did not need a new socket.
    expect(daemon.requests()).toBe(2);
    expect(daemon.connections()).toBe(1);
    // And it is OUR agent holding it, not `http.globalAgent` — which also parks free sockets, but
    // drops them after 5s, so a shared-socket count alone cannot tell the two apart.
    expect(Object.keys(loopbackAgent.freeSockets).length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('is met by a daemon that holds the socket for longer than the client will', () => {
    // Both halves of the pact, or neither works: a server that closes idle sockets at Node's default
    // 5s makes the client's keep-alive window moot, and closing FIRST is what produces the stale
    // socket the retry path deliberately refuses to re-send.
    const shared = createSharedServer();
    expect(shared.httpServer.keepAliveTimeout).toBeGreaterThan(LOOPBACK_IDLE_MS);
  });
});

describe('retryable socket errors', () => {
  it('covers the exhaustion family that Windows reports', () => {
    for (const code of ['ENOBUFS', 'EADDRNOTAVAIL', 'EMFILE', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(isRetryableConnectError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('does not cover a programming error, which would retry forever', () => {
    const bug = Object.assign(new Error('bad url'), { code: 'ERR_INVALID_URL' });
    expect(isRetryableConnectError(bug)).toBe(false);
    expect(isRetryableConnectError(new Error('no code at all'))).toBe(false);
  });
});
