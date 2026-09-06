import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { FEEDBACK_HINT } from './closing-hint.js';
import { runInit, resolveLockfiles, type InitIo, type InitOptions } from './run.js';

// init now mints the pairing token; keep it out of the real ~/.reticle during tests.
const pairingDir = mkdtempSync(join(tmpdir(), 'reticle-init-token-'));
const savedTokenDir = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
process.env[ReticleEnv.PAIRING_TOKEN_DIR] = pairingDir;
afterAll(() => {
  if (savedTokenDir === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = savedTokenDir;
});

interface MemoryIo extends InitIo {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

const HOME = '/home/u';

interface MemoryOpts {
  execOk?: boolean;
  claudeAvailable?: boolean;
  mcpExists?: boolean;
  cursor?: boolean;
}

interface Sinks {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

function memoryIo(
  files: Record<string, string>,
  opts: MemoryOpts = {},
  prefix = '',
  // A workspace redirect re-roots the IO but must keep reporting into the SAME sinks, or a test can
  // see the redirect happen and none of what it did.
  sinks: Sinks = { written: {}, lines: [], execCalls: [] },
): MemoryIo {
  const { execOk = true, claudeAvailable = true, mcpExists = false, cursor = false } = opts;
  const { written, lines, execCalls } = sinks;
  // Simulate the Cursor config dir existing when requested.
  const present = { ...files };
  if (cursor) present[`${HOME}/.cursor`] = '';
  // Absolute paths (home-dir config) bypass the scoping prefix, matching the real IO.
  /**
   * Normalise separators before keying.
   *
   * Production is right to use `join()` — a path that is checked and written on a user's machine
   * must use that platform's separator, and this repo has already shipped a Windows path bug for
   * exactly the opposite reason. But `join()` yields backslashes there, while these fixtures are
   * written with forward slashes, so on Windows a lookup missed and the Cursor step silently never
   * ran. The test was the thing that was not portable, on a platform a large share of users are on.
   */
  const norm = (p: string): string => p.replace(/\\/g, '/');
  /**
   * Absolute on EITHER platform, tested after normalising the separators.
   *
   * `p.startsWith('/')` is a POSIX-only question, and production reaches this through `join()`,
   * which yields `\app\CLAUDE.md` on Windows. That is absolute and did not look it, so the harness
   * prefixed it with the scoped app root and produced `src/admin//app/CLAUDE.md`: two tests failed on
   * Windows only, about paths production gets right. Same shape as the `norm` fix above, on the
   * platform that is most of our users, and the second time this harness has been the thing that was
   * not portable.
   */
  const isAbsolute = (p: string): boolean => /^([A-Za-z]:)?\//.test(norm(p));
  const key = (p: string): string =>
    // `.` is the scope's own root — the real IO resolves it with `join(cwd, '.')`, which is `cwd`.
    // Keying it as `<prefix>/.` instead made every top-level scan inside a redirected app come back
    // empty, so the harness could not express a nested app's directory tree at all.
    '.' === p
      ? '' === prefix
        ? '.'
        : prefix
      : norm(isAbsolute(p) || '' === prefix ? p : `${prefix}/${p}`);
  return {
    written,
    lines,
    execCalls,
    readFile: (p) => present[key(p)] ?? written[key(p)] ?? null,
    writeFile: (p, c) => {
      written[key(p)] = c;
    },
    exists: (p) => key(p) in present || key(p) in written,
    // The in-memory project is always writable; preflight has its own tests for when it is not.
    canWrite: () => true,
    homeDir: () => HOME,
    cwd: () => '/project',
    rootFiles: () => {
      const scope = '' === prefix ? '' : `${prefix}/`;
      return Object.keys(files)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length))
        .filter((p) => p !== '' && !p.includes('/'));
    },
    listDirs: (rel) => {
      // `.` means the root, and the real IO resolves it that way. Without this the harness could not
      // express "an app one directory down from a root with no package.json" at all — every
      // top-level scan came back empty, which is part of why that case shipped unnoticed.
      const base = key(rel);
      const scope = '.' === base ? '' : `${base}/`;
      const names = Object.keys(present)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length).split('/')[0] ?? '')
        .filter((n) => n !== '');
      return [...new Set(names)];
    },
    listFiles: (rel) => {
      const scope = `${key(rel)}/`;
      return Object.keys(present)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length))
        .filter((n) => n !== '' && !n.includes('/'));
    },
    scoped: (rel) => memoryIo(files, opts, key(rel), sinks),
    exec: (command, args) => {
      execCalls.push({ command, args });
      return execOk;
    },
    probe: (_command, args) => (args.includes('get') ? mcpExists : claudeAvailable),
    print: (l) => lines.push(l),
  };
}

