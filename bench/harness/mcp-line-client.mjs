// Minimal MCP stdio client: speaks the exact wire an agent client speaks.
import { spawn } from 'node:child_process';

export function connect({ cli, port, cwd, env = {} }) {
  const proc = spawn(process.execPath, [cli, 'mcp', '--port', String(port)], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const pending = new Map();
  let id = 0;
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(String(d)));
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const rpc = (method, params, timeoutMs = 45000) =>
    new Promise((resolve) => {
      const myId = ++id;
      const timer = setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId);
          resolve({ __timeout: true, method, params });
        }
      }, timeoutMs);
      pending.set(myId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  return {
    proc,
    stderr,
    async init() {
      const r = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'reticle-experiment', version: '0' },
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      return r;
    },
    listTools: () => rpc('tools/list', {}),
    call: (name, args, timeoutMs) => rpc('tools/call', { name, arguments: args }, timeoutMs),
    close: () => {
      // A proxy that already exited is the normal case, not an error worth surfacing.
      try {
        proc.kill('SIGTERM');
      } catch {
        return;
      }
    },
  };
}
