---
title: 'HTTP transport'
description: 'Drive the full reticle_* tool surface over plain HTTP and SSE, from a client that cannot hot-reload MCP tools or that is not an MCP client at all.'
icon: 'plug'
---

Most clients reach Reticle over stdio: they spawn `reticle mcp`, and the tools appear in the agent's surface. That has one property you cannot always live with. **Many clients read their MCP tool list once, at startup**. If the daemon was not running when the client launched, the `reticle_*` tools are absent for the rest of that session, and the fix is to restart the client.

The daemon also speaks MCP over HTTP, on the same port as everything else. Nothing has to reload for a client to reach it, so this is the transport for scripted runs, CI, a language with no MCP client library, and any editor that will not pick up tools mid-session.

It is the same tool surface. Not a subset, not a simplified one. `reticle_snapshot`, `reticle_act_and_wait`, `reticle_assert` and the rest behave exactly as they do over stdio, because they are the same server behind a different transport.

## The two endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/mcp/sse` | Opens a session. The response is an SSE stream that stays open, and every reply the server sends comes back on it. |
| `POST` | `/mcp/message?sessionId=<id>` | Sends one JSON-RPC message into an open session. |

The daemon listens on port **4400** by default (`RETICLE_PORT`, or `reticle serve --port N`). Run `reticle status` to confirm which port is live.

## The handshake

The one shape worth reading before you write any code: **the POST does not answer your request.** It replies `202 Accepted` with no result in it, and the actual JSON-RPC reply arrives on the SSE stream you opened first. A client that waits on the POST body waits forever.

1. `GET /mcp/sse`. Hold the response open.
2. The first frame is the endpoint announcement, and it carries the session id:

   ```
   event: endpoint
   data: /mcp/message?sessionId=6f1c2b7e-1f4a-4a8e-9d5f-3f7a1b2c3d4e
   ```

   Use that `data` value verbatim as the path you POST to. Do not build it yourself: the session id is minted per connection.

3. `POST` the `initialize` request there, then the `notifications/initialized` notification.
4. `POST` `tools/list`, `tools/call`, and anything else. Match each reply to its request by the JSON-RPC `id`, off the SSE stream.

When the daemon shuts down it writes a shutdown frame on the stream before the socket closes, so a client can tell a planned stop from a dropped connection.

## Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| `400 missing sessionId` | The POST had no `sessionId` query parameter. | Use the path from the `endpoint` frame. |
| `404 session not found` | That session is not open, usually because the SSE stream dropped. | Reconnect to `/mcp/sse` and handshake again. |
| `503 MCP server not ready` | The daemon is up but the MCP server is not attached yet. | Retry. Unlike a `404`, the endpoint is real and coming. |

`404` and `400` are kept apart on purpose: reconnecting fixes one and nothing about the other.

## Authorization

Two tiers, the same ones the WebSocket bridge uses.

**Local clients need no token.** A request is trusted when its peer address, its `Host` header, and its `Origin`/`Referer` (when present) are all loopback. All three are required, because a DNS-rebound page reaches the daemon _as_ a loopback peer while carrying the attacker's `Host`, so peer address alone would not be a check.

**Anything else must present the pairing token**, which is required whenever you bind beyond loopback with `RETICLE_HOST`. Either form works:

```
Authorization: Bearer <token>
```

```
/mcp/sse?token=<token>
```

Set it with `RETICLE_TOKEN`. With no token configured, the daemon binds loopback-only and non-local requests are refused outright rather than falling back to trust.

## A minimal client

No MCP library. Node's standard library is enough. This opens a session, lists the tools, and takes a snapshot.

```js
import http from 'node:http';

const PORT = 4400;
let endpoint = null;
let next = 1;
const pending = new Map();

// 1. Open the stream and keep it open. Every reply arrives here.
http.get({ port: PORT, path: '/mcp/sse', agent: false }, (res) => {
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buffer += chunk;
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
      if (event === 'endpoint') {
        endpoint = data; // "/mcp/message?sessionId=…", used verbatim
        start();
        continue;
      }
      const message = JSON.parse(data);
      pending.get(message.id)?.(message); // match the reply to its request by id
      pending.delete(message.id);
    }
  });
});

// 2. POST a request; resolve when its reply comes back on the stream.
function send(method, params) {
  const id = next++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const req = http.request(
      {
        port: PORT,
        path: endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => res.resume(), // 202 Accepted; the answer is on the SSE stream
    );
    req.end(body);
  });
}

async function start() {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'my-client', version: '1.0.0' },
  });

  const notify = http.request(
    { port: PORT, path: endpoint, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    (res) => res.resume(),
  );
  notify.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const listed = await send('tools/list', {});
  console.log(listed.result.tools.map((t) => t.name).join(', '));

  const snapshot = await send('tools/call', { name: 'reticle_snapshot', arguments: {} });
  console.log(snapshot.result.content[0].text);
}
```

To watch the raw frames instead, `curl` is enough for the first half:

```bash
curl -N http://127.0.0.1:4400/mcp/sse
```

Then, from a second shell, POST to the path that stream printed:

```bash
curl -X POST 'http://127.0.0.1:4400/mcp/message?sessionId=<id>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `202` comes back here; the tool list appears in the first shell.

## What this does not change

The transport carries the tools. It does not replace the rest of the setup. The app still has to be instrumented and connected, and `reticle_sessions` is still what tells you whether a session is there to drive. A verdict reached over HTTP is a verdict reached the usual way: only `verified: "yes"` is a pass.

The endpoints, the handshake, the three status codes and the `202`-then-SSE shape are pinned by `packages/server/src/mcp-http-transport.test.ts`, which drives them over raw HTTP with no client library, so the contract this page describes fails the build if it changes.
