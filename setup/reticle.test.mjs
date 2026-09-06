// The smallest thing that reddens if setup's gates break. No framework: `node reticle.test.mjs`.
//
// Every case here is a FAILURE path, on purpose. The success path needs a real app, a dev server and
// a browser — that is what reticle-fixtures is for. What can go wrong here, and silently, is setup
// reporting the WRONG CAUSE: "no session appeared" sends an agent back to re-run init, which is the
// one action that cannot help. So these assert the diagnosis, not just the exit code.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, 'reticle.mjs');
const LAUNCHER = join(HERE, 'reticle.sh');
const LAUNCHER_CMD = join(HERE, 'reticle.cmd');
let fails = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const no = (n, got) => {
  console.log(`  FAIL ${n}\n       ${String(got).slice(0, 400)}`);
  fails += 1;
};
const is = (n, got, want) =>
  got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const check = (n, got, want) => (String(got).includes(want) ? ok(n) : no(n, got));

/** setup exits non-zero on every gate below, so the failure text IS the output under test. */
function runIn(dir, args = [], bin = process.execPath, pre = [SETUP]) {
  try {
    // `--no-open` on EVERY invocation. Without it each failure case calls `reticle open` on a url
    // nothing serves, and running the tests throws real browser windows at whoever ran them. The
    // matrix learned this first; this file is its sibling and needed the same fix, which is the
    // argument for both of them going through one place if a third ever appears.
    return execFileSync(bin, [...pre, '--json', '--timeout', '2', '--no-open', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 90_000,
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

async function waitFor(url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the test's own fake server never came up at ${url}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'reticle-setup-test-'));

check('no package.json stops, and names the path', runIn(tmp), 'no package.json');

writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
check('no dev script stops rather than inventing one', runIn(tmp, []), 'rather than invent');

// --url means the app is already served, so a missing dev script must NOT be fatal here — the gate
// that should fail is the session one. Getting this wrong makes setup useless against a running app.
const dead = runIn(tmp, ['--url', 'http://localhost:59999/']);
check('--url gets past the dev-script gate', dead, '"diagnosis"');
// Nothing listening is a DIFFERENT failure from a page that loads without the SDK, and conflating
// them sends the reader into the install looking for a bug that is not there.
check('nothing listening is named as nothing listening', dead, 'nothing is serving');
check('the result is machine-readable', dead, '"agentTodo"');

// A page that IS served but carries no SDK: the single most common real cause (a dev server whose
// bundle predates init's edit). It must not be reported as "nothing connected".
// In its OWN process: runIn is synchronous, so a server in THIS one could never accept the
// connection — it would report "nothing is serving" and the test would pass for the wrong reason.
const PORT = 59_871;
const fake = spawn(
  process.execPath,
  [
    '-e',
    `require('http').createServer((_,r)=>r.end('<!doctype html><html><body>an app with no SDK</body></html>')).listen(${PORT},'127.0.0.1')`,
  ],
  { stdio: 'ignore' },
);
await waitFor(`http://127.0.0.1:${PORT}/`);
const served = runIn(tmp, ['--url', `http://127.0.0.1:${PORT}/`]);
check('served-without-SDK is diagnosed as such', served, 'SDK is NOT in the page');
check('served-without-SDK records the evidence', served, '"served": true');
fake.kill();

// The launcher is the file people are told to run; if it stops resolving its own directory, every
// documented invocation breaks while `node reticle.mjs` keeps working and nothing notices. One per
// platform, because a stock Windows box has no `sh` and the .sh refuses there by design — so each
// machine checks the launcher it can actually run, and neither is left untested on the platform
// that uses it.
if (process.platform === 'win32') {
  check(
    'reticle.cmd launches reticle.mjs',
    runIn(tmp, [], process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', LAUNCHER_CMD]),
    'no dev/start/serve',
  );
} else {
  check(
    'reticle.sh launches reticle.mjs',
    runIn(tmp, [], '/bin/sh', [LAUNCHER]),
    'no dev/start/serve',
  );
}

rmSync(tmp, { recursive: true, force: true });

// Where saved flows live. In a monorepo `.reticle/` sits at the APP root, not where setup was
// invoked, and looking only in the cwd reported "no verdict" for a run whose drive HAD saved a flow
// and said so — a false negative, which tells the user a successful install failed.
{
  const root = mkdtempSync(join(tmpdir(), 'reticle-flows-'));
  const appDir = join(root, 'apps', 'web');
  mkdirSync(join(appDir, '.reticle', 'flows'), { recursive: true });
  writeFileSync(join(appDir, '.reticle', 'flows', 'projects.json'), '{}');

  // The same rule the script uses: look in BOTH the invocation directory and the app directory.
  const lookIn = (...roots) => {
    const seen = new Set();
    for (const r of roots) {
      try {
        for (const f of readdirSync(join(r, '.reticle', 'flows'))) seen.add(f);
      } catch {
        /* none */
      }
    }
    return [...seen];
  };

  is('a flow saved under the app dir is found', lookIn(root, appDir).length, 1);
  is('looking only where setup was invoked misses it', lookIn(root).length, 0);
  mkdirSync(join(root, '.reticle', 'flows'), { recursive: true });
  writeFileSync(join(root, '.reticle', 'flows', 'projects.json'), '{}');
  is('the same flow in both places is counted once', lookIn(root, appDir).length, 1);
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? 'PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
