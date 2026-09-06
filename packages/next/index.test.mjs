import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { withReticle, readPairingToken, discoverDaemonUrl } = require('./index.cjs');

const TOKEN_ENV = 'RETICLE_PAIRING_TOKEN_DIR';

// withReticle now mints; keep it out of the real ~/.reticle during tests that do not set the env.
const defaultTokenDir = mkdtempSync(join(tmpdir(), 'reticle-next-default-token-'));
const savedTokenDir = process.env[TOKEN_ENV];
process.env[TOKEN_ENV] = defaultTokenDir;
afterAll(() => {
  if (savedTokenDir === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedTokenDir;
  rmSync(defaultTokenDir, { recursive: true, force: true });
});

describe('readPairingToken', () => {
  const previous = process.env[TOKEN_ENV];
  /** @type {string | undefined} */
  let dir;

  afterEach(() => {
    if (previous === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the token from RETICLE_PAIRING_TOKEN_DIR when the daemon has written one', () => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-next-token-'));
    writeFileSync(join(dir, 'pairing-token'), 'tok-from-daemon\n');
    process.env[TOKEN_ENV] = dir;
    expect(readPairingToken()).toBe('tok-from-daemon');
  });

  it('mints a token when the file is missing, so next dev before the daemon still authenticates', () => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-next-token-'));
    process.env[TOKEN_ENV] = dir;
    const token = readPairingToken();
    expect(typeof token).toBe('string');
    expect((token ?? '').length).toBeGreaterThan(0);
    expect(readPairingToken()).toBe(token);
  });
});

describe('withReticle', () => {
  const previousEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('is a no-op in production, so a production Next config is byte-identical', () => {
    process.env.NODE_ENV = 'production';
    const input = { reactStrictMode: true };
    expect(withReticle(input)).toBe(input);
  });

  it('installs the stamping loader as a webpack pre-loader in development', () => {
    process.env.NODE_ENV = 'development';
    const config = withReticle({});
    expect(typeof config.webpack).toBe('function');
    const webpackConfig = { module: { rules: [] } };
    const out = config.webpack(webpackConfig, { dev: true });
    const rule = out.module.rules.find(
      (entry) =>
        entry.enforce === 'pre' && String(entry.use?.[0]?.loader ?? '').endsWith('loader.cjs'),
    );
    expect(rule).toBeDefined();
    expect(rule.test.test('src/Foo.tsx')).toBe(true);
    expect(rule.test.test('src/Foo.jsx')).toBe(true);
    expect(rule.test.test('src/util.ts')).toBe(false);
  });
});

/**
 * The frozen-port defect.
 *
 * `reticle init` writes the daemon's port into the generated ReticleDev component at install time.
 * The Vite plugin has always re-resolved it on every dev-server start; this package never did, so a
 * Next app kept dialling whatever port init happened to see. Moving the daemon left the app dialling
 * a port nothing listens on, with no error anywhere but a console warning in a browser nobody reads.
 *
 * core's `pickDaemonPort` documents this rule as shared by "both the vite and next plugins". These
 * pin the next half against the same three cases.
 */
