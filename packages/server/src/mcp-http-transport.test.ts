import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_MESSAGE_PATH, MCP_SSE_PATH } from '@reticlehq/core';
import { createSharedServer, type SharedServer } from './http-server.js';

/**
 * The daemon's HTTP/SSE MCP transport, pinned as public surface (#690).
 *
 * A reporter who could not use the `reticle_*` tools — their client loads MCP tools only at startup —
 * found `/mcp/sse` + `/mcp/message`, wrote their own client against it, and drove the whole tool
 * surface over plain HTTP, video capture included. It works. It was also undocumented, and an
 * undocumented endpoint is free to break: nothing in the gate would have noticed the endpoint path,
 * the handshake shape or the status codes changing under them.
 *
 * These drive it the way that reporter had to — RAW HTTP and hand-parsed SSE frames, no SDK client.
 * That is deliberate. A test written with `Client` from the SDK would survive a rename of the wire
 * contract, because both halves would move together; the whole value of this file is that it fails
 * when the bytes a hand-written client depends on change. It is the executable half of
 * `docs/http-transport.md`, and every literal below appears there.
 */

let shared: SharedServer | undefined;

afterEach(async () => {
  await shared?.close();
  shared = undefined;
});

function listen(server: SharedServer): Promise<number> {
  return new Promise((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => {
      resolve((server.httpServer.address() as AddressInfo).port);
    });
  });
}

/** A real McpServer — not a stand-in — so the handshake below is the one an agent performs. */
async function mcpServerWithPing(): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'reticle-test', version: '0' });
  server.registerTool('ping', { description: 'answers pong' }, () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  return server;
}

interface SseFrame {
  event: string;
  data: string;
}

/**
 * One open SSE session, with the frames it has received so far.
 *
 * Frames are accumulated rather than awaited one at a time: a JSON-RPC reply can land before the
 * caller starts listening for it, and a test that raced that would be flaky in exactly the way this
 * repo refuses to ship.
 */
interface SseSession {
  waitFor: (match: (f: SseFrame) => boolean, timeoutMs?: number) => Promise<SseFrame>;
  close: () => void;
}

