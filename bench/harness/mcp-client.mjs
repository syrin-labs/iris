// Minimal MCP stdio client (JSON-RPC 2.0, newline-delimited framing).
// Used to drive Playwright MCP / Chrome DevTools MCP / Reticle MCP WITHOUT an LLM,
// so we can capture the exact tool-response payloads, wall-clock latency, and
// whether a failure signal is present. This is the "observation-cost" layer and
// needs no API key. The agent-loop layer (claude-agent-loop.mjs) is separate.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class McpStdioClient {
  constructor(command, args, env = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = [];
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.command !== 'node' && 'win32' === process.platform,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => this.stderr.push(d));
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending)
        p.reject(
          new Error(
            `mcp process exited code=${code}${this.stderr.length ? ' — ' + this.stderr.join('') : ''}`,
          ),
        );
      this.pending.clear();
    });
    // MCP initialize handshake.
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'reticle-bench', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
    return init;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (0 === line.length) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log line on stdout; ignore
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async listTools() {
    const r = await this.request('tools/list', {});
    return r.tools ?? [];
  }

  // Returns { result, latencyMs, text } where text is the concatenated text content.
  async callTool(name, args, timeoutMs = 60000) {
    const t0 = process.hrtime.bigint();
    let result;
    try {
      result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    } catch (e) {
      // The advertised surface is capped, so a tool can exist, work, and still not be listed. These
      // harnesses call by NAME from a dozen files, and the server itself says the way through is
      // `reticle_run { tool, args }` — so take it here rather than in every caller, and only for
      // the refusal that names this cause. Anything else still throws.
      if (!/not advertised under this tool profile/.test(String(e?.message ?? ''))) throw e;
      result = await this.request(
        'tools/call',
        { name: 'reticle_run', arguments: { tool: name, args } },
        timeoutMs,
      );
    }
    const t1 = process.hrtime.bigint();
    const latencyMs = Number(t1 - t0) / 1e6;
    const text = (result?.content ?? [])
      .filter((c) => 'text' === c.type)
      .map((c) => c.text)
      .join('\n');
    // A protocol-level tool error (unknown/renamed tool) arrives as a SUCCESSFUL JSON-RPC result
    // carrying isError:true, so the transport's reject path never fires and every caller here read
    // "MCP error -32602: Tool ... not found" as ordinary output. Nine bench harnesses called
    // reticle_record_start/stop for an unknown number of commits after those were consolidated into
    // reticle_record{action}, recorded nothing, saved nothing, and still printed an RRE ratio over
    // the wreckage. Fail loudly instead: a benchmark that cannot call its tool has no number to give.
    if (true === result?.isError) {
      throw new Error(`tool ${name} failed: ${text.slice(0, 300)}`);
    }
    return { result, latencyMs, text };
  }

  async stop() {
    try {
      if ('win32' === process.platform && this.proc?.pid) {
        try {
          execFileSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
        } catch {
          this.proc?.kill('SIGTERM');
        }
      } else {
        this.proc?.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
  }
}

/**
 * The reticle CLI entrypoint, resolved once.
 *
 * This lived as a hand-written path literal in three call sites, all of which still said
 * `packages/core/dist/cli.js` after the CLI moved to `packages/server`. Nothing referenced a missing
 * file until spawn time, where it surfaced only as `mcp process exited code=1` — so the head-to-head
 * suite was simply unrunnable, with no error that named the cause. Resolved and existence-checked here
 * so a future move fails loudly, in one place.
 */
export const RETICLE_CLI = (() => {
  const p = path.join(REPO_ROOT, 'packages', 'server', 'dist', 'cli.js');
  if (!existsSync(p))
    throw new Error(
      `reticle CLI not found at ${p} — run \`pnpm build\` first (or fix RETICLE_CLI if the CLI moved).`,
    );
  return p;
})();