describe('resolveLockfiles — package-manager detection in a monorepo', () => {
  it('walks up to the workspace-root lockfile when the sub-package has none', () => {
    // Normalised, for the reason the memory io above is: resolveLockfiles walks with `join`, which
    // yields backslashes on Windows, and a literal POSIX comparison never matches there — so the
    // walk "failed" on a platform a large share of users are on, while passing everywhere else.
    const io = { exists: (p: string) => '/repo/pnpm-lock.yaml' === p.replace(/\\/g, '/') };
    const set = resolveLockfiles(
      new Set(['package.json', 'vite.config.ts']),
      '/repo/apps/bench-app',
      io,
    );
    expect(set.has('pnpm-lock.yaml')).toBe(true);
  });

  it('a local lockfile wins and short-circuits the walk', () => {
    const io = {
      exists: (): boolean => {
        throw new Error('should not walk when a local lockfile exists');
      },
    };
    const set = resolveLockfiles(new Set(['package-lock.json']), '/x/y', io);
    expect(set.has('package-lock.json')).toBe(true);
  });

  it('falls back to just the root files when no lockfile exists anywhere', () => {
    const io = { exists: (): boolean => false };
    const set = resolveLockfiles(new Set(['package.json']), '/x/y', io);
    expect([...set]).toEqual(['package.json']);
  });

  /**
   * Reported from the field: `init` in a `frontend/` app whose deps were installed with npm emitted
   * `pnpm add -D ...` — because an ancestor `pnpm-lock.yaml` outranked the npm tree sitting right
   * there. pnpm was not even on PATH, so the install step died and every downstream wiring step was
   * skipped with it. `detectPackageManager`'s own docblock says an installed tree is the strongest
   * evidence there is; the walk-up was quietly overruling it.
   */
  it('does not inherit an ancestor lockfile when the project has its own installed tree', () => {
    const io = { exists: (p: string) => '/repo/pnpm-lock.yaml' === p.replace(/\\/g, '/') };
    const set = resolveLockfiles(
      new Set(['package.json']),
      '/repo/frontend',
      io,
      new Set(['.package-lock.json']),
    );
    expect(set.has('pnpm-lock.yaml')).toBe(false);
  });

  it('still walks up when the sub-package has no installed tree of its own', () => {
    const io = { exists: (p: string) => '/repo/pnpm-lock.yaml' === p.replace(/\\/g, '/') };
    const set = resolveLockfiles(new Set(['package.json']), '/repo/frontend', io, new Set());
    expect(set.has('pnpm-lock.yaml')).toBe(true);
  });

  it('a LOCAL lockfile still beats the local installed tree', () => {
    const io = { exists: (): boolean => false };
    const set = resolveLockfiles(
      new Set(['pnpm-lock.yaml']),
      '/repo/frontend',
      io,
      new Set(['.package-lock.json']),
    );
    expect(set.has('pnpm-lock.yaml')).toBe(true);
  });
});

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: true,
  dryRun: false,
  install: false,
};

const VITE_FILES = {
  'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^19' } }),
  'vite.config.ts': `export default { plugins: [] };\n`,
};

