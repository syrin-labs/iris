import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { asRunId, ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { ReticleRunner, type RunnerPort } from './reticle-runner.js';
import { startVerifyServer, TOKEN_HEADER } from './verify-server.js';
import { VERIFY_PATH } from './verify-http.js';

function fakePort(): RunnerPort {
  let t = 0;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(['login']),
    replayFlow: (name): Promise<FlowReplayResult> =>
      Promise.resolve({ name, status: ReplayStatus.OK, steps: [] }),
    now: () => (t += 1),
    newRunId: () => asRunId(`run-${(n += 1)}`),
  };
}

describe('startVerifyServer (real socket, localhost)', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function start(token: string) {
    const started = await startVerifyServer({ runner: new ReticleRunner(fakePort()), token }, 0);
    server = started.server;
    return `http://127.0.0.1:${started.port}`;
  }

  it('POST /verify returns a 200 verdict over HTTP', async () => {
    const base = await start('');
    const res = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: { name: 'demo' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run: { verdict: { status: string } } };
    expect(json.run.verdict.status).toBe('pass');
  });

  it('rejects a request with the wrong token (401)', async () => {
    const base = await start('secret');
    const res = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'wrong' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts the right token and 404s an unknown path', async () => {
    const base = await start('secret');
    const ok = await fetch(`${base}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'secret' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    const missing = await fetch(`${base}/nope`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'secret' },
      body: '{}',
    });
    expect(missing.status).toBe(404);
  });

  it('rejects a port it cannot bind, naming the port', async () => {
    // Hold a port so the verify server cannot have it. The promise used to never settle here — the
    // bind error escaped as an unhandled 'error' event and crashed the daemon with a raw stack.
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', () => resolve()));
    const address = squatter.address();
    const held = 'object' === typeof address && address !== null ? address.port : 0;
    await expect(
      startVerifyServer({ runner: new ReticleRunner(fakePort()), token: '' }, held),
    ).rejects.toThrow(`could not bind 127.0.0.1:${String(held)}`);
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });
});
