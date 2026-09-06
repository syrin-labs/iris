#!/usr/bin/env node
/**
 * Whole MACHINES, not single faults.
 *
 *   node setup/machines.mjs [--only <name>] [--drive] [--keep]
 *
 * break-matrix.mjs breaks one thing at a time, which is how you find a specific bug and not how
 * anybody's laptop actually is. A real machine is a COMBINATION: a path with a space in it, three
 * agents half-installed, a proxy, a locale, a package manager the project names and the machine
 * lacks. Each profile below composes those the way a particular kind of person ends up composing
 * them, and asserts setup does something defensible in that whole context.
 *
 * The assertions are deliberately about the OUTCOME a person gets — connected, or refused with a
 * reason they can act on — never about internals. A machine where setup cannot work is fine. A
 * machine where it fails without saying why is not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * What SHIPS, not the prototype beside it.
 *
 * These profiles were written against setup/reticle.sh, whose runtime phase has since been ported
 * into the CLI as `init`. Pointing them at the launcher measured a superseded entry point: green
 * there says nothing about the command users actually run. break-matrix.mjs made the same move for
 * the same reason, and this file is its companion — it breaks WHOLE MACHINES rather than one fault
 * at a time, so it has to be aimed at the same target or the pair disagree about what is under test.
 */
const CLI = join(HERE, '..', 'packages', 'server', 'dist', 'cli.js');
/**
 * The shell entry point, for the profiles that judge ITS guards rather than the install.
 *
 * `noob` shims `node` to report v16 and expects the version refusal — a guard that lives in the
 * launcher, because a Node too old to parse reticle.mjs never reaches anything inside it. Running
 * that through `process.execPath` is not a weaker test, it is a MEANINGLESS one: execPath is an
 * absolute path, so it ignores the PATH the profile just built and finds a healthy Node every time.
 * break-matrix.mjs keeps two scenarios on the launcher for exactly this reason.
 */
const LAUNCHER = join(HERE, 'reticle.sh');
/** A real, small, never-instrumented app. Scaffolded once and cloned per profile. */
const BASE = '/tmp/aha/app';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const drive = args.includes('--drive');
const keep = args.includes('--keep');

const STACK = /^\s+at .+:\d+:\d+\)?$/m;
const CRASH =
  /(TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+|Cannot read propert|is not a function|is not defined)/;

/** A project directory whose PATH and contents the profile controls. */
function project(dirName, mutate) {
  const root = mkdtempSync(join(tmpdir(), 'machine-'));
  const dir = join(root, dirName);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(BASE, dir, { recursive: true });
  mutate?.(dir);
  return { root, dir };
}