describe('discoverDaemonUrl', () => {
  /** @type {string[]} */
  const dirs = [];
  const live = () => true;
  const dead = () => false;

  function project(projectId) {
    const cwd = mkdtempSync(join(tmpdir(), 'reticle-next-cwd-'));
    dirs.push(cwd);
    if (projectId !== undefined) {
      writeFileSync(join(cwd, '.reticle.json'), JSON.stringify({ projectId }));
    }
    return cwd;
  }

  function home(entries) {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-next-home-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${e.port}.json`), JSON.stringify(e));
    }
    return dir;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds the live daemon serving THIS project, whatever port it moved to', () => {
    const cwd = project('shop-abc123');
    const dir = home([{ port: 4407, pid: 111, projectId: 'shop-abc123' }]);
    expect(discoverDaemonUrl(cwd, dir, live)).toBe('ws://localhost:4407/reticle');
  });

  /** A wrong auto-connect reports another app's state as this one's, which is worse than no connect. */
  it('never adopts a daemon serving a different project', () => {
    const cwd = project('shop-abc123');
    const dir = home([{ port: 4400, pid: 111, projectId: 'blog-def456' }]);
    expect(discoverDaemonUrl(cwd, dir, live)).toBeUndefined();
  });

  it('ignores a stale entry whose process is gone', () => {
    const cwd = project('shop-abc123');
    const dir = home([{ port: 4407, pid: 111, projectId: 'shop-abc123' }]);
    expect(discoverDaemonUrl(cwd, dir, dead)).toBeUndefined();
  });

  it('prefers the lowest port when one project has two live daemons', () => {
    const cwd = project('shop-abc123');
    const dir = home([
      { port: 4409, pid: 111, projectId: 'shop-abc123' },
      { port: 4402, pid: 222, projectId: 'shop-abc123' },
    ]);
    expect(discoverDaemonUrl(cwd, dir, live)).toBe('ws://localhost:4402/reticle');
  });

  it('says nothing for a project that has never been through init', () => {
    const cwd = project(undefined);
    const dir = home([{ port: 4400, pid: 111, projectId: 'shop-abc123' }]);
    expect(discoverDaemonUrl(cwd, dir, live)).toBeUndefined();
  });

  it('survives a corrupt registry entry instead of throwing into the dev server', () => {
    const cwd = project('shop-abc123');
    const dir = home([{ port: 4407, pid: 111, projectId: 'shop-abc123' }]);
    writeFileSync(join(dir, 'daemon-9999.json'), '{ not json');
    expect(discoverDaemonUrl(cwd, dir, live)).toBe('ws://localhost:4407/reticle');
  });

  it('says nothing when ~/.reticle does not exist at all', () => {
    const cwd = project('shop-abc123');
    expect(discoverDaemonUrl(cwd, join(tmpdir(), 'reticle-absent-home-xyz'), live)).toBeUndefined();
  });
});

/**
 * The seam between discovery and the client bundle.
 *
 * `discoverDaemonUrl` being correct is worth nothing if `withReticle` does not forward the result:
 * the port is computed and thrown away, and the app keeps dialling the frozen one with no error
 * anywhere. This is also the only place the two halves of the fix meet, and they live in different
 * packages joined by nothing but the NAME of an environment variable.
 */
describe('withReticle forwards the discovered daemon', () => {
  const prevDir = process.env[TOKEN_ENV];
  const prevCwd = process.cwd();
  /** @type {string[]} */
  const dirs = [];

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevDir === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prevDir;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scenario(entry) {
    const home = mkdtempSync(join(tmpdir(), 'reticle-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'reticle-proj-'));
    dirs.push(home, cwd);
    writeFileSync(join(cwd, '.reticle.json'), JSON.stringify({ projectId: 'shop-abc123' }));
    if (entry !== undefined) {
      writeFileSync(join(home, `daemon-${entry.port}.json`), JSON.stringify(entry));
    }
    process.env[TOKEN_ENV] = home;
    process.chdir(cwd);
    return withReticle({});
  }

  it('publishes the daemon it found, on whatever port it moved to', () => {
    const config = scenario({ port: 4788, pid: process.pid, projectId: 'shop-abc123' });
    expect(config.env.NEXT_PUBLIC_RETICLE_URL).toBe('ws://localhost:4788/reticle');
  });

  /** No daemon for this project: the app falls back to the default rather than adopting a stranger. */
  it('publishes nothing when no daemon serves this project', () => {
    const config = scenario(undefined);
    expect(config.env.NEXT_PUBLIC_RETICLE_URL).toBeUndefined();
  });

  it('mints and publishes a pairing token when the daemon has not written one yet', () => {
    const config = scenario(undefined);
    expect(typeof config.env.NEXT_PUBLIC_RETICLE_TOKEN).toBe('string');
    expect(config.env.NEXT_PUBLIC_RETICLE_TOKEN.length).toBeGreaterThan(0);
  });

  it('leaves production builds untouched', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const config = scenario({ port: 4788, pid: process.pid, projectId: 'shop-abc123' });
      expect(config.env).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

/**
 * This package is plain CJS with no dependency on core, so the wire values are duplicated here. A
 * duplicate that drifts does not throw: it produces a URL nothing is listening on, which surfaces as
 * a silent no-connect and reads to a user as "Reticle is broken". Pin them to core's.
 */
describe('the duplicated wire constants match core', () => {
  /*
   * A generous timeout, not the 5s default: this is the only test here that dynamically imports
   * core's dist, and under `turbo test:unit` that import competes with every other package's
   * compile. It resolves in ~20ms alone and blew 5s under parallel load — a statement about the
   * machine, not about the constants, which is exactly the flake shape the house rules name.
   */
  it('builds the same bridge URL core does', { timeout: 30_000 }, async () => {
    const { bridgeWsUrl } = await import('@reticlehq/core');
    const home = mkdtempSync(join(tmpdir(), 'reticle-const-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'reticle-const-proj-'));
    try {
      writeFileSync(join(cwd, '.reticle.json'), JSON.stringify({ projectId: 'p' }));
      writeFileSync(
        join(home, 'daemon-4400.json'),
        JSON.stringify({ port: 4400, pid: process.pid, projectId: 'p' }),
      );
      expect(discoverDaemonUrl(cwd, home, () => true)).toBe(bridgeWsUrl(4400));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