describe('runInit', () => {
  it('errors cleanly when there is no package.json AND no app beneath it', () => {
    const io = memoryIo({ 'docs/readme.md': 'hi' });
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('No package.json');
  });

  it('hands a non-JS project the script-tag snippet, not just a diagnosis', () => {
    // This exit is where every server-rendered app lands: FastAPI, Flask, Django, Rails, Streamlit.
    // It used to end at an explanation, and readers acted on the explanation as a refusal. The
    // message now says "add the snippet below", so the snippet has to actually be below it, and it
    // has to be a URL import: a bare specifier is the one thing a plain page cannot resolve.
    const io = memoryIo({ 'requirements.txt': 'fastapi\n', 'app.py': 'x' });
    const out = (() => {
      runInit(OPTS, io);
      return io.lines.join('\n');
    })();
    expect(out).toContain('script type="module"');
    expect(out).toMatch(/import \{ reticle \} from 'https:\/\//);
    expect(out).toContain('reticle.connect(');
    expect(out).not.toMatch(/from '@reticlehq\/\w+'/);
  });

  it('hands a Streamlit app its executable HTML helper', () => {
    const io = memoryIo({
      'requirements.txt': 'streamlit==1.63.0\n',
      'app.py': 'import streamlit as st\n',
    });
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    expect(out).toContain('st.html');
    expect(out).toContain('unsafe_allow_javascript=True');
    expect(out).toContain("marker.id = 'reticle-streamlit-connect'");
    expect(out).toContain("import('https://");
    expect(out).toContain('reticle.connect(');
    expect(out).not.toMatch(/paste this into the page|script-tag snippet below/i);
  });

  it('mints a pairing token into that snippet when none exists yet', () => {
    // The CDN path has no build step. An empty token here is a page that can never authenticate,
    // and regenerating the file later makes the pasted literal stale as well as wrong.
    const io = memoryIo({ 'requirements.txt': 'fastapi\n', 'app.py': 'x' });
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    const token = readFileSync(join(pairingDir, ReticleDir.PAIRING_TOKEN_FILE), 'utf8').trim();
    expect(token.length).toBeGreaterThan(0);
    expect(out).toContain(token);
    expect(out).toMatch(/token:\s*'[0-9a-f]+'/);
  });

  /**
   * A repo whose app is one directory down with nothing at the top — `frontend/`, `web/`, `client/`
   * — is an ordinary shape, and it was un-instrumentable. init read the root package.json, found
   * none, and bailed BEFORE discovery ever ran, so `--app frontend` (the flag that exists for
   * exactly this) was never read either. Reported twice by the same user: once for the failure, once
   * for the documented workaround failing the same way.
   *
   * Discovery already handled it — it scans top-level directories, not only declared workspaces. It
   * was simply unreachable behind the bail.
   */
  it('finds an app one directory down even when the root has no package.json', () => {
    const io = memoryIo({
      'frontend/package.json': JSON.stringify({ dependencies: { next: '16', react: '^19' } }),
      'frontend/app/layout.tsx':
        'export default function L({ children }) {\n' +
        '  return (<html><body>{children}</body></html>);\n' +
        '}\n',
    });
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.lines.join('\n')).toContain('frontend');
    expect(io.written['frontend/.reticle.json']).toBeDefined();
  });

  /**
   * Reported from the field: `init` printed `[✓] Reticle config → .reticle.json` and the user then
   * could not find the file. It did not reproduce — the write throws on failure and nothing catches
   * it — and the likeliest explanation is that they were looking in the wrong directory.
   *
   * Every path in the report is printed RELATIVE (`.reticle.json`, `app/layout.tsx`) and the header
   * says only `reticle init`. Run from a repo root against an app in `frontend/`, the redirect
   * re-roots every write and the report still reads `.reticle.json` — which is true, and is not the
   * `.reticle.json` the user is standing next to. The redirect does announce itself, so this is not
   * a silent move; it is that the report never states the ground its paths are relative to.
   *
   * One line in the header makes every path in the report unambiguous at once.
   */
  it('names the directory its relative paths are relative to', () => {
    const io = memoryIo(VITE_FILES);
    runInit(OPTS, io);
    expect(io.lines.join('\n'), 'the report never says which directory it wrote into').toContain(
      OPTS.cwd,
    );
  });

  it('and names the REDIRECTED directory when the app is one level down', () => {
    const io = memoryIo({
      'frontend/package.json': JSON.stringify({ dependencies: { next: '16', react: '^19' } }),
      'frontend/app/layout.tsx':
        'export default function L({ children }) {\n' +
        '  return (<html><body>{children}</body></html>);\n' +
        '}\n',
    });
    runInit(OPTS, io);
    // Normalised for the reason this file's own harness is: the redirect builds the path with
    // `join()`, which yields backslashes on Windows, so a literal POSIX comparison passes
    // everywhere and fails on the platform that is two thirds of our users. CI caught exactly that
    // on the first version of this test.
    const printed = io.lines.join('\n').replace(/\\/g, '/');
    expect(printed).toContain('frontend');
    expect(
      printed,
      'after a redirect the paths are relative to the APP, not to where the user ran the command',
    ).toContain('/app/frontend');
  });

  /**
   * The redirect announces itself in the report, and until now told the CALLER nothing at all: the
   * inner run returned an InitResult identical to one that never redirected. That was harmless
   * while init only wrote files, because nothing downstream existed. A caller that goes on to boot
   * the app has to know which directory was actually wired, and re-deriving it is how two halves of
   * one command end up disagreeing about where they are.
   */
  it('tells the caller which directory it actually wired, after a redirect', () => {
    const io = memoryIo({
      'frontend/package.json': JSON.stringify({
        dependencies: { next: '16', react: '^19' },
        scripts: { dev: 'next dev' },
      }),
      'frontend/app/layout.tsx':
        'export default function L({ children }) {\n' +
        '  return (<html><body>{children}</body></html>);\n' +
        '}\n',
    });
    const r = runInit(OPTS, io);
    const appDir = (r.context?.appDir ?? '').replace(/\\/g, '/');
    expect(appDir, 'the caller cannot see where the redirect landed').toContain('frontend');
    expect(r.context?.redirectedTo, 'a redirect is invisible to the caller').toBeDefined();
  });

  it('reports the dev command it found, so a caller need not guess one', () => {
    const io = memoryIo({
      ...VITE_FILES,
      'package.json': JSON.stringify({
        dependencies: { vite: '^5', react: '^19' },
        scripts: { dev: 'vite --port 5199' },
      }),
    });
    const r = runInit(OPTS, io);
    expect(r.context?.devCommand).toContain('dev');
    // Never composed: a guessed command produces an error about a missing script, and the reader
    // concludes their app is broken rather than that we were wrong.
    expect(r.context?.packageManager).toBeTruthy();
  });

  it('honours --app when the root has no package.json', () => {
    const io = memoryIo({
      'frontend/package.json': JSON.stringify({ dependencies: { next: '16', react: '^19' } }),
      'frontend/app/layout.tsx':
        'export default function L({ children }) {\n' +
        '  return (<html><body>{children}</body></html>);\n' +
        '}\n',
      'backend/package.json': JSON.stringify({ dependencies: { express: '^4' } }),
    });
    const r = runInit({ ...OPTS, app: 'frontend' }, io);
    expect(r.ok).toBe(true);
    expect(io.written['frontend/.reticle.json']).toBeDefined();
    expect(io.written['backend/.reticle.json']).toBeUndefined();
  });

  it('registers reticle globally via the claude CLI (not a project .mcp.json) and patches vite', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.written['.mcp.json']).toBeUndefined();
    expect(io.execCalls.some((c) => 'claude' === c.command && c.args.includes('add'))).toBe(true);
    expect(io.written['vite.config.ts']).toContain('@reticlehq/vite-plugin');
  });

  it('does not re-register when an reticle server already exists (idempotent, install-once)', () => {
    const io = memoryIo(VITE_FILES, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => 'claude' === c.command)).toBe(false);
  });

  it('prints manual global instructions when no agent is detected', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: false });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => 'claude' === c.command && c.args.includes('add'))).toBe(false);
    expect(io.lines.join('\n')).toContain('-s user');
  });

  it('registers in Cursor global config when Cursor is present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: true });
    runInit(OPTS, io);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/server');
  });

  it('registers with BOTH Claude and Cursor when both are present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true, cursor: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => 'claude' === c.command && c.args.includes('add'))).toBe(true);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/server');
  });

  it('dry run writes nothing and runs no subprocess', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit({ ...OPTS, dryRun: true }, io);
    expect(Object.keys(io.written)).toHaveLength(0);
    expect(io.execCalls).toHaveLength(0);
    expect(io.lines.join('\n')).toContain('dry run');
    expect(r.applied).toBeGreaterThan(0);
  });

  it('asks for feedback on EVERY exit, including the ones that never reach the report', () => {
    // This shipped as dead code: the print sat after a `return` in report(), so the whole standing
    // ask was unreachable and nothing failed — no test named it, and a missing line prints nothing.
    // The exits below are the ones that matter most: setup died before anything ran, and the person
    // holding the report has no MCP tools to file it with.
    const ok = memoryIo(VITE_FILES);
    runInit(OPTS, ok);
    expect(ok.lines.join('\n')).toContain(FEEDBACK_HINT);

    const dry = memoryIo(VITE_FILES);
    runInit({ ...OPTS, dryRun: true }, dry);
    expect(dry.lines.join('\n')).toContain(FEEDBACK_HINT);

    const noPkg = memoryIo({});
    runInit(OPTS, noPkg);
    expect(noPkg.lines.join('\n')).toContain(FEEDBACK_HINT);
  });

  it('runs the install when enabled, pinned to the CLI version', () => {
    const io = memoryIo({ ...VITE_FILES, 'pnpm-lock.yaml': '' }, { mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.execCalls).toHaveLength(1);
    const call = io.execCalls[0];
    expect(call?.command).toBe('pnpm');
    expect(call?.args.slice(0, 2)).toEqual(['add', '-D']);
    // Pinned: a stale registry cache once handed pnpm 2.2.1 while npm took 2.3.0 in the next
    // project, and a version-skewed SDK against a newer daemon is the -32000 path.
    expect(call?.args[2]).toMatch(/^@reticlehq\/react@\d+\.\d+\.\d+/);
    expect(call?.args[3]).toMatch(/^@reticlehq\/vite-plugin@\d+\.\d+\.\d+/);
  });

  it('downgrades a failed step to manual with its fallback command', () => {
    const io = memoryIo(VITE_FILES, { execOk: false, mcpExists: true });
    const r = runInit({ ...OPTS, install: true }, io);
    expect(io.lines.join('\n')).toContain('step failed — run manually');
    expect(r.manual).toBeGreaterThan(0);
  });

  it('creates the connect component for a Next project, matching the project language', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
    });
    runInit(OPTS, io);
    // No tsconfig ⇒ a JavaScript project. A stray .tsx here makes Next auto-install TypeScript on
    // the next `next dev`, which on Next 13 takes its require-hook down and the server never starts.
    expect(io.written['app/reticle-dev.jsx']).toContain('ReticleDev');
    expect(io.written['app/reticle-dev.tsx']).toBeUndefined();
  });

  it('writes a .js connect module for a JavaScript CRA app (#675)', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({
        dependencies: { 'react-scripts': '5.0.1', react: '^18', 'react-dom': '^18' },
      }),
      'src/index.js': "import React from 'react';\nimport App from './App';\n",
    });
    runInit(OPTS, io);
    expect(io.written['src/reticle-dev.js']).toContain('reticle.connect');
    expect(io.written['src/reticle-dev.js']).not.toContain('export {}');
    expect(io.written['src/reticle-dev.ts']).toBeUndefined();
    expect(io.written['src/index.js']).toContain("import './reticle-dev'");
  });

  it('uses .tsx once the project has a tsconfig', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
      'tsconfig.json': '{}',
    });
    runInit(OPTS, io);
    expect(io.written['app/reticle-dev.tsx']).toContain('ReticleDev');
  });

  /**
   * Every file under `pages/` is a route. Writing the component there gave the app a route with no
   * default export — `/reticle-dev` 500s and `next build` fails — on top of the TypeScript problem.
   * Installing Reticle stopped the app booting, which is the worst outcome an installer can have.
   */
  it('keeps the Pages Router component out of pages/, and imports it from where it landed', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '13', react: '^18' } }),
      'next.config.js': 'module.exports = {};\n',
      'pages/_app.js':
        'export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n',
    });
    runInit(OPTS, io);
    expect(io.written['components/reticle-dev.jsx']).toContain('ReticleDev');
    expect(io.written['pages/reticle-dev.tsx']).toBeUndefined();
    expect(io.written['pages/reticle-dev.jsx']).toBeUndefined();
    expect(io.written['pages/_app.js']).toContain("from '../components/reticle-dev'");
  });

  it('creates src/hooks.client.ts for a SvelteKit project AND patches vite.config', () => {
    // Both halves, and they do different jobs. The client hook is what registers a session, because
    // SvelteKit renders through app.html so the plugin's HTML injection never fires. The plugin is
    // what stamps data-reticle-source into .svelte components — `init` has always installed
    // @reticlehq/vite-plugin for SvelteKit and used to leave it unwired, so it sat in package.json
    // doing nothing and every verdict on a SvelteKit app came back with no file:line.
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2', vite: '^5' } }),
      'svelte.config.js': 'export default {};\n',
      'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`,
    });
    runInit(OPTS, io);
    expect(io.written['src/hooks.client.ts']).toContain('reticle.connect(');
    expect(io.written['src/hooks.client.ts']).toContain('app.html'); // explains why the hook exists
    // Without the token the bridge answers "authentication failed" and no session ever appears —
    // the same silent no-connect Next.js shipped. The plugin inlines it as a define.
    expect(io.written['src/hooks.client.ts']).toContain('__RETICLE_TOKEN__');
    expect(io.written['vite.config.ts']).toContain('reticle(');
    expect(io.written['vite.config.ts']).toContain('sveltekit()'); // the app's own plugin survives
  });
});

