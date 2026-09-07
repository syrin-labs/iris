// Shared boot for the desktop battery.
//
// Unlike the web specs, a desktop spec cannot lean on run-ci.sh: there is no server to curl and no
// URL to open. The app IS the process, so each spec starts its own runtime and waits for it to DIAL
// the bridge — which is the direction that makes desktop desktop, and the thing worth regression-
// testing in the first place.
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  createNodeFileSystem,
} from '@reticlehq/server';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Captures this machine's shells have left in the temp dir — the leak check both specs run. */
export const tempCaptures = () =>
  readdirSync(os.tmpdir()).filter((f) => f.startsWith('reticle-capture-'));

export function checker() {
  const state = { pass: 0, fail: 0 };
  const chk = (label, ok, detail = '') => {
    process.stdout.write(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}\n`);
    ok ? (state.pass += 1) : (state.fail += 1);
  };
  return { chk, state };
}

/**
 * The pairing token the bridge requires. Provisioned by run-ci.sh (and by the daemon in normal use);
 * a desktop spec run on its own creates nothing, so an absent token is a setup error, not a skip.
 */
export function pairingToken() {
  const file = path.join(process.env['RETICLE_PAIRING_TOKEN_DIR'] ?? path.join(os.homedir(), '.reticle'), 'pairing-token');
  if (!existsSync(file)) {
    throw new Error(`no pairing token at ${file} — start the daemon once, or run via \`pnpm e2e:desktop\``);
  }
  return readFileSync(file, 'utf8').trim();
}

/**
 * Boot a bridge on `port` and wait for exactly one desktop session to dial in.
 *
 * `spawnApp(env)` returns the child process. Deliberately NO silent skip when it fails to connect:
 * a desktop runtime that cannot be driven is the regression this battery exists to catch, and a
 * green run that quietly tested nothing is the exact failure mode that once left four specs dead.
 */
export async function bootDesktopSession({
  spawnApp,
  port = 4400,
  extraEnv = {},
  timeoutMs = 60_000,
  urlIncludes,
}) {
  const env = {
    ...process.env,
    RETICLE_PORT: String(port),
    VITE_RETICLE_TOKEN: pairingToken(),
    RETICLE_TELEMETRY: '0',
    ...extraEnv,
  };
  const server = await start({ port, mcp: false });
  const log = [];
  // Anything already on the bridge belongs to somebody else — our app has not started yet.
  const preexisting = new Set(server.bridge.sessions.list().map((s) => s.sessionId));
  const app = spawnApp(env);
  app.stdout?.on('data', (d) => log.push(String(d)));
  app.stderr?.on('data', (d) => log.push(String(d)));

  // Take OUR app's session, never merely the first one on the bridge.
  //
  // `sessions.list()[0]` is what this did, and it is a false green waiting to happen: the specs share
  // the bridge on :4400, so when a previous spec's app outlives its shutdown, the next spec silently
  // drives the WRONG app and reports green. Measured — the Tauri spec asserted its packaged origin and
  // got `file:///…/apps/electron-smoke/dist/index.html` back. Every check after that point would have
  // been testing Electron while claiming to test Tauri.
  const mine = () => {
    const fresh = server.bridge.sessions.list().filter((s) => !preexisting.has(s.sessionId));
    return urlIncludes === undefined
      ? fresh[0]
      : fresh.find((s) => String(s.url ?? '').includes(urlIncludes));
  };
  const deadline = Date.now() + timeoutMs;
  while (mine() === undefined && Date.now() < deadline) await sleep(100);

  const found = mine();
  if (found === undefined) {
    const seen = server.bridge.sessions
      .list()
      .map((s) => String(s.url))
      .join(' | ');
    throw new Error(
      `no NEW session matching '${String(urlIncludes ?? 'any')}' after ${String(timeoutMs)}ms — sessions on the bridge: [${seen}]`,
    );
  }
  const sessionId = found?.sessionId;
  const reticleRoot = path.join(os.tmpdir(), `reticle-desktop-${String(process.pid)}`, '.reticle');
  const deps = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    fs: createNodeFileSystem(),
    reticleRoot,
    now: () => Date.now(),
  };
  const tool = (name, args = {}) =>
    TOOLS.find((t) => t.name === name).handler(deps, { sessionId, ...args });

  /** Resolve a testid to a ref, retrying while the app finishes its first render. */
  const refOf = async (value, by = 'testid') => {
    for (let i = 0; i < 40; i++) {
      const ref = (await tool('reticle_query', { by, value })).elements?.[0]?.ref;
      if (ref !== undefined) return ref;
      await sleep(200);
    }
    return undefined;
  };

  /**
   * Kill the app's whole PROCESS GROUP, not just the launcher.
   *
   * `app.kill()` sends SIGTERM to the process we spawned. Electron is a process TREE — a launcher,
   * a main process, a renderer, a GPU helper — and the tree outlives the launcher. The window stayed
   * open, kept its Reticle session alive, and RECONNECTED to the next bridge that appeared on the
   * same port. Measured: a headful Electron run left a window behind that then answered a later
   * probe aimed at a completely different app, which reported 5/5 against the wrong application.
   * That is a false green produced by the harness itself, and it is the shape of much of this
   * battery's intermittent failure.
   *
   * `run.mjs` already does exactly this for specs; the desktop harness did not. Escalate TERM → KILL
   * and target the group (negative pid) so nothing the app spawned is left behind.
   */
  const shutdown = async () => {
    const pid = app.pid;
    const killGroup = (signal) => {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        /* group already gone — the normal case on a clean exit */
      }
    };
    const alive = () => {
      try {
        if (pid === undefined) return false;
        process.kill(pid, 0); // signal 0 tests existence without delivering anything
        return true;
      } catch {
        return false;
      }
    };
    killGroup('SIGTERM');
    // VERIFY, do not assume. A Tauri binary survived both the group TERM and the first KILL and kept
    // its session alive, so a shutdown that returns without checking is a lie the next run pays for.
    for (let i = 0; i < 30 && alive(); i += 1) {
      if (i === 2) killGroup('SIGKILL');
      if (i === 6) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone between the check and the signal */
        }
      }
      await sleep(100);
    }
    if (alive()) console.warn(`[harness] app pid ${String(pid)} SURVIVED shutdown — it will pollute the next run`);
    await server.close();
  };

  return { server, app, sessionId, tool, refOf, shutdown, log };
}

