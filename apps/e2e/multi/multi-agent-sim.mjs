/**
 * Many agents, many projects, one machine — driven for real.
 *
 * Unit tests pin the resolver's DECISIONS. They cannot tell you what happens when four daemons race
 * for a port, when one is killed under the others, or when a project's daemon moves and its agent has
 * to find it again. Those are properties of processes, sockets and the filesystem, and the only way
 * to know them is to start the processes and take the ports away.
 *
 * Everything here spawns the real `cli.js`, binds real ports, and reads the real registry in an
 * isolated RETICLE_STATE_DIR so a run can never touch the developer's own daemons.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(ROOT, 'packages/server/dist/cli.js');
const STATE = mkdtempSync(join(tmpdir(), 'reticle-sim-state-'));
const WORK = mkdtempSync(join(tmpdir(), 'reticle-sim-work-'));
const children = [];
let failures = 0;

/**
 * `--self-test` resolves ports the way the product did BEFORE per-project daemons: take the default,
 * attach to whatever owns it, ask no questions. The run must then FAIL.
 *
 * Without this, a green simulation proves only that the simulation is green. The same argument as
 * `gate:install:self-test`, which mis-wires every scaffold and requires the gate to redden: if the
 * negative control passes, the positive result means nothing.
 */
const LEGACY = process.argv.includes('--self-test');