function openSse(port: number, path: string = MCP_SSE_PATH): Promise<SseSession> {
  return new Promise((resolve, reject) => {
    // `agent: false` gives this its own socket: an SSE response never ends, so a pooled one would
    // block every later request in the test behind it.
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const frames: SseFrame[] = [];
      const waiters: { match: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        // SSE frames are separated by a blank line. Whatever follows the last separator is a partial
        // frame and stays in the buffer until the rest of it arrives.
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          let event = 'message';
          const data: string[] = [];
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
          }
          const frame: SseFrame = { event, data: data.join('\n') };
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            const waiter = waiters[i];
            if (waiter !== undefined && waiter.match(frame)) {
              waiter.resolve(frame);
              waiters.splice(i, 1);
            }
          }
        }
      });
      resolve({
        waitFor: (match, timeoutMs = 5000) =>
          new Promise<SseFrame>((settle, fail) => {
            const already = frames.find(match);
            if (already !== undefined) {
              settle(already);
              return;
            }
            const timer = setTimeout(
              () => fail(new Error('no SSE frame matched within the budget')),
              timeoutMs,
            );
            waiters.push({
              match,
              resolve: (f) => {
                clearTimeout(timer);
                settle(f);
              },
            });
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

function post(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const rpc = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

const INITIALIZE = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'raw-http-client', version: '0' },
};

/** The JSON-RPC id carried by a frame, or undefined for a notification or a non-JSON frame. */
function idOf(frame: SseFrame): number | undefined {
  try {
    const parsed: unknown = JSON.parse(frame.data);
    const id = (parsed as { id?: unknown }).id;
    return 'number' === typeof id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function startDaemon(): Promise<number> {
  shared = createSharedServer();
  const server = await mcpServerWithPing();
  shared.attachMcp(() => server);
  return listen(shared);
}

/** Open a session and complete the initialize exchange, returning the path to POST to. */
async function handshake(port: number): Promise<{ sse: SseSession; endpoint: string }> {
  const sse = await openSse(port);
  const frame = await sse.waitFor((f) => 'endpoint' === f.event);
  await post(port, frame.data, rpc(1, 'initialize', INITIALIZE));
  await sse.waitFor((f) => 1 === idOf(f));
  await post(
    port,
    frame.data,
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  );
  return { sse, endpoint: frame.data };
}

describe('the SSE handshake', () => {
  it('answers the connect with an endpoint frame naming the message path and a session id', async () => {
    const port = await startDaemon();
    const sse = await openSse(port);

    const frame = await sse.waitFor((f) => 'endpoint' === f.event);
    // The whole contract a hand-written client starts from: where to POST, and which session it is.
    expect(frame.data.startsWith(MCP_MESSAGE_PATH)).toBe(true);
    const sessionId = new URL(frame.data, 'http://127.0.0.1').searchParams.get('sessionId');
    expect(sessionId).not.toBeNull();
    expect(sessionId).not.toBe('');

    sse.close();
  });

  it('answers the POST 202 and carries the JSON-RPC reply back over the stream', async () => {
    // The shape that surprises people writing a client: the POST is only an acknowledgement, and the
    // actual reply arrives on the SSE stream opened earlier.
    const port = await startDaemon();
    const sse = await openSse(port);
    const endpoint = await sse.waitFor((f) => 'endpoint' === f.event);

    const accepted = await post(port, endpoint.data, rpc(1, 'initialize', INITIALIZE));
    expect(accepted.status).toBe(202);

    const reply = await sse.waitFor((f) => 1 === idOf(f));
    const parsed = JSON.parse(reply.data) as { result?: { serverInfo?: { name?: string } } };
    expect(parsed.result?.serverInfo?.name).toBe('reticle-test');

    sse.close();
  });

  it('lists and calls a tool over plain HTTP, with no MCP client library', async () => {
    const port = await startDaemon();
    const { sse, endpoint } = await handshake(port);

    await post(port, endpoint, rpc(2, 'tools/list'));
    const listed = await sse.waitFor((f) => 2 === idOf(f));
    const tools = (JSON.parse(listed.data) as { result: { tools: { name: string }[] } }).result
      .tools;
    expect(tools.map((t) => t.name)).toContain('ping');

    await post(port, endpoint, rpc(3, 'tools/call', { name: 'ping', arguments: {} }));
    const called = await sse.waitFor((f) => 3 === idOf(f));
    const content = (JSON.parse(called.data) as { result: { content: { text?: string }[] } }).result
      .content;
    expect(content[0]?.text).toBe('pong');

    sse.close();
  });
});

describe('the transport refuses what it cannot route', () => {
  it('rejects a POST with no sessionId', async () => {
    const port = await startDaemon();
    const res = await post(port, MCP_MESSAGE_PATH, rpc(1, 'tools/list'));

    expect(res.status).toBe(400);
    expect(res.body).toContain('missing sessionId');
  });

  it('rejects a POST for a session that is not open', async () => {
    // Distinct from the 400 on purpose: "you did not say which session" and "that session is gone"
    // send a client to different fixes, and reconnecting only helps the second.
    const port = await startDaemon();
    const res = await post(
      port,
      `${MCP_MESSAGE_PATH}?sessionId=00000000-0000-0000-0000-000000000000`,
      rpc(1, 'tools/list'),
    );

    expect(res.status).toBe(404);
    expect(res.body).toContain('session not found');
  });

  it('answers 503 while no MCP server is attached yet', async () => {
    // A daemon that is up but not yet wired. Worth its own status: a client that retries recovers
    // from this one, where a 404 would tell it the endpoint does not exist at all.
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: MCP_SSE_PATH, agent: false }, (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

    expect(res.status).toBe(503);
    expect(res.body).toContain('MCP server not ready');
  });
});
