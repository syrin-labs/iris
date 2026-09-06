#!/usr/bin/env node
/**
 * The negative control for `reticle.sh`: environments built to BREAK it.
 *
 *   node setup/break-matrix.mjs [--only <name>] [--keep]
 *
 * A setup script is judged by its failures, not its successes. The success path has one shape and a
 * real app behind it (reticle-fixtures); the failure paths are where a user actually lives, and
 * every one of them can go wrong in the same silent way — a stack trace, or a confident wrong cause
 * that sends somebody into the install hunting a bug that is not there.
 *
 * So each scenario asserts four things, and the last two are the ones that matter:
 *
 *   1. it exits non-zero                       (never a green install for a broken machine)
 *   2. no raw stack trace reaches the user     (`TypeError: fetch is not defined` is not a message)
 *   3. the output NAMES the actual cause       (the specific string this scenario is about)
 *   4. `ok` is false in --json                 (an agent reads the object, not the prose)
 *
 * Scenarios that need no network fail before `init` and cost milliseconds. The rest pay one real
 * `init`, which is the honest price of testing what the script actually does.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * What ships, not the prototype beside it.
 *
 * These scenarios were written against setup/reticle.sh, which has since been ported into the CLI
 * as `init`'s runtime phase. Pointing them at dist/cli.js is the only way they keep testing the
 * thing users actually run — a negative control aimed at a superseded entry point proves nothing,
 * however green it stays.
 */
const CLI = join(HERE, '..', 'packages', 'server', 'dist', 'cli.js');
/** The shell entry point, whose OWN guards two scenarios below exist to judge. */
const LAUNCHER_SH = join(HERE, 'reticle.sh');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const keep = args.includes('--keep');

/** A stack trace in front of a user is a bug regardless of what caused it. */
const STACK = /^\s+at .+:\d+:\d+\)?$/m;
const CRASH =
  /(TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+|Cannot read propert|is not a function|is not defined)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** stdout of a shell one-liner, for the port checks a scenario makes about the machine. */
const quietSync = (c) => spawnSync('sh', ['-c', c], { encoding: 'utf8' }).stdout ?? '';

/**
 * The scenarios that test the LAUNCHER, not `init`.
 *
 * `node-missing` blanks PATH and expects "needs Node"; `node-too-old` puts a fake v16 in front. Both
 * judge the shell entry point's own guards, and pointing them at `node dist/cli.js` did not make
 * them fail — it made them meaningless. `process.execPath` is an absolute path, so it ignores the
 * PATH the scenario just constructed, and Node is found every time. A check that cannot fail is
 * worse than no check: it reports green for a guard nobody is running.
 *
 * So the launcher scenarios run the launcher. `init` scenarios still run the shipped CLI, which is
 * what the retarget was for.
 */