/** A PATH containing only the named tools, each shimmed to the real one. Anything else is absent. */
function pathWith(dir, tools) {
  const bin = join(dir, '.machine-bin');
  mkdirSync(bin, { recursive: true });
  for (const t of tools) {
    const real = spawnSync('sh', ['-c', `command -v ${t} || true`], {
      encoding: 'utf8',
    }).stdout.trim();
    if (real === '') continue;
    writeFileSync(join(bin, t), `#!/bin/sh\nexec ${real} "$@"\n`);
    chmodSync(join(bin, t), 0o755);
  }
  return `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

function run(dir, env, extra = [], viaLauncher = false) {
  // The launcher when the profile is about the launcher's own guards, the shipped CLI otherwise.
  const [file, head] = viaLauncher ? ['/bin/sh', [LAUNCHER]] : [process.execPath, [CLI, 'init']];
  try {
    return {
      code: 0,
      out: execFileSync(
        file,
        [
          ...head,
          '--json',
          '--timeout',
          '25',
          '--no-open',
          ...(drive ? [] : ['--no-drive']),
          ...extra,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 240_000,
          env: { ...process.env, ...env },
        },
      ),
    };
  } catch (err) {
    return { code: err.status ?? 'timeout', out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const MACHINES = [
  {
    name: 'professional',
    who: 'senior engineer: pnpm workspace, several agents installed, strict setup, everything present. The case that must simply work — if setup needs hand-holding here it needs it everywhere.',
    build: () =>
      project('work/acme-platform', (dir) => {
        writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
        rmSync(join(dir, 'package-lock.json'), { force: true });
      }),
    env: (dir) => ({ PATH: pathWith(dir, ['node', 'npx', 'pnpm', 'npm', 'claude', 'git']) }),
    // pnpm named by the lockfile and present: it must be used, and the run must reach the app.
    // `packageManager` was a field of the PROTOTYPE's json and the CLI has no equivalent, so the
    // claim has to be made from what `init --json` can actually show: it got past install and boot
    // to the connect gate. On this machine — everything present, pnpm named and installed — an
    // install that chose a manager it could not run never reaches that phase at all.
    expect: (out) => /"reachedPhase":\s*"(connect|drive|done)"/.test(out),
  },
  {
    name: 'vibe-coder',
    who: 'Cursor user who scaffolded an app and never ran git init. Path has a SPACE in it, because it lives in ~/Desktop/My Projects — the single most common thing an install script gets wrong.',
    build: () =>
      project('Desktop/My Projects/side quest', (dir) =>
        rmSync(join(dir, '.gitignore'), { force: true }),
      ),
    env: (dir) => ({ PATH: pathWith(dir, ['node', 'npx', 'npm', 'git']) }),
    // The whole point: a space in the path must not corrupt any command setup builds.
    expect: (out) => out.includes('My Projects') && !/not a directory|No such file/i.test(out),
  },
  {
    name: 'noob',
    // The launcher's OWN Node-version guard — see LAUNCHER. Through the CLI this cannot fail.
    launcher: true,
    who: 'first week: Node 16 from a tutorial, no pnpm, no agent CLI, project on the Desktop. Nothing here can produce a verdict, so the only acceptable outcome is a refusal naming what to fix.',
    build: () => project('Desktop/my-first-app'),
    env: (dir) => ({
      PATH: (() => {
        const p = pathWith(dir, ['npx', 'npm', 'git']);
        const bin = join(dir, '.machine-bin');
        const realNode = spawnSync('sh', ['-c', 'command -v node'], {
          encoding: 'utf8',
        }).stdout.trim();
        // Reports v16 and fails the version probe, exactly as a real old Node does.
        writeFileSync(
          join(bin, 'node'),
          `#!/bin/sh\ncase "$1" in\n  -v|--version) echo v16.20.2; exit 0 ;;\n  -e) exit 1 ;;\nesac\nexec ${realNode} "$@"\n`,
        );
        chmodSync(join(bin, 'node'), 0o755);
        return p;
      })(),
    }),
    expect: (out) => out.includes('Node 18'),
  },
  {
    name: 'locked-down-corp',
    who: 'corporate laptop: an npm proxy that refuses, a private registry, no reachable npmjs. Setup never gets its own CLI, and must say THAT rather than something about the app.',
    build: () => project('src/checkout-ui'),
    env: (dir) => ({
      PATH: pathWith(dir, ['node', 'npx', 'npm', 'git']),
      npm_config_registry: 'http://127.0.0.1:59790/',
      npm_config_proxy: 'http://127.0.0.1:59791/',
      npm_config_fetch_retries: '0',
    }),
    expect: (out) => out.includes('registry'),
  },
  {
    name: 'non-english-locale',
    who: 'a machine running in French. Dev servers and tools localise their output, and anything that parses English prose quietly stops working — so setup must not depend on the words, only on the port answering.',
    build: () => project('projets/mon-app'),
    env: (dir) => ({
      PATH: pathWith(dir, ['node', 'npx', 'npm', 'git']),
      LANG: 'fr_FR.UTF-8',
      LC_ALL: 'fr_FR.UTF-8',
    }),
    expect: (out) => !CRASH.test(out),
  },
  {
    name: 'icloud-synced-unicode-path',
    who: 'a designer-developer whose project lives in an iCloud folder with a unicode name and spaces. Path handling and a filesystem that can lag are both in play.',
    build: () =>
      project('Library/Mobile Documents/com~apple~CloudDocs/Café Projets/tableau de bord'),
    env: (dir) => ({ PATH: pathWith(dir, ['node', 'npx', 'npm', 'git']) }),
    expect: (out) => !CRASH.test(out) && !/ENOENT.*Caf/i.test(out),
  },
];

const selected = MACHINES.filter((m) => only === undefined || m.name === only);
if (!existsSync(BASE))
  throw new Error(`no base app at ${BASE} — scaffold one with \`npm create vite\` first`);

const rows = [];
for (const m of selected) {
  const { root, dir } = m.build();
  let out = '';
  let code;
  try {
    ({ out, code } = run(dir, m.env(dir), [], true === m.launcher));
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
  const failures = [];
  if (STACK.test(out) || CRASH.test(out))
    failures.push('leaked a stack trace or raw runtime error');
  if (!m.expect(out)) failures.push('did not do the thing this machine is about');
  // Every machine must end with something a person can act on, whether it worked or not.
  //
  // The shape is the CLI's SetupOutcome, not the prototype's: `agentTodo` was reticle.mjs's field and
  // does not exist in `init --json`, which answers { ok, reachedPhase, notes, fallback, ... }. A
  // machine that could not work is a fine outcome; one that ends with no object, or an object naming
  // nothing to do, is not — that is the failure this whole file exists to catch.
  // Two entry points, two object shapes: the launcher's reticle.mjs answers `agentTodo`, and the
  // CLI answers SetupOutcome { ok, reachedPhase, notes, fallback }. Requiring the CLI's shape of a
  // launcher profile failed `noob` for having done exactly the right thing.
  const hasOutcome = /"ok":\s*(true|false)/.test(out) || out.includes('"agentTodo"');
  const saysWhatNext =
    out.includes('"ok": true') ||
    out.includes('"agentTodo"') ||
    /"(fallback|notes)":\s*\[\s*"/.test(out);
  if (!hasOutcome || !saysWhatNext) failures.push('produced no machine-readable result at all');
  rows.push({
    name: m.name,
    ok: failures.length === 0,
    failures,
    who: m.who,
    out: out.slice(-700),
  });
}

for (const r of rows) {
  process.stdout.write(`${r.ok ? '  ✓' : '  ✗'} ${r.name}\n`);
  if (!r.ok) {
    process.stdout.write(`      ${r.who}\n`);
    for (const f of r.failures) process.stdout.write(`      ✗ ${f}\n`);
    process.stdout.write(`      ${r.out.replace(/\n/g, '\n      ')}\n`);
  }
}
const bad = rows.filter((r) => !r.ok);
process.stdout.write(`\n${rows.length - bad.length}/${rows.length} machines handled\n`);
process.exit(bad.length > 0 ? 1 : 0);