/**
 * Running `reticle init` at the repo root is what people actually do. In a monorepo that used to
 * detect "no framework", print a wall of manual HTML instructions, and install the SDK into the ROOT
 * package.json — for the most common real-world layout there is.
 */
describe('runInit — workspace roots', () => {
  const WORKSPACE_ROOT = JSON.stringify({ name: 'mono', workspaces: ['apps/*'] });
  const VITE_APP = {
    'apps/web/package.json': JSON.stringify({ dependencies: { react: '^19', vite: '^7' } }),
    'apps/web/vite.config.ts': `import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n`,
  };

  it('wires the single app under apps/ instead of the root', () => {
    const io = memoryIo({ 'package.json': WORKSPACE_ROOT, ...VITE_APP });
    runInit(OPTS, io);
    expect(io.lines.join('\n')).toContain('apps/web');
    expect(io.written['apps/web/vite.config.ts']).toContain('reticle(');
    expect(io.written['apps/web/.reticle.json']).toBeDefined();
    // The root is not the app — nothing of the app's WIRING belongs there. `.reticle.json` is not
    // wiring: it is runtime config the CLI and `reticle mcp` read from their own CWD, which is the
    // root, so it is written in both places (see the agent-root test below).
    expect(io.written['vite.config.ts']).toBeUndefined();
    expect(io.written['/app/.reticle.json']).toBeDefined();
  });

  // A monorepo ROOT that carries shared tooling looks like an app to `detect` — `vite` in its
  // devDependencies is the ordinary shape of one. The redirect used to give up on exactly that
  // signal, BEFORE reading `--app`, so the one flag documented for this layout was ignored: measured
  // on a real pnpm+turbo Tauri app, `init --app packages/player` installed the SDK into the root's
  // package.json, wrote a whole `src/reticle-dev.ts` into a repository root that has no `src/`, left
  // the app untouched, and reported three ✓ and one ⚠.
  it('honours --app even when the invocation directory itself looks like an app', () => {
    const io = memoryIo({
      // Root with shared tooling: a framework dependency, and no app of its own.
      'package.json': JSON.stringify({ name: 'mono', devDependencies: { vite: '^7' } }),
      ...VITE_APP,
    });
    runInit({ ...OPTS, app: 'apps/web' }, io);
    expect(io.written['apps/web/vite.config.ts']).toContain('reticle(');
    expect(io.written['apps/web/.reticle.json']).toBeDefined();
    // The root gets runtime config and NOTHING else — no wiring, and no invented src/ tree.
    expect(io.written['vite.config.ts']).toBeUndefined();
    expect(io.written['src/reticle-dev.ts']).toBeUndefined();
  });

  it('says so when --app names a directory that is not there', () => {
    const io = memoryIo({ 'package.json': JSON.stringify({ devDependencies: { vite: '^7' } }) });
    const r = runInit({ ...OPTS, app: 'apps/nope' }, io);
    expect(r.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('--app apps/nope');
  });

  it('asks for feedback exactly once, even though the redirect re-enters init', () => {
    const io = memoryIo({ 'package.json': WORKSPACE_ROOT, ...VITE_APP });
    runInit(OPTS, io);
    expect(io.lines.filter((l) => l.includes(FEEDBACK_HINT))).toHaveLength(1);
  });

  it('lists the candidates instead of guessing when a workspace has several apps', () => {
    const io = memoryIo({
      'package.json': WORKSPACE_ROOT,
      ...VITE_APP,
      'apps/admin/package.json': JSON.stringify({ dependencies: { next: '16' } }),
    });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(false);
    const out = io.lines.join('\n');
    expect(out).toContain('apps/web');
    expect(out).toContain('apps/admin');
    expect(io.written['apps/web/.reticle.json']).toBeUndefined();
  });

  it('leaves a plain app directory alone — no redirect when this IS the app', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { vite: '^7' } }),
      'vite.config.ts': 'export default { plugins: [] };\n',
      ...VITE_APP, // a nested apps/ dir must not hijack a root that is itself an app
    });
    runInit(OPTS, io);
    expect(io.written['vite.config.ts']).toContain('reticle(');
    expect(io.written['apps/web/vite.config.ts']).toBeUndefined();
  });

  it('still falls through to the manual HTML plan when nothing app-like is anywhere', () => {
    const io = memoryIo({ 'package.json': JSON.stringify({ dependencies: {} }) });
    const result = runInit(OPTS, io);
    // The config IS written and everything automatable happened...
    expect(io.written['.reticle.json']).toBeDefined();
    // ...but the connect step is manual, so nothing will dial the daemon and this run did NOT leave a
    // working install. `ok` used to be hardcoded true, which made the ⚠ count and "did it connect"
    // read as independent signals when one implies the other.
    expect(result.ok).toBe(false);
    expect(result.manual).toBeGreaterThan(0);
  });

  /**
   * `ok` drives the CLI's exit code, and CI reads it. A ⚠ that is not the CONNECT step — an MCP
   * registration the agent's own CLI refused, say — leaves an app that boots, connects and verifies;
   * exiting non-zero on it reports a working install as a failed one, which is enough to make a
   * release gate unrunnable and keep it from ever being run.
   */
  it('a manual step that is NOT the connect step still exits successfully', () => {
    const io = memoryIo(VITE_FILES, { execOk: false });
    const result = runInit(OPTS, io);
    expect(result.manual).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });
});