function ok(name, cond, detail = '') {
  console.log(`   ${cond ? '✅' : '❌'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A project directory with a real .reticle.json, exactly as `init` writes one. */
function makeProject(name) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  writeFileSync(join(dir, '.reticle.json'), JSON.stringify({ framework: 'vite', projectId: name }));
  return dir;
}

/** Start a daemon the way `reticle mcp` does, in a project's cwd. */
function startDaemon(cwd, port) {
  const child = spawn(process.execPath, [CLI, '_daemon', '--port', String(port)], {
    cwd,
    env: { ...process.env, RETICLE_STATE_DIR: STATE, RETICLE_IDLE_SHUTDOWN_MS: '0' },
    stdio: 'ignore',
    detached: false,
  });
  children.push(child);
  return child;
}

function portOpen(port) {
  return new Promise((res) => {
    const s = new net.Socket();
    s.setTimeout(600);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
    s.connect(port, '127.0.0.1');
  });
}

async function waitPort(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(150);
  }
  return false;
}

/** What the registry says, read the same way the product reads it. */
function registry() {
  return readdirSync(STATE)
    .filter((f) => /^daemon-\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(readFileSync(join(STATE, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/** `resolveMcpPort` as the product computes it, in a given project's cwd. */
function resolvePortFor(cwd, requested) {
  // The old rule in one line: `envPort ?? projectPort ?? RETICLE_DEFAULT_PORT`, then adopt whoever
  // answers. Every project on the machine lands here, which is the defect.
  if (LEGACY) return requested;
  const out = execFileSync(
    process.execPath,
    ['-e', `
      const { resolveMcpPort } = require(${JSON.stringify(join(ROOT, 'packages/server/dist/daemon/daemon-resolve.js'))});
      const { pickDaemonPortToBind } = require(${JSON.stringify(join(ROOT, 'packages/server/dist/daemon/free-port.js'))});
      const net = require('node:net');
      const open = (p) => new Promise((res) => { const s = new net.Socket(); s.setTimeout(600);
        s.on('connect',()=>{s.destroy();res(true)}); s.on('error',()=>res(false));
        s.on('timeout',()=>{s.destroy();res(false)}); s.connect(p,'127.0.0.1'); });
      const alive = (pid) => { try { process.kill(pid,0); return true } catch { return false } };
      resolveMcpPort(${requested}, require('node:fs').existsSync('.reticle.json') ? JSON.parse(require('node:fs').readFileSync('.reticle.json','utf8')).projectId : undefined,
        ${JSON.stringify(STATE)}, { alive, daemonPresent: open, pickPort: pickDaemonPortToBind })
        .then((p) => { process.stdout.write(String(p)); });
    `],
    { cwd, env: { ...process.env, RETICLE_STATE_DIR: STATE }, encoding: 'utf8' },
  );
  return Number(out.trim());
}

function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(STATE, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log(`\n=== multi-agent simulation (state: ${STATE}) ===\n`);

// ── 1. Four projects, four agents, all preferring the same default port ──────────────────────────
console.log('──── four projects racing for one default port ────');
const NAMES = ['shop', 'blog', 'admin', 'docs'];
const dirs = Object.fromEntries(NAMES.map((n) => [n, makeProject(n)]));

// NOT 4400. The first run of this simulation used the real default and every spawned daemon failed
// to bind, because the developer's own daemon already held it — while `portOpen` cheerfully reported
// success, so the run "passed" its liveness checks and measured nothing. A harness that shares state
// with the machine it runs on is measuring the machine.
const BASE = 45500;
if (await portOpen(BASE)) {
  console.error(`refusing to run: ${BASE} is already in use, so this would measure somebody else's daemon`);
  process.exit(1);
}
const assigned = {};
for (const n of NAMES) {
  const port = resolvePortFor(dirs[n], BASE);
  assigned[n] = port;
  startDaemon(dirs[n], port);
  const up = await waitPort(port);
  ok(`${n} got a daemon`, up, `port ${port}`);
  // Bound is not the same as OURS: a port that was already open would pass the check above while the
  // spawned child died of EADDRINUSE. The registry entry is the only proof the daemon we started is
  // the daemon answering.
  await sleep(300);
  const owned = registry().find((e) => e.port === port);
  ok(`${n}'s daemon is the one we started`, owned?.projectId === n, `registry says ${owned?.projectId ?? 'nothing'}`);
}

const ports = Object.values(assigned);
ok('every project got its OWN port', new Set(ports).size === NAMES.length, ports.join(', '));
ok('the first project kept the documented default', assigned['shop'] === BASE, `shop=${assigned['shop']}`);

// ── 2. The registry tells the truth about who owns what ──────────────────────────────────────────
console.log('\n──── the registry is not a lie ────');
await sleep(500);
const reg = registry();
for (const n of NAMES) {
  const entry = reg.find((e) => e.port === assigned[n]);
  ok(`${n}'s daemon registers as ${n}`, entry?.projectId === n, `got ${entry?.projectId ?? 'nothing'}`);
}

// ── 3. Each agent re-resolves to its OWN daemon, never a neighbour's ─────────────────────────────
console.log('\n──── every agent finds its own daemon again ────');
for (const n of NAMES) {
  const again = resolvePortFor(dirs[n], BASE);
  ok(`${n} re-resolves to its own daemon`, again === assigned[n], `${again} vs ${assigned[n]}`);
}

// ── 4. Blast radius: kill one project's daemon, the others must not notice ───────────────────────
console.log('\n──── killing one daemon must not touch the others ────');
const victim = 'blog';
execFileSync('sh', ['-c', `lsof -ti tcp:${assigned[victim]} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]);
await sleep(1200);
ok(`${victim}'s daemon is down`, !(await portOpen(assigned[victim])));
for (const n of NAMES.filter((x) => x !== victim)) {
  ok(`${n} is still serving`, await portOpen(assigned[n]), `port ${assigned[n]}`);
}

// ── 5. A project whose daemon died gets a NEW one, not a neighbour's ─────────────────────────────
console.log('\n──── recovery goes to a fresh daemon, not somebody else’s ────');
const revived = resolvePortFor(dirs[victim], BASE);
ok(
  `${victim} does not resolve onto a live neighbour`,
  !Object.entries(assigned).some(([n, p]) => n !== victim && p === revived),
  `resolved ${revived}`,
);

if (LEGACY) {
  const caught = failures > 0;
  console.log(
    `\n================ SELF-TEST: legacy resolution produced ${failures} failure(s) — ` +
      `${caught ? 'the simulation can detect the defect' : 'THE SIMULATION IS BLIND'} ================\n`,
  );
  process.exit(caught ? 0 : 1);
}
console.log(`\n================ ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} ================\n`);
process.exit(failures === 0 ? 0 : 1);
