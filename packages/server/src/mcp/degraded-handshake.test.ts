/**
 * A handshake the PROXY answered must say so, in the one field the model actually reads.
 *
 * When no daemon answers, the proxy completes `initialize` itself and hands back the same
 * `instructions` block a healthy daemon would. Nothing in that response is false, and nothing in it
 * is true either: the surface behind it is a cache at best and empty at worst, and the client has
 * just been told the server started normally.
 *
 * What that produces, reported from the field by an evaluator running two different agent hosts: the
 * client marks the MCP server installed and enabled, the agent ends up with a tool list that is
 * stale or empty, and — having no `reticle_*` tool in front of it and nothing anywhere saying why —
 * it reports that RETICLE IS NOT INSTALLED ON THE MACHINE. Meanwhile the daemon is running and a
 * browser session is live. The two halves never meet, and the agent's conclusion is the reasonable
 * reading of what it was given.
 *
 * `instructions` is the fix because it is the ONE channel that survives an empty catalog: it arrives
 * in the initialize result, which succeeded, and every host puts it in front of the model. A tool
 * description cannot help an agent that was handed no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { degradedInstructions, localInitializeResponse } from './proxy-handshake.js';
import { buildServerInstructions } from './server-instructions.js';
import { startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './mcp-outage.js';

const PORT = 4400;
const REASON = 'a foreign process is holding the port';
const HEALTHY = buildServerInstructions({ previouslyConnected: true });

describe('the instructions a locally-answered handshake carries', () => {
  it('names the port and the reason no daemon answered', () => {
    const degraded = degradedInstructions(HEALTHY, PORT, REASON);
    expect(degraded).toContain(String(PORT));
    expect(degraded).toContain(REASON);
  });

  it('tells the agent not to read an empty surface as an absent product', () => {
    // The whole defect in one assertion: the agent's wrong conclusion was "Reticle is not present on
    // this machine", and nothing it was given contradicted that.
    expect(degradedInstructions(HEALTHY, PORT, REASON).toLowerCase()).toContain('not installed');
  });

  it('keeps the real instructions underneath, so the degraded agent is not also uninstructed', () => {
    expect(degradedInstructions(HEALTHY, PORT, REASON)).toContain(HEALTHY);
  });

  it('is absent from a healthy handshake', () => {
    // A daemon that answered builds its own instructions; if the notice leaked into those, every
    // working session would be told it is degraded.
    expect(HEALTHY).not.toContain('DEGRADED');
    expect(buildServerInstructions({ previouslyConnected: false })).not.toContain('DEGRADED');
  });

  it('is not attached by localInitializeResponse on its own', () => {
    // The builder is the caller's decision. Baking it into the response would decorate the replayed
    // handshake the daemon eventually receives too.
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(localInitializeResponse(line, HEALTHY) ?? '').not.toContain('DEGRADED');
  });
});

/** A stranger on the bridge port: accepts, answers, closes. Never serves SSE. */
function startSquatter(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not reticle');
  });
  return new Promise((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface InitReply {
  id?: unknown;
  result?: { instructions?: string };
}

describe('the proxy answering initialize itself', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  it('delivers the degraded notice to the client', async () => {
    const squatter = await startSquatter();
    cleanups.push(() => squatter.close());

    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-degraded-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const replies: InitReply[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      for (const line of String(chunk).split('\n')) {
        if ('' === line.trim()) continue;
        try {
          replies.push(JSON.parse(line) as InitReply);
        } catch {
          // not a JSON-RPC line
        }
      }
      return true;
    });
    void startMcpProxy(squatter.port).catch(() => undefined);
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });

    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`,
    );

    await vi.waitFor(
      () => {
        expect(replies.filter((r) => 1 === r.id).length).toBe(1);
      },
      { timeout: 8_000, interval: 100 },
    );
    const instructions = replies.find((r) => 1 === r.id)?.result?.instructions ?? '';
    expect(
      instructions,
      'the client was told the server started normally; nothing said the surface is unbacked',
    ).toContain('DEGRADED');
    expect(instructions).toContain(String(squatter.port));
  }, 30_000);
});