/**
 * Installing Reticle must never be the reason an app stops booting.
 *
 * When `pnpm add` refused a version (its minimumReleaseAge held the release back), `init` carried on
 * and patched `next.config.ts` to import a `@reticlehq/next` that was never installed. The dev
 * server then died with MODULE_NOT_FOUND — the app was fine until Reticle touched it.
 */
describe('runInit — a failed install must not leave the app half-wired', () => {
  const NEXT_FILES = {
    'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
    'next.config.mjs': 'const nextConfig = {};\nexport default nextConfig;\n',
    'app/layout.tsx':
      'export default function L({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
  };

  it('does not patch the config to import a package the install failed to provide', () => {
    const io = memoryIo(NEXT_FILES, { execOk: false, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['next.config.mjs']).toBeUndefined();
    expect(io.written['app/layout.tsx']).toBeUndefined();
    expect(io.written['app/reticle-dev.jsx']).toBeUndefined();
    // ...and says why, rather than leaving the user to work it out from a MODULE_NOT_FOUND.
    expect(io.lines.join('\n')).toContain('stops it booting');
  });

  it('still wires everything when the install succeeds', () => {
    const io = memoryIo(NEXT_FILES, { execOk: true, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['next.config.mjs']).toContain('withReticle');
    expect(io.written['app/layout.tsx']).toContain('ReticleDev');
  });

  /**
   * The reported loop, from a Next 16 app: init's install fails (it chose pnpm, not on PATH), init
   * tells the user to install by hand, they run `npm install --save-dev` successfully, they re-run
   * init — and the install fails the same way, so every wiring step is skipped a SECOND time. They
   * are left with an init that cannot be retried into working while holding the very packages it
   * reports as missing.
   *
   * The guard above is right; its condition was not. It protects "the import RESOLVES", and it was
   * asking "did our subprocess exit 0".
   */
  it('wires the app when the install fails but the packages are already on disk', () => {
    const io = memoryIo(
      {
        ...NEXT_FILES,
        // What a successful `npm install --save-dev @reticlehq/react @reticlehq/next` leaves.
        'node_modules/@reticlehq/react/package.json': '{"name":"@reticlehq/react"}',
        'node_modules/@reticlehq/next/package.json': '{"name":"@reticlehq/next"}',
      },
      { execOk: false, mcpExists: true },
    );
    runInit({ ...OPTS, install: true }, io);
    // The wiring is precisely what a user cannot do by hand, and precisely what was being skipped.
    expect(io.written['next.config.mjs']).toContain('withReticle');
    expect(io.written['app/layout.tsx']).toContain('ReticleDev');
  });

  it('skips the wiring when only SOME of the packages are there', () => {
    // Half an install is not an install: importing @reticlehq/next when only the kit landed is the
    // same MODULE_NOT_FOUND the guard exists to prevent.
    const io = memoryIo(
      {
        ...NEXT_FILES,
        'node_modules/@reticlehq/react/package.json': '{"name":"@reticlehq/react"}',
      },
      { execOk: false, mcpExists: true },
    );
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['next.config.mjs']).toBeUndefined();
    // The install step itself is still correctly reported as failed here — only some of the
    // packages resolved, so this is the genuine failure the guard exists to catch (#683).
    const report = io.lines.join('\n');
    expect(report).toContain('[⚠] Install dependencies');
    expect(report).toContain('step failed');
  });

  /**
   * Reported alongside #683: a pnpm checkout whose node_modules is symlinked into another
   * checkout's `.pnpm` store (a git worktree, or an A/B harness) makes `pnpm add` exit non-zero
   * with ERR_PNPM_UNEXPECTED_VIRTUAL_STORE even though the packages resolve. The wiring guard
   * above already protects the FILES it writes from this false failure — but the install step's
   * own printed status did not, so a correct install still read as `[⚠] Install dependencies —
   * step failed`, and a second `init` run repeated the false failure forever because nothing
   * about a re-run makes the exec command succeed.
   */
  it('reports the install step as done, not failed, when the packages already resolve', () => {
    const io = memoryIo(
      {
        ...NEXT_FILES,
        'node_modules/@reticlehq/react/package.json': '{"name":"@reticlehq/react"}',
        'node_modules/@reticlehq/next/package.json': '{"name":"@reticlehq/next"}',
      },
      { execOk: false, mcpExists: true },
    );
    runInit({ ...OPTS, install: true }, io);
    const report = io.lines.join('\n');
    expect(report).toContain('[✓] Install dependencies');
    expect(report).not.toContain('step failed');
  });

  it('config that does not import anything is still written — it has no dependency to miss', () => {
    const io = memoryIo(NEXT_FILES, { execOk: false, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['.reticle.json']).toBeDefined();
  });
});

/**
 * Every app came up `hasCapabilities: false`, capabilities empty, `reticle_state` holding only
 * `__reticle_renders` — the state-truth read, which SKILL.md calls the highest-value line, was
 * unavailable on all six real apps out of the box because `init` wired neither call.
 */
describe('runInit — the capabilities module', () => {
  const APP = {
    'package.json': JSON.stringify({
      devDependencies: { vite: '^5', react: '^19' },
      dependencies: { zustand: '^4' },
    }),
    'vite.config.ts': `export default { plugins: [] };\n`,
    'src/App.tsx': '<button data-testid="pay">Pay</button><a data-testid="home" />',
  };

  it('writes a dev module carrying the scanned testids', () => {
    const io = memoryIo(APP, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerCapabilities');
    expect(mod).toContain("'pay'");
    expect(mod).toContain("'home'");
  });

  it('names the store library it found, COMMENTED — a wrong import would break the module', () => {
    const io = memoryIo(APP, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerStore');
    // Commented: detecting zustand is easy, knowing which module exports the store instance is not.
    for (const line of mod.split('\n')) {
      if (line.includes('registerStore')) expect(line.trimStart().startsWith('//')).toBe(true);
    }
  });

  it('is created on a RE-RUN too — it used to ride on the config patch and vanish when that was already done', () => {
    const io = memoryIo(
      {
        ...APP,
        'vite.config.ts': `import { reticle } from '@reticlehq/vite-plugin';\nexport default { plugins: [reticle()] };\n`,
      },
      { mcpExists: true },
    );
    runInit(OPTS, io);
    expect(io.written['src/reticle-dev.ts']).toContain('registerCapabilities');
  });

  it('never overwrites an existing one — it is the file the user is meant to edit', () => {
    const io = memoryIo({ ...APP, 'src/reticle-dev.ts': '// mine\n' }, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.written['src/reticle-dev.ts']).toBeUndefined();
  });

  it('still writes the module when an app has no testids yet, and says so', () => {
    const io = memoryIo({ ...APP, 'src/App.tsx': '<button>Pay</button>' }, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerCapabilities');
    expect(mod).toContain('add data-testid');
  });
});

/**
 * An app that is neither `apps/*` nor `packages/*` produced three failures at once (#318), and the
 * repo that reported it keeps its app at `src/admin`.
 *
 * The testid scan walked a fixed list of directory names, so an app that keeps its screens anywhere
 * else read as an app with no test hooks at all — and "no data-testid values yet" makes an agent go
 * and write the ones that are already there. The command file went to the app directory while the
 * human's agent session runs at the repo root, so `/reticle` did not exist for them until they
 * copied it up by hand: the one durable entry point into Reticle, silently absent.
 *
 * `init` already grew `apps/*` and `packages/*` scanning after a report about `frontend/`. A third
 * report of the same shape is what says the fix is not another name in a list.
 */
describe('runInit — an app outside the directory names anyone guessed', () => {
  const NESTED = {
    'src/admin/package.json': JSON.stringify({
      devDependencies: { vite: '^5', react: '^19' },
    }),
    'src/admin/vite.config.ts': `export default { plugins: [] };\n`,
    'src/admin/modules/users/UserList.tsx': '<tr data-testid="user-row" />',
  };

  it('scans the app for testids wherever it keeps its source', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.written['src/admin/src/reticle-dev.ts'] ?? '').toContain("'user-row'");
  });

  it('writes /reticle where the human runs their agent, not into the app', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    const written = Object.keys(io.written).map((p) => p.replace(/\\/g, '/'));
    expect(written).toContain('/app/.claude/commands/reticle.md');
    expect(written).not.toContain('src/admin/.claude/commands/reticle.md');
  });

  /**
   * `.reticle.json` is read from the CWD by the CLI and by `reticle mcp` — the agent's CWD, which
   * after a redirect is the repo root and not the app. Reported from the field: the app was wired on
   * a non-default port, the root had no config, so `reticle mcp` fell back to 4400 and would have
   * listed ANOTHER project's tabs while the wired app sat unseen. Written in both places: the app
   * dir is where a human standing in the app runs `reticle status`, the root is where the agent is.
   */
  it('writes .reticle.json at the agent root as well — that is where `reticle mcp` reads it', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    const written = Object.keys(io.written).map((p) => p.replace(/\\/g, '/'));
    expect(written).toContain('/app/.reticle.json');
    expect(written).toContain('src/admin/.reticle.json');
    // The same identity in both, or the daemon scopes sessions to a project the app never claims.
    expect(io.written['/app/.reticle.json']).toBe(io.written['src/admin/.reticle.json']);
  });

  /**
   * A monorepo has more than one app, and the root can only point at one of them.
   *
   * Reported from the field: two instrumented Next apps, each with its own correct config, and a
   * root config committed pointing at the first. `init --app <the second>` rewrote the ROOT
   * projectId to the second app's and said nothing — the printed line was the reassuring
   * "the same config where the agent runs". An agent started at the root then drives a different
   * project than the one whose config it is reading, which is the silent-wrong-target failure this
   * product exists to prevent, arriving from our own installer.
   *
   * Absent and CONFLICTING are different situations and had the same branch. Absent is still
   * written, because that is the case the root config was added for. Conflicting is not ours to
   * resolve: overwriting loses the other app, refusing silently leaves the agent pointed away from
   * the app just wired. So it is named, and the human picks.
   */
  it('refuses to silently repoint a root config that names a DIFFERENT project', () => {
    const io = memoryIo(
      {
        ...NESTED,
        '/app/.reticle.json': JSON.stringify({ projectId: 'the-other-app', port: 4400 }),
      },
      { mcpExists: true },
    );
    runInit(OPTS, io);
    // The other app's identity survives.
    expect(io.written['/app/.reticle.json']).toBeUndefined();
    const printed = io.lines.join('\n');
    expect(printed).toContain('the-other-app');
  });

  it('still writes a root config that is merely ABSENT — the case it was added for', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    expect(Object.keys(io.written).map((p) => p.replace(/\\/g, '/'))).toContain(
      '/app/.reticle.json',
    );
  });

  it('and the agent rule with it — CLAUDE.md is read at the repo root, not in the app', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    const written = Object.keys(io.written).map((p) => p.replace(/\\/g, '/'));
    expect(written).toContain('/app/CLAUDE.md');
  });

  it('says so in the report, because it changes where /reticle will exist', () => {
    const io = memoryIo(NESTED, { mcpExists: true });
    runInit(OPTS, io);
    const printed = io.lines.join('\n').replace(/\\/g, '/');
    expect(printed).toContain('/app/.claude/commands/reticle.md');
  });

  it('leaves a single-package repo exactly as it was — the two roots are the same there', () => {
    const io = memoryIo(VITE_FILES, { mcpExists: true });
    runInit(OPTS, io);
    expect(Object.keys(io.written)).toContain('.claude/commands/reticle.md');
  });
});