/** Spawn Electron against the smoke app's Vite dev server, which this also starts. */
export async function spawnElectronSmoke(env, { port = 5174 } = {}) {
  // Whether ANYTHING answers is not the question — whether OURS does is. This waited for a 200 on
  // the port and took it as readiness, so a stranger already serving there answered instantly, the
  // strictPort vite we had just spawned died on the conflict unnoticed, and the spec drove somebody
  // else's app: no window.api, no todos, and a run of assertions failing for reasons that had
  // nothing to do with Reticle. A ten-hour-old scratch server from an unrelated experiment cost a
  // full debugging pass. The same rule the daemon already follows: a port held by a stranger is
  // reported as one.
  if (await answers(port)) {
    throw new Error(
      `port ${String(port)} is already serving something, and it is not this app. Free it before ` +
        `running the desktop battery: lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
    );
  }
  const vite = spawn(
    'pnpm',
    ['--filter', '@reticlehq/electron-smoke', 'exec', 'vite', '--port', String(port), '--strictPort'],
    { cwd: ROOT, env, stdio: 'ignore' },
  );
  let exited;
  vite.on('exit', (code) => {
    exited = code ?? 0;
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (await answers(port)) break;
    // A strictPort vite that loses the race exits rather than relocating, and its death is the
    // whole signal. Waiting out the deadline after it would report a timeout for a conflict.
    if (exited !== undefined) {
      throw new Error(
        `the electron-smoke vite server exited (code ${String(exited)}) before serving port ` +
          `${String(port)} — most likely the port was taken`,
      );
    }
    if (Date.now() > deadline) throw new Error('the electron-smoke vite server never came up');
    await sleep(500);
  }
  return { vite, electronBin: resolveElectronBinary() };
}

/** Whether anything at all is serving this port. */
async function answers(port) {
  try {
    return (await fetch(`http://localhost:${String(port)}`)).ok;
  } catch {
    return false;
  }
}

/**
 * Electron's own launcher path. `require('electron')` exports it as a string, so this is what the
 * `electron` CLI would exec — resolved directly so the spec does not depend on a bin shim.
 */
function resolveElectronBinary() {
  const require = createRequire(path.join(ROOT, 'apps', 'electron-smoke', 'package.json'));
  const bin = require('electron');
  if (typeof bin !== 'string' || !existsSync(bin)) {
    throw new Error('electron is not installed — run `pnpm install` in apps/electron-smoke');
  }
  return bin;
}

/**
 * `spawn`, but the child owns its process GROUP and `kill()` takes the whole tree down.
 *
 * A desktop runtime is a process tree — an Electron launcher, a main process, a renderer, a GPU
 * helper; a vite launcher and the server it execs. `child.kill()` signals only the process we
 * spawned, so the tree survived: the window stayed open, kept its Reticle session, and reconnected
 * to the NEXT bridge on the same port. A later probe aimed at a different app then got answers from
 * that leftover window and reported success against the wrong application.
 *
 * Detaching puts the child in its own group so a negative-pid signal reaches everything it started,
 * and `kill` is wrapped so every existing caller gets the tree kill without changing its code.
 */
export function spawn(command, args, options = {}) {
  // `shell` on Windows, because a package-manager entry point there is `pnpm.CMD`, not `pnpm`, and
  // a bare spawn dies with ENOENT before the app it was launching exists. Process GROUPS are also a
  // POSIX concept, so the negative-pid kill below is skipped there; Windows already terminates the
  // whole tree for a detached child, which is what the group signal buys us on POSIX.
  const windows = process.platform === 'win32';
  const child = nodeSpawn(command, args, { detached: true, shell: windows, ...options });
  const killOne = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    try {
      if (!windows && child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      /* group already gone — normal after a clean exit */
    }
    return killOne(signal);
  };
  return child;
}