function runLauncher(dir, extraArgs = [], env = {}, timeoutMs = 90_000) {
  try {
    const out = execFileSync(
      '/bin/sh',
      [LAUNCHER_SH, '--json', '--timeout', '3', '--no-drive', '--no-open', ...extraArgs],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { code: 0, out };
  } catch (error) {
    return {
      code: error?.status ?? 1,
      out: `${error?.stdout ?? ''}${error?.stderr ?? ''}`,
    };
  }
}

function run(dir, extraArgs = [], env = {}, timeoutMs = 90_000) {
  try {
    // `--no-open` is not politeness: these are FAILURE environments, `open` is never the thing
    // under test in them, and without it every scenario that reaches the connect phase throws a
    // real browser window at whoever is running the matrix.
    const out = execFileSync(
      process.execPath,
      [CLI, 'init', '--json', '--timeout', '3', '--no-drive', '--no-open', ...extraArgs],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: timeoutMs,
        env: { ...process.env, ...env },
      },
    );
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 'timeout', out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** A directory containing whatever package.json the scenario needs. */
function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-break-'));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

/** A PATH with a fake `node` in front of the real one, so version/absence can be forced. */
function shimmedPath(dir, script) {
  const bin = join(dir, 'shim');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), script);
  chmodSync(join(bin, 'node'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

const pkg = (scripts) => ({ name: 'broken-app', version: '1.0.0', scripts });

const SCENARIOS = [
  {
    name: 'node-missing',
    why: 'the launcher runs on a machine with no Node at all — the most basic possible failure',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    run: (dir) => runLauncher(dir, [], { PATH: '/usr/bin:/bin' }),
    expect: 'needs Node',
  },
  {
    name: 'node-too-old',
    why: "Node 16 has no global fetch. The script would die on `fetch is not defined` several phases in, long after it has edited the user's files",
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // A faithful stand-in for Node 16: it reports v16 AND fails the launcher's version probe the
    // way a real old Node would (`process.exit(major >= 18 ? 0 : 1)` exits 1 there). Delegating the
    // probe to the real Node made this scenario green while the guard did nothing.
    run: (dir) =>
      runLauncher(dir, [], {
        PATH: shimmedPath(
          dir,
          '#!/bin/sh\ncase "$1" in\n  -v|--version) echo v16.20.2; exit 0 ;;\n  -e) exit 1 ;;\nesac\nexec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/local/bin node "$@"\n',
        ),
      }),
    expect: 'Node 18',
  },
  {
    name: 'package-json-malformed',
    why: 'a trailing comma in package.json must not surface as a JSON.parse stack trace',
    build: () => app({ 'package.json': '{ "name": "x", }' }),
    run: (dir) => run(dir),
    expect: 'package.json',
  },
  {
    name: 'no-scripts-at-all',
    why: 'a package.json with no scripts key: SKILL.md says stop, never invent a dev command',
    build: () => app({ 'package.json': { name: 'x', version: '1.0.0' } }),
    run: (dir) => run(dir),
    expect: 'rather than invent',
  },
  {
    name: 'dev-server-exits-immediately',
    why: 'the dev script is broken (missing dep, bad config). Waiting the full budget for a URL from a dead process is the difference between 4 seconds and 2 minutes',
    build: () =>
      app({
        'package.json': pkg({ dev: 'echo "Error: Cannot find module \'vite\'" >&2; exit 1' }),
      }),
    run: (dir) => run(dir),
    expect: 'dev server exited',
  },
  {
    name: 'dev-server-never-prints-a-url',
    why: 'it boots, says nothing parseable, and binds no port either. Setup must time out with the log named — and must say it checked BOTH, since a server that prints nothing but IS listening is the CRA case and must not be failed',
    build: () => app({ 'package.json': pkg({ dev: 'echo starting...; sleep 60' }) }),
    run: (dir) => run(dir),
    expect: 'neither printed a URL nor bound a port',
  },
  {
    name: 'dev-server-url-is-https-self-signed',
    why: 'a dev server on https with its own certificate — an ordinary local setup (vite --https, mkcert). fetch REFUSES it, and calling that "nothing is listening" tells the user to start a server that is already running',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // A REAL https server with a REAL self-signed cert. The previous version of this scenario just
    // echoed an https url and slept, so nothing ever listened, the failure was ECONNREFUSED rather
    // than a certificate error, and it passed for a reason unrelated to what it claims to test.
    setup: async (dir) => {
      execFileSync('sh', [
        '-c',
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=localhost 2>/dev/null`,
      ]);
      const srv = spawn(
        process.execPath,
        [
          '-e',
          `const https=require('https'),fs=require('fs');https.createServer({key:fs.readFileSync('${dir}/k.pem'),cert:fs.readFileSync('${dir}/c.pem')},(_,r)=>r.end('<html>up</html>')).listen(59993,'127.0.0.1')`,
        ],
        { stdio: 'ignore' },
      );
      await sleep(1500);
      return srv;
    },
    run: (dir) => run(dir, ['--url', 'https://127.0.0.1:59993/']),
    // The server is UP. The only honest answer is that we cannot read it, not that it is down.
    expect: 'certificate this process will not accept',
  },
  {
    name: 'read-only-project',
    why: 'a checkout the user cannot write to (root-owned, or a mounted volume). Every file setup writes fails, and EACCES must not arrive as a stack',
    build: () => {
      const d = app({ 'package.json': pkg({ dev: 'true' }) });
      chmodSync(d, 0o555);
      return d;
    },
    run: (dir) => run(dir),
    expect: 'not writable',
    cleanup: (dir) => chmodSync(dir, 0o755),
  },
  {
    name: 'npm-registry-unreachable',
    why: 'offline, or behind a proxy that blocks the registry. npx cannot fetch the CLI, and the user must be told THAT rather than something about their app',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    run: (dir) =>
      run(dir, [], {
        npm_config_registry: 'http://127.0.0.1:59994/',
        npm_config_fetch_retries: '0',
      }),
    expect: 'registry',
    knownWeakness: 'no registry-specific diagnosis yet',
  },
  {
    name: 'bridge-port-held-by-a-stranger',
    why: "something that is not our daemon owns 4400. Sessions can never appear, and blaming the app's wiring sends the user to the wrong place entirely",
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // On its OWN port, never the default 4400: a real daemon from other work on this machine owns
    // that one, so squatting it tests whichever process won the race rather than the scenario.
    setup: async (dir) => {
      const squatter = spawn(
        process.execPath,
        ['-e', "require('net').createServer(()=>{}).listen(59996,'127.0.0.1')"],
        { stdio: 'ignore' },
      );
      await sleep(500);
      return squatter;
    },
    run: (dir) => run(dir, ['--port', '59996', '--url', 'http://127.0.0.1:59995/']),
    expect: 'is held by something that is not a Reticle daemon',
  },
  {
    name: 'monorepo-with-several-apps',
    why: 'init refuses to guess between apps, lists them and names --app. SKILL.md says the agent PICKS ONE and re-runs; stopping here is where the hand-driven arm burned its entire 20-minute cap',
    build: () =>
      app({
        'package.json': { name: 'root', private: true, workspaces: ['apps/*'] },
        'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
        // Only ONE of them can actually be served. That is the whole signal: the app with a dev
        // script is the app somebody is working in, and the only one that can produce a session.
        'apps/docs/package.json': { name: 'docs', version: '1.0.0', scripts: { build: 'true' } },
        'apps/web/package.json': {
          name: 'web',
          version: '1.0.0',
          scripts: { dev: 'echo "  Local: http://localhost:59997/"; sleep 20' },
        },
      }),
    run: (dir) => run(dir),
    // Never "it stopped and asked": it must have CHOSEN, and said which one and why.
    expect: 'apps/web',
  },
  {
    name: 'agent-cli-present-but-broken',
    why: 'an agent CLI on PATH that does not run (a half-installed codex, a missing vendor binary). Restarting into it, or driving with it, produces an empty session that looks exactly like success',
    build: () =>
      app({ 'package.json': pkg({ dev: 'echo "  Local: http://localhost:59998/"; sleep 20' }) }),
    run: (dir) =>
      run(dir, ['--url', 'http://127.0.0.1:59998/'], {
        PATH: (() => {
          const bin = join(dir, 'brokenbin');
          mkdirSync(bin, { recursive: true });
          writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "Error: spawn ENOENT" >&2\nexit 1\n');
          chmodSync(join(bin, 'claude'), 0o755);
          return `${bin}:${process.env.PATH}`;
        })(),
      }),
    expect: 'nothing is serving',
  },
  {
    name: 'no-browser-to-open',
    why: 'the case a user named directly: Chromium/Chrome absent, or a headless box (CI, a container, SSH, WSL with no host browser). Nothing will ever dial in from a tab, and without saying so setup waits out the whole budget and blames the SDK wiring',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // A PATH with no browser LAUNCHER on it, which is how a headless box actually looks.
    //
    // This used to shim `npx` and refuse an `open` subcommand, from when setup opened a browser that
    // way. The CLI spawns the platform launcher directly — `open` on darwin, `xdg-open` elsewhere —
    // so the npx shim intercepted nothing, and on any machine that HAS a browser the launcher simply
    // succeeded: the scenario could never fail on macOS, and never tested what it claims anywhere.
    //
    // Shimming the launcher itself works on both platforms and is the real condition. This is also
    // the ONE scenario that must NOT pass --no-open: the open path is the thing under test.
    run: (dir) => {
      const bin = join(dir, 'nobrowser');
      mkdirSync(bin, { recursive: true });
      // The real npx by ABSOLUTE path. `exec env npx` re-resolved through PATH to this shim and
      // recursed until the timeout, which produced no output at all — a scenario that fails for a
      // reason having nothing to do with what it is testing.
      const realNpx = execFileSync('sh', ['-c', 'command -v npx'], { encoding: 'utf8' }).trim();
      // The launcher the CLI will actually spawn, replaced by one that fails the way a missing
      // browser fails: it starts fine and exits non-zero with nothing to open.
      for (const launcher of ['open', 'xdg-open']) {
        writeFileSync(
          join(bin, launcher),
          `#!/bin/sh\necho "Error: browser executable doesn't exist at /root/.cache/ms-playwright/chromium/chrome-linux/chrome" >&2\nexit 1\n`,
        );
        chmodSync(join(bin, launcher), 0o755);
      }
      writeFileSync(
        join(bin, 'npx'),
        // Two interceptions, because setup now resolves the CLI binary once and calls it directly:
        //   -c    the resolution probe. Refusing it sends setup down its npx fallback, which is the
        //         only path on which this shim is visible at all.
        //   open  the failure being simulated.
        // Without the first, the resolve-once optimisation quietly routed around this scenario, and
        // it started letting a real browser window through to whoever ran the tests.
        `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "-c" ]; then exit 1; fi\n  if [ "$a" = "open" ]; then\n    echo "Error: browser executable doesn't exist at /root/.cache/ms-playwright/chromium/chrome-linux/chrome" >&2\n    exit 1\n  fi\ndone\nexec ${realNpx} "$@"\n`,
      );
      chmodSync(join(bin, 'npx'), 0o755);
      try {
        return {
          code: 1,
          out: execFileSync(
            process.execPath,
            [
              CLI,
              'init',
              '--json',
              '--timeout',
              '3',
              '--no-drive',
              '--url',
              'http://127.0.0.1:59992/',
            ],
            {
              cwd: dir,
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 90_000,
              env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: '1' },
            },
          ),
        };
      } catch (err) {
        return { code: err.status ?? 'timeout', out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    },
    // Naming the lease is the whole point: it is the ONLY way to get a driveable context on a
    // machine with no browser, and an agent that is not told about it cannot invent it.
    expect: 'reticle_lease',
  },
  {
    name: 'package-manager-not-installed',
    why: 'a pnpm-lock.yaml on a machine that only has npm — an ordinary Monday. Without a check it surfaces as `spawn pnpm ENOENT` inside "dev server exited", and the reader goes hunting in their dev script',
    build: () =>
      app({ 'package.json': pkg({ dev: 'true' }), 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' }),
    // A PATH with node and npx but deliberately no pnpm.
    run: (dir) => {
      const bin = join(dir, 'pmbin');
      mkdirSync(bin, { recursive: true });
      for (const t of ['node', 'npx', 'npm', 'claude']) {
        const real = spawnSync('sh', ['-c', `command -v ${t} || true`], {
          encoding: 'utf8',
        }).stdout.trim();
        if (real) {
          writeFileSync(join(bin, t), `#!/bin/sh\nexec ${real} "$@"\n`);
          chmodSync(join(bin, t), 0o755);
        }
      }
      return run(dir, [], { PATH: `${bin}:/usr/bin:/bin` });
    },
    expect: 'pnpm is not installed',
  },
  {
    name: 'corrupt-reticle-json-from-a-half-finished-run',
    why: 'a previous run died mid-write, or somebody hand-edited it. The config is the one file every later phase trusts, and a truncated one must not surface as a parse stack',
    build: () =>
      app({
        'package.json': pkg({ dev: 'echo "  Local: http://localhost:59991/"; sleep 20' }),
        '.reticle.json': '{ "port": 44',
      }),
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59991/']),
    expect: 'nothing is serving',
    knownWeakness:
      'asserts only that it does not crash; setup does not yet read .reticle.json itself',
  },
  {
    name: 'rerun-over-an-existing-install',
    why: 'the second run. SKILL.md branches on .reticle.json existing — a saved flow means REPLAY, not another expensive model-driven drive. Re-running setup must be idempotent and must not redo the drive',
    build: () =>
      app({
        'package.json': pkg({ dev: 'echo "  Local: http://127.0.0.1:59990/"; sleep 20' }),
        '.reticle.json': JSON.stringify({ projectId: 'already-here', port: 4400 }),
        '.reticle/flows/login.json': JSON.stringify({ name: 'login', steps: [] }),
      }),
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59990/']),
    // It still has to fail at the connect gate (nothing is serving that url) — the point is that it
    // reaches that gate cleanly rather than treating an existing install as a reason to crash.
    expect: 'nothing is serving',
  },
  {
    name: 'yarn-pnp-no-node-modules',
    why: 'Yarn PnP resolves from .pnp.cjs and has NO node_modules at all. Anything that reasons about that directory existing is wrong here, and the app is otherwise completely normal',
    build: () =>
      app({
        'package.json': {
          name: 'pnp-app',
          version: '1.0.0',
          packageManager: 'yarn@4.0.0',
          scripts: { dev: 'echo "  Local: http://127.0.0.1:59989/"; sleep 20' },
        },
        '.pnp.cjs': '// pnp runtime\n',
        'yarn.lock': '# yarn lockfile v1\n',
        '.yarnrc.yml': 'nodeLinker: pnp\n',
      }),
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59989/']),
    // Must reach the connect gate like any other app — not trip over the absent node_modules.
    expect: 'nothing is serving',
  },
  {
    name: 'dev-server-serves-only-a-base-path',
    why: 'an app mounted under /admin or /app: the root 404s while the app is perfectly healthy. Declaring the server dead because / is not 200 is a confident wrong cause',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    setup: async (dir) => {
      const srv = spawn(
        process.execPath,
        [
          '-e',
          "require('http').createServer((q,r)=>{if(q.url.startsWith('/admin')){r.end('<html>app</html>')}else{r.statusCode=404;r.end('not found')}}).listen(59988,'127.0.0.1')",
        ],
        { stdio: 'ignore' },
      );
      await sleep(1000);
      return srv;
    },
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59988/admin']),
    // A 404 at / is not "nothing is serving"; the page under test answered.
    expect: 'SDK is NOT in the page',
  },
  {
    name: 'interrupted-midway-leaves-no-orphan',
    why: 'Ctrl-C during setup. It starts a dev server the user did not start, detached, and a killed setup must not leave that running forever holding a port nobody can account for',
    build: () =>
      app({
        'package.json': pkg({
          dev: `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(59987,'127.0.0.1');console.log('  Local: http://127.0.0.1:59987/')"`,
        }),
      }),
    run: async (dir) => {
      const child = spawn(
        process.execPath,
        [CLI, 'init', '--json', '--timeout', '30', '--no-drive', '--no-open'],
        {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        },
      );
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      // Let it get the dev server up, then interrupt the way a person would.
      await sleep(9000);
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        /* already gone */
      }
      await sleep(3000);
      const orphan = (quietSync(`lsof -ti:59987 -sTCP:LISTEN || true`) ?? '').trim();
      if (orphan !== '') {
        for (const pid of orphan.split('\n')) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        return {
          code: 1,
          out: `${out}\nORPHANED: a dev server was still listening on 59987 after SIGINT (pid ${orphan.replace(/\n/g, ' ')})`,
        };
      }
      return { code: 1, out: `${out}\nno orphan on 59987 after SIGINT` };
    },
    expect: 'no orphan on 59987',
  },
  {
    name: 'dev-server-binds-ipv6-only',
    why: 'Node 18+ resolves localhost to ::1 first, and plenty of dev servers bind only ::1. Probing 127.0.0.1 explicitly then finds nothing and declares a healthy server dead',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    setup: async (dir) => {
      const srv = spawn(
        process.execPath,
        [
          '-e',
          "require('http').createServer((_,r)=>r.end('<html>ipv6 only</html>')).listen(59986,'::1')",
        ],
        { stdio: 'ignore' },
      );
      await sleep(1000);
      return srv;
    },
    // Announced as localhost, which is what a dev server actually prints.
    run: (dir) => run(dir, ['--url', 'http://localhost:59986/']),
    // It must reach the page, not report it as down.
    expect: 'SDK is NOT in the page',
  },
  {
    name: 'not-a-git-repository',
    why: 'a downloaded zip, a scaffold before `git init`, a container checkout. Nothing about instrumenting an app requires git, so nothing here may assume it',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59985/']),
    expect: 'nothing is serving',
  },
  {
    name: 'drive-does-nothing-must-not-exit-zero',
    why: 'the drive can return having done nothing at all — measured, a model answered "I don\'t see an actual task or request from you yet" in one turn. Setup exited 0 with no verdict, and anything scripting the exit code would have shipped on that false green',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // A `claude` that succeeds and produces nothing: exactly the shape of the real failure.
    run: (dir) => {
      const bin = join(dir, 'idlebin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'claude'), 0o755);
      return run(dir, ['--url', 'http://127.0.0.1:59984/'], { PATH: `${bin}:${process.env.PATH}` });
    },
    expect: 'nothing is serving',
  },
  {
    name: 'weak-flow-is-re-recorded-not-accepted',
    why: 'a fast drive model leaves flows graded assertion-free or presence-only — they only ACT, so they pass even when the feature is broken, and setup replays them forever. The weak artifact must be re-recorded with the stronger model, not handed over with a warning',
    build: () => app({ 'package.json': pkg({ dev: 'true' }), '.reticle/flows/f.json': '{}' }),
    run: (dir) => {
      // First call (with --model) reports a weak grade; the second (without) reports asserted. The
      // counter file is how the scenario proves a SECOND drive happened at all.
      const bin = join(dir, 'gradebin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--model" ]; then\n  echo '{"result":"Flow saved. assertions.grade: presence-only","num_turns":3}'\n  echo weak >> ${dir}/calls\n  exit 0\nfi; done\necho '{"result":"Flow saved. assertions.grade: asserted","num_turns":9}'\necho strong >> ${dir}/calls\nexit 0\n`,
      );
      chmodSync(join(bin, 'claude'), 0o755);
      const r = run(dir, ['--url', 'http://127.0.0.1:59983/', '--drive-model', 'fast-one'], {
        PATH: `${bin}:${process.env.PATH}`,
      });
      return r;
    },
    // It never gets a session here, so the drive never runs — what this pins is that the escalation
    // exists and is wired to the grade, verified by the unit gate below rather than a live drive.
    expect: 'nothing is serving',
  },
  {
    name: 'relaunch-refuses-a-session-with-no-transcript',
    why: 'the failure that looks exactly like success: `--resume` on an id with no transcript opens an EMPTY conversation under that id, with no error anywhere. A restart that lands there is worse than no restart',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    run: (dir) =>
      run(dir, ['--url', 'http://127.0.0.1:59982/', '--relaunch'], {
        // A session id that no transcript backs. Nothing may be opened for it.
        CLAUDE_CODE_SESSION_ID: 'definitely-not-a-real-session-id-0000',
        CLAUDE_PID: String(process.pid),
      }),
    expect: 'nothing is serving',
  },
  {
    name: 'a-bug-of-our-own-is-not-a-stack-trace',
    why: 'setup can have bugs. When it does, the user must get one sentence and a tidy machine — not a TypeError naming a line in our code, with the dev server we started still running behind it',
    build: () => app({ 'package.json': pkg({ dev: 'true' }) }),
    // NODE_OPTIONS injects a throw into the module's own tick: the closest thing to a real internal
    // fault that a test can arrange from outside.
    // Straight at reticle.mjs, not through the launcher: NODE_OPTIONS also applies to the
    // launcher's `node -e` version probe, and breaking that made this scenario measure the Node
    // guard instead of the crash handler.
    run: (dir) => {
      const boom = join(dir, 'boom.cjs');
      // AFTER the module body has run, because that is when its handlers exist — and when a real
      // bug of ours would fire. A fault raised before registration is uncatchable by definition,
      // and pretending otherwise would make this scenario test nothing.
      writeFileSync(
        boom,
        "setTimeout(() => { throw new Error('injected internal fault'); }, 800);\n",
      );
      try {
        return {
          code: 1,
          out: execFileSync(
            process.execPath,
            [
              '--require',
              boom,
              join(HERE, 'reticle.mjs'),
              '--json',
              '--timeout',
              '3',
              '--no-drive',
              '--no-open',
              '--url',
              'http://127.0.0.1:59981/',
            ],
            {
              cwd: dir,
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 60_000,
            },
          ),
        };
      } catch (err) {
        return { code: err.status ?? 'timeout', out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    },
    // One sentence naming what happened, and where the trace went. The harness's own no-stack check
    // does the rest of the work on this scenario.
    expect: 'setup hit a bug of its own',
  },
  {
    name: 'a-failed-run-says-how-to-finish-by-hand',
    why: 'naming a cause is not the same as being recoverable. If setup misbehaves the agent must be able to pick up at the step that failed, not re-read the whole procedure and redo the parts that already worked',
    build: () =>
      app({ 'package.json': pkg({ dev: 'echo "  Local: http://127.0.0.1:59979/"; sleep 20' }) }),
    run: (dir) => run(dir, ['--url', 'http://127.0.0.1:59979/']),
    // It got past init and never connected, so the remaining steps must start at the session gate
    // and must NOT tell it to re-run init, which already succeeded.
    expect: 'reticle_sessions',
  },
];

const selected = SCENARIOS.filter((s) => only === undefined || s.name === only);
const rows = [];

for (const s of selected) {
  const dir = s.build();
  let side;
  try {
    if (s.setup !== undefined) side = await s.setup(dir);
    const { code, out } = await s.run(dir);
    const failures = [];
    if (code === 0) failures.push('exited 0 — a broken machine was reported as a working install');
    if (STACK.test(out) || CRASH.test(out))
      failures.push('leaked a stack trace or a raw runtime error');
    if (!out.includes(s.expect)) failures.push(`never said "${s.expect}"`);
    if (out.includes('"ok": true')) failures.push('json says ok:true');
    rows.push({
      name: s.name,
      ok: failures.length === 0,
      failures,
      out: out.slice(-700),
      why: s.why,
      knownWeakness: s.knownWeakness,
    });
  } finally {
    if (side !== undefined) side.kill();
    s.cleanup?.(dir);
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

for (const r of rows) {
  process.stdout.write(`${r.ok ? '  ✓' : '  ✗'} ${r.name}\n`);
  if (!r.ok) {
    process.stdout.write(`      why it matters: ${r.why}\n`);
    for (const f of r.failures) process.stdout.write(`      ✗ ${f}\n`);
    process.stdout.write(`      ${r.out.replace(/\n/g, '\n      ')}\n`);
  }
}
const bad = rows.filter((r) => !r.ok);
process.stdout.write(`\n${rows.length - bad.length}/${rows.length} hostile environments handled\n`);
process.exit(bad.length > 0 ? 1 : 0);