/**
 * SKILL.md told the user "Type `/reticle` anytime to verify the app" in three separate places, and
 * `init` never wrote the file that makes the command exist. So the single most obvious way into the
 * product was a command that silently did nothing, in every tool, for everyone.
 */
describe('runInit — the /reticle command', () => {
  it('creates the Claude Code command so /reticle actually exists', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true });
    runInit(OPTS, io);
    const cmd = io.written['.claude/commands/reticle.md'] ?? '';
    expect(cmd).toContain('description:');
    expect(cmd).toContain('reticle_snapshot');
  });

  it('scopes the command to ONE flow — an existing app has many, and instrumenting all is the slow path', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true });
    runInit(OPTS, io);
    const cmd = io.written['.claude/commands/reticle.md'] ?? '';
    expect(cmd).toContain('Pick ONE flow');
    expect(cmd).toContain('Not the whole app');
    // Driving by role/name works without testids; telling people otherwise is what makes onboarding long.
    expect(cmd).toContain('do **not** need');
  });

  it('writes the Cursor command when Cursor is the agent in play', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: true });
    runInit(OPTS, io);
    expect(io.written['.cursor/commands/reticle.md']).toContain('reticle_snapshot');
  });

  /**
   * A command file frozen at whatever release created it can never be improved for anyone who
   * already ran init — the same existence-gate that kept the Cursor RULE stale. A file carrying our
   * frontmatter signature is refreshed; one that does not (a human's own /reticle) is untouchable,
   * which the test below pins.
   */
  it('refreshes a STALE Reticle command, recognised by its own frontmatter', () => {
    const stale =
      '---\ndescription: Verify this app in the browser with Reticle\n---\n\nold body\n';
    const io = memoryIo(
      { ...VITE_FILES, '.claude/commands/reticle.md': stale },
      { claudeAvailable: true },
    );
    runInit(OPTS, io);
    expect(io.written['.claude/commands/reticle.md']).toContain('Pick ONE flow');
  });

  it('is idempotent — an existing command is left alone', () => {
    const io = memoryIo(
      { ...VITE_FILES, '.claude/commands/reticle.md': '# mine\n' },
      { claudeAvailable: true },
    );
    runInit(OPTS, io);
    expect(io.written['.claude/commands/reticle.md']).toBeUndefined();
  });
});

/**
 * For ~48 hours after every release, a pnpm project with `minimumReleaseAge` could not install
 * Reticle AT ALL: `init` pins the SDK to the CLI's version and pnpm refuses anything younger than
 * its window. Measured against the live 2.4.0, three minutes after publish.
 *
 * The pin exists to stop SILENT version skew, so it cannot simply be dropped — but a blocked install
 * is worse than a reported one. Fall back to unpinned, and say so.
 */
describe('runInit — a refused pin falls back instead of blocking the install', () => {
  /** Fails the exact-version install, accepts the unpinned retry — what pnpm does inside the window. */
  function pinRefusingIo(files: Record<string, string>): MemoryIo {
    const io = memoryIo(files, { mcpExists: true });
    const realExec = io.exec.bind(io);
    return {
      ...io,
      exec(command: string, args: readonly string[]) {
        realExec(command, args); // still recorded, so the test can see BOTH attempts
        return !args.some((a) => a.includes('@reticlehq/react@'));
      },
    };
  }

  const VITE_APP = {
    'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^19' } }),
    'vite.config.ts': 'export default { plugins: [] };\n',
    'pnpm-lock.yaml': '',
  };

  it('retries unpinned, so the user ends up installed rather than blocked', () => {
    const io = pinRefusingIo(VITE_APP);
    runInit({ ...OPTS, install: true }, io);
    const attempts = io.execCalls.filter((c) => c.args.includes('add'));
    expect(attempts.length, 'it must try the pin first, then the fallback').toBe(2);
    expect(attempts[0]?.args.some((a) => /@reticlehq\/react@\d/.test(a))).toBe(true);
    expect(attempts[1]?.args).toContain('@reticlehq/react');
  });

  it('never does it silently — the pin is what keeps SDK and daemon in step', () => {
    const io = pinRefusingIo(VITE_APP);
    runInit({ ...OPTS, install: true }, io);
    const out = io.lines.join('\n');
    expect(out).toContain('minimumReleaseAge');
    expect(out).toContain('versionSkew');
  });

  it('still wires the app — a fallback install is a real install', () => {
    const io = pinRefusingIo(VITE_APP);
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['vite.config.ts']).toContain('reticle(');
  });
});

/**
 * A `[✓]` for a filesystem effect must be backed by a `stat`, not by the intention to write.
 *
 * Reported from the field (#160): `init` printed `[✓] Reticle config → .reticle.json` and the file
 * was not there afterward. Two candidates had to be separated before changing anything — the step
 * reporting its PLAN rather than its EFFECT, or the file landing in a different directory than the
 * user was standing in. The second is a real hazard in a monorepo and was addressed separately by
 * printing the project directory in the header. This is the first: nothing ever checked.
 *
 * It is the same shape as #139 (`✓ Capabilities + store` for a module nothing imported) and the same
 * shape as the Next.js install that reported clean and connected 0% of the time. A checkmark that
 * cannot fail is not a report, it is decoration — and this one is the first thing a new user reads.
 *
 * The write path itself is not suspected. The point is that no arrangement of the filesystem — a
 * read-only mount, a full disk, an antivirus quarantining a new dotfile, a path the process cannot
 * see — could ever have turned that tick into anything else.
 */
describe('init confirms a file it claims to have written', () => {
  /**
   * An IO whose writes are accepted and silently do not land — a read-only mount, a full disk, an
   * antivirus quarantining a new dotfile. Only the config write is swallowed, so the test isolates
   * one step rather than failing the whole install for an unrelated reason.
   */
  function swallowingIo(files: Record<string, string>): MemoryIo {
    const io = memoryIo(files);
    const realWrite = io.writeFile.bind(io);
    return {
      ...io,
      writeFile: (p, c) => {
        if (p.endsWith('.reticle.json')) return;
        realWrite(p, c);
      },
    };
  }

  it('does not print ✓ for a config file that is not on disk afterward', () => {
    const io = swallowingIo(VITE_FILES);
    runInit(OPTS, io);
    const report = io.lines.join('\n');
    const configLine = report.split('\n').find((l) => l.includes('.reticle.json')) ?? '';
    expect(configLine, 'the config step must be reported').not.toBe('');
    expect(configLine, 'a ✓ here is a claim nothing checked').not.toContain('✓');
  });

  it('still prints ✓ when the file IS on disk — the ordinary case is untouched', () => {
    // The control. A confirmation that fails open would silently downgrade every healthy install.
    const io = memoryIo(VITE_FILES);
    runInit(OPTS, io);
    const line = io.lines.find((l) => l.includes('.reticle.json')) ?? '';
    expect(line).toContain('✓');
    expect(io.written['.reticle.json']).toBeDefined();
  });
});

/**
 * The last two lines a user reads after `init`, and the order they are in.
 *
 * It used to print only "Restart <dev server>, then ask your agent: List Reticle sessions" — and
 * asking the agent was the one instruction that could not work yet. `init` registers the MCP
 * server, but an agent client reads its tool list when it STARTS and never re-reads it, so the
 * session that just ran `init` has no `reticle_*` tools however clean the install was.
 *
 * The user follows the instruction, the agent answers "unknown tool", and the obvious conclusion is
 * that the install failed. This is the final line of the primary setup path, so it reaches every
 * user on every route — not only the ones following SKILL.md.
 */
describe('the closing hint names the MCP reload before it tells you to ask the agent', () => {
  it('tells the user to reload their MCP tools, and why', () => {
    const io = memoryIo(VITE_FILES);
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    expect(out).toMatch(/\/mcp|reload the window/i);
    expect(out, 'the reason, or it reads as superstition').toMatch(/tool list|only appear/i);
  });

  it('puts the reload BEFORE the instruction that depends on it', () => {
    const io = memoryIo(VITE_FILES);
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    const reload = out.search(/\/mcp|reload the window/i);
    // The dependent instruction is "drive one flow" — driving ANYTHING requires the reload,
    // because the agent read its tool list before Reticle existed. The closing line used to end on
    // "ask your agent: List Reticle sessions", a question whose failure is a dead end; it now ends
    // on `reticle status`, which ANSWERS it, followed by the work itself.
    //
    // It says "drive one flow", not "ask your agent to drive one flow": the agent-driven install is
    // the primary channel now, so the reader is usually the agent, and telling an agent to ask its
    // agent is a hand-off to nobody.
    // Matched on the FULL closing phrase: "drive one flow" alone also appears in the capabilities
    // notice further up ("Prove it: drive one flow and check reticle_state..."), which would make
    // this assert about the wrong line and pass or fail for the wrong reason.
    const dependent = out.search(/drive one flow and report the verdict/i);
    expect(reload).toBeGreaterThan(-1);
    expect(dependent, 'the closing line must still hand off to the agent').toBeGreaterThan(-1);
    expect(reload, 'reload must come first').toBeLessThan(dependent);
  });

  it('names a command that CONFIRMS the install, not one that merely asks', () => {
    // `init` writes files and stops. The install is not finished until an app carrying the SDK has
    // dialled the daemon, and this is the last instruction most people read — so it has to point at
    // the thing that can answer, which since 2.7.0 also says WHY when the answer is no.
    const io = memoryIo(VITE_FILES);
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    expect(out).toMatch(/status/);
    expect(out, 'and say what it proves').toMatch(/confirms the app connected|why it has not/i);
  });

  it('says nothing about MCP when this run did not register it', () => {
    // `--no-mcp`. Advice about something we deliberately did not do is noise, and noise in the
    // closing lines is what makes the real instructions get skimmed.
    const io = memoryIo(VITE_FILES);
    runInit({ ...OPTS, mcp: false }, io);
    const out = io.lines.join('\n');
    expect(out).not.toMatch(/\/mcp\b|reload the window/i);
    expect(out, 'the dev-server restart still stands').toContain('Restart');
  });
});
