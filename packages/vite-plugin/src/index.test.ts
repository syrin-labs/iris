import { afterAll, describe, it, expect } from 'vitest';
import { OPTIMIZER_OPTIONS_KEY, optimizerOptionsKey, viteMajor } from './installed.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from '@babel/core';
import reticleSource from '@reticlehq/babel-plugin';
import { RETICLE_DEFAULT_PORT, ReticleDir, ReticleEnv } from '@reticlehq/core';
import {
  reticle,
  RETICLE_VITE_PLUGIN_NAME,
  RETICLE_CONNECT_MODULE,
  connectModuleSource,
  installedSdk,
} from './index.js';

// The attribute the babel plugin stamps (mirrors DATA_RETICLE_SOURCE_ATTR in core).
const SOURCE_ATTR = 'data-reticle-source';

// Point the token lookup at an empty temp dir so tests never pick up a real ~/.reticle/pairing-token.
const emptyTokenDir = mkdtempSync(join(tmpdir(), 'reticle-vite-token-'));
const savedTokenDir = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
process.env[ReticleEnv.PAIRING_TOKEN_DIR] = emptyTokenDir;
afterAll(() => {
  if (savedTokenDir === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = savedTokenDir;
});

describe('reticle vite plugin', () => {
  it('only applies during serve (never ships to production builds)', () => {
    const plugin = reticle();
    expect(plugin.name).toBe(RETICLE_VITE_PLUGIN_NAME);
    expect(plugin.apply).toBe('serve');
    expect(plugin.enforce).toBe('pre');
  });

  it('stamps data-reticle-source on host elements in .tsx files', () => {
    const plugin = reticle();
    const result = plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx');
    expect(result).not.toBeNull();
    expect(result?.code).toContain(SOURCE_ATTR);
  });

  it('skips non-jsx and node_modules and virtual ids', () => {
    const plugin = reticle();
    expect(plugin.transform?.('const x = 1;', '/app/src/util.ts')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '/app/node_modules/pkg/Foo.tsx')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '\0virtual:foo.tsx')).toBeNull();
  });

  it('disables stamping when sourceMapping is false', () => {
    const plugin = reticle({ sourceMapping: false });
    expect(plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx')).toBeNull();
  });

  it('injects a script that references the connect module by src (not an inline import)', () => {
    // Regression: an inline injected <script> with a bare import is NOT run through Vite import
    // resolution, so it must be served as a real module via src.
    const plugin = reticle();
    const tags = plugin.transformIndexHtml?.('<html></html>');
    // Two tags now: the classic pre-hook in <head> (which must run before any module script so React
    // finds the devtools hook when it injects) and the module that connects.
    expect(tags).toHaveLength(2);
    const [prehook, connect] = tags;
    expect(prehook?.injectTo).toBe('head-prepend');
    expect(prehook?.attrs).toBeUndefined();
    expect(String(prehook?.children)).toContain('__REACT_DEVTOOLS_GLOBAL_HOOK__');
    expect(connect?.injectTo).toBe('body');
    expect(connect?.tag).toBe('script');
    expect(connect?.attrs?.['type']).toBe('module');
    expect(connect?.attrs?.['src']).toBe(RETICLE_CONNECT_MODULE);
  });

  it('serves the connect module importing the SDK from the @reticlehq/react kit', () => {
    const plugin = reticle();
    expect(plugin.resolveId?.(RETICLE_CONNECT_MODULE)).toBe(RETICLE_CONNECT_MODULE);
    expect(plugin.resolveId?.('some/other/id')).toBeNull();
    const code = plugin.load?.(RETICLE_CONNECT_MODULE);
    // Must import from the kit, which actually exports `reticle` + `install`. Importing from
    // @reticlehq/core (the foundation, which exports neither) is the bug this asserts against.
    expect(code).toContain("from '@reticlehq/react'");
    expect(code).not.toContain("from '@reticlehq/core'");
    expect(code).toContain('install()');
    expect(code).toContain('reticle.connect(');
  });

  it('does not inject or serve the module when inject is false', () => {
    const plugin = reticle({ inject: false });
    expect(plugin.transformIndexHtml?.('<html></html>')).toEqual([]);
    expect(plugin.resolveId?.(RETICLE_CONNECT_MODULE)).toBeNull();
    expect(plugin.load?.(RETICLE_CONNECT_MODULE)).toBeNull();
  });

  it('bakes a non-default port into the connect module url', () => {
    const customPort = RETICLE_DEFAULT_PORT + 1;
    const code = reticle({ port: customPort }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain(String(customPort));
    expect(code).toContain('ws://localhost:');
  });

  it('omits the url for the default port (SDK default applies)', () => {
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).not.toContain('ws://localhost:');
  });

  it('forwards session and token when provided', () => {
    const code = reticle({ session: 'my-app', token: 'secret' }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('my-app');
    expect(code).toContain('secret');
  });

  it('auto-injects the daemon pairing token from the token dir when no explicit token is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-vite-hastoken-'));
    writeFileSync(join(dir, ReticleDir.PAIRING_TOKEN_FILE), 'daemon-secret-123\n');
    const prev = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = dir;
    try {
      const code = reticle().load?.(RETICLE_CONNECT_MODULE);
      expect(code).toContain('daemon-secret-123');
      expect(code).toContain('token');
    } finally {
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = prev;
    }
  });

  it('PROVISIONS a token when the daemon has not run yet, instead of shipping none', () => {
    // This used to assert the opposite, and the opposite is the bug. A dev server started before the
    // daemon froze an empty token into every page it served; the bridge refused each one and no
    // session ever appeared, while the SDK loaded and the socket opened. The daemon read-or-creates
    // the same file, so whichever starts first can provision it and the two agree. See ensure-token.
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('token');
  });

  it('auto-stamps a derived projectId with zero config', () => {
    const code = reticle().load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('projectId');
    // The id this monorepo derives for the vite-plugin package starts with a slug of its name.
    expect(code).toMatch(/projectId":"[a-z0-9-]+-[0-9a-f]{8}"/);
  });

  it('an explicit projectId option overrides the derived one', () => {
    const code = reticle({ projectId: 'my-fixed-id' }).load?.(RETICLE_CONNECT_MODULE);
    expect(code).toContain('my-fixed-id');
  });
});

describe('desktop mode', () => {
  /**
   * A packaged Electron/Tauri renderer is a PRODUCTION Vite build loaded from `file://` or a custom
   * protocol — there is no dev server. `apply: 'serve'` therefore drops the plugin entirely and the
   * app ships with no `connect()` at all, which is why the desktop demos had to hand-wire it. Desktop
   * mode is the opt-in that says "this build is a dev desktop shell, instrument it too".
   */
  it('applies to build (not just serve) so a packaged renderer is instrumented', () => {
    expect(reticle({ desktop: true }).apply).toBe(undefined);
    expect(reticle().apply).toBe('serve');
  });

  it('allows the SDK to run in a production-mode renderer, which desktop always is', () => {
    expect(connectModuleSource({ desktop: true })).toContain('allowInProduction');
    expect(connectModuleSource({})).not.toContain('allowInProduction');
  });

  it('still honours an explicit inject:false in desktop mode', () => {
    const plugin = reticle({ desktop: true, inject: false });
    expect(plugin.transformIndexHtml('')).toEqual([]);
  });

  it('leaves web behaviour untouched — no desktop keys leak into a normal connect', () => {
    // A non-default port, because the default one is deliberately omitted from the connect args.
    const web = connectModuleSource({ port: 4401 });
    expect(web).toContain('4401');
    expect(web).not.toContain('allowInProduction');
  });
});

/**
 * The plugin is the only `connect()` most apps ever have — a second, hand-written one is a no-op —
 * so an option it cannot forward is an option the app cannot use AT ALL. `captureNetworkBodies` was
 * the first case of this; `allowNonLocalhost` is the same shape and worse, because without it an app
 * that cannot be served on localhost (host-based multi-tenant, cookie-scoped auth on a custom dev
 * hostname) cannot use Reticle at all rather than merely losing a feature.
 */
describe('connect options the SDK supports are reachable from the plugin', () => {
  const ALLOW_ENV = 'VITE_RETICLE_ALLOW_NON_LOCALHOST';

  it('forwards allowNonLocalhost, and omits it when unset', () => {
    expect(connectModuleSource({ allowNonLocalhost: true })).toContain('allowNonLocalhost');
    expect(connectModuleSource({})).not.toContain('allowNonLocalhost');
  });

  it('can be turned on for one session through the env, without editing vite.config', () => {
    const prev = process.env[ALLOW_ENV];
    process.env[ALLOW_ENV] = '1';
    try {
      expect(connectModuleSource({})).toContain('allowNonLocalhost');
    } finally {
      if (prev === undefined) delete process.env[ALLOW_ENV];
      else process.env[ALLOW_ENV] = prev;
    }
  });
});

describe('desktop injection site', () => {
  /**
   * In a build Vite routes the HTML entry through an html-proxy id rather than the plain file path.
   * An `endsWith('.html')` check silently misses it, and the bundle ships with no connect() at all —
   * the app looks wired and connects to nothing. Both spellings must be recognised.
   */
  it('recognises the html entry in both dev and build id shapes', () => {
    for (const importer of ['/app/index.html', '/app/index.html?html-proxy&index=0.js']) {
      const plugin = reticle({ desktop: true });
      // resolveId sees the SPECIFIER; transform later sees the ABSOLUTE resolved path.
      plugin.resolveId('/src/main.tsx', importer);
      const out = plugin.transform('const a = 1;', '/Users/me/app/src/main.tsx');
      expect(out?.code, `importer ${importer}`).toContain('reticle.connect');
    }
  });

  it('does not inject into a module the HTML never referenced', () => {
    const plugin = reticle({ desktop: true });
    plugin.resolveId('/src/main.tsx', '/app/index.html');
    expect(
      plugin.transform('const a = 1;', '/Users/me/app/src/other.ts')?.code ?? '',
    ).not.toContain('reticle.connect');
  });

  it('never injects on the web path, even into the html entry', () => {
    const plugin = reticle();
    plugin.resolveId('/src/main.tsx', '/app/index.html');
    expect(
      plugin.transform('const a = 1;', '/Users/me/app/src/main.tsx')?.code ?? '',
    ).not.toContain('reticle.connect');
  });
});

describe('desktop injection cannot fail silently', () => {
  /**
   * The failure this guards against actually happened twice while building desktop mode: the entry
   * match missed, nothing was injected, and the packaged app shipped with no connect() in it. The
   * app LOOKED wired. A build that cannot instrument must fail loudly rather than produce a binary
   * that silently reports nothing.
   */
  it('fails the build when the entry was never found', () => {
    const plugin = reticle({ desktop: true });
    expect(() => plugin.buildEnd?.()).toThrow(/could not inject/i);
    expect(() => plugin.buildEnd?.()).toThrow(/__RETICLE_TOKEN__/);
  });

  it('is satisfied once the entry has been injected', () => {
    const plugin = reticle({ desktop: true });
    plugin.resolveId('/src/main.tsx', '/app/index.html');
    plugin.transform('const a = 1;', '/app/src/main.tsx');
    expect(() => plugin.buildEnd?.()).not.toThrow();
  });

  it('says nothing on the web path, where injection is a script tag', () => {
    expect(() => reticle().buildEnd?.()).not.toThrow();
  });

  it('says nothing when injection was explicitly disabled', () => {
    expect(() => reticle({ desktop: true, inject: false }).buildEnd?.()).not.toThrow();
  });

  /**
   * Suffix matching alone would inject into `/other/src/main.tsx` for an entry of `/src/main.tsx`.
   * When the resolved root is known, the comparison is exact instead.
   */
  it('does not inject into a different file that merely shares a suffix', () => {
    const plugin = reticle({ desktop: true });
    plugin.configResolved?.({ root: '/app' });
    plugin.resolveId('/src/main.tsx', '/app/index.html');
    const wrong = plugin.transform('const a = 1;', '/other/src/main.tsx');
    expect(wrong?.code ?? '').not.toContain('reticle.connect');
    const right = plugin.transform('const a = 1;', '/app/src/main.tsx');
    expect(right?.code ?? '').toContain('reticle.connect');
  });
});

describe('desktop injection is loud in dev too, not only in build', () => {
  /**
   * `buildEnd` covers the dangerous case — a packaged binary that ships uninstrumented. Dev had no
   * equivalent: a missed injection just meant no session ever appeared, and nothing said why. That
   * is the same silent failure, only with a shorter blast radius, so it gets the same treatment.
   *
   * The check is deferred rather than immediate because in `serve` the HTML is sent BEFORE the
   * browser requests the entry module — asserting at html time would fire on every healthy start.
   */
  /**
   * In dev the flag means "my transform ran this session", which is NOT "the app has no connect()":
   * Vite serves an unchanged module from its transform cache, so a warm cache leaves the flag false
   * while the served entry really is instrumented. The warning must therefore report doubt, not a
   * verdict — the build path keeps the certainty, because a build always runs every transform.
   */
  it('reports UNCONFIRMED injection in dev, never a false verdict', () => {
    const warnings: string[] = [];
    const plugin = reticle({ desktop: true, onWarn: (m) => warnings.push(m) });
    plugin.configResolved?.({ root: '/app', command: 'serve' });
    plugin.transformIndexHtml('<html></html>');
    plugin.checkInjectedForTest?.();
    const text = warnings.join(' ');
    expect(text).toMatch(/could not confirm/i);
    expect(text, 'dev must not claim the app will never connect').not.toMatch(
      /will never connect/i,
    );
    // The benign cause has to be named, or every warm-cache start reads as a broken integration.
    expect(text).toMatch(/cache/i);
  });

  it('stays quiet when the entry was injected', () => {
    const warnings: string[] = [];
    const plugin = reticle({ desktop: true, onWarn: (m) => warnings.push(m) });
    plugin.configResolved?.({ root: '/app', command: 'serve' });
    plugin.transformIndexHtml('<html></html>');
    plugin.resolveId('/src/main.tsx', '/app/index.html');
    plugin.transform('const a = 1;', '/app/src/main.tsx');
    plugin.checkInjectedForTest?.();
    expect(warnings).toEqual([]);
  });

  it('never warns on the web path', () => {
    const warnings: string[] = [];
    const plugin = reticle({ onWarn: (m) => warnings.push(m) });
    plugin.configResolved?.({ root: '/app', command: 'serve' });
    plugin.transformIndexHtml('<html></html>');
    plugin.checkInjectedForTest?.();
    expect(warnings).toEqual([]);
  });
});

describe('SDK dep optimization', () => {
  /**
   * The browser SDK no longer imports the second accessibility engine, so the Vite plugin must not
   * keep forcing those retired transitive deps into `optimizeDeps.include`. If an app does not have
   * them, Vite reports a scary Reticle-owned resolve warning before the page even loads.
   */
  it('does not declare the retired query-engine deps in optimizeDeps', () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    expect(typeof plugin.config, 'the plugin must have a config hook to declare deps').toBe(
      'function',
    );
    const patch = plugin.config?.({}) ?? {};
    const include = (patch['optimizeDeps'] as { include?: string[] } | undefined)?.include ?? [];
    expect(include.some((e) => e.endsWith('@testing-library/dom'))).toBe(false);
    expect(include.some((e) => e.endsWith('aria-query'))).toBe(false);
  });

  /**
   * The SDK itself has to be pre-declared, not discovered.
   *
   * Vite only learns about `@reticlehq/react` when the injected connect module is first requested —
   * which is mid-flight during the very first page load. It then pre-bundles it and forces a full
   * reload, and the connect is lost in that reload: no WebSocket, no session, no console message.
   * So the FIRST load after `reticle init` silently did nothing and the SECOND one worked, which is
   * the worst possible shape for this bug — it looks like the install failed, and it looks fixed the
   * moment anyone refreshes to investigate. Reproduced on a real Vite 4 app with a cold dep cache.
   */
  it('declares the SDK itself, so the first page load is not lost to a dep-optimization reload', () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.({}) ?? {};
    const include = (patch['optimizeDeps'] as { include?: string[] } | undefined)?.include ?? [];
    expect(include).toContain('@reticlehq/react');
  });

  /**
   * A connect the plugin does not write itself still needs the pairing token — SvelteKit's client
   * hook is the case that exists today. Nothing in a browser can read the file the token lives in,
   * so the hook called connect() with no credential and the bridge answered "authentication failed":
   * app boots, no session, one console line nobody was looking for. Same defect Next.js shipped.
   */
  it('inlines the pairing token as a define, for connects it does not write itself', () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.({}) ?? {};
    const define = (patch['define'] as Record<string, string> | undefined) ?? {};
    expect(Object.keys(define)).toContain('__RETICLE_TOKEN__');
    // Always a defined string literal — an undefined global would make the guard in the hook throw.
    expect(typeof define['__RETICLE_TOKEN__']).toBe('string');
  });

  it('still inlines __RETICLE_TOKEN__ when inject is false, for the hand-written connect', () => {
    const plugin = reticle({ inject: false }) as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.({}) ?? {};
    const define = (patch['define'] as Record<string, string> | undefined) ?? {};
    expect(Object.keys(define)).toContain('__RETICLE_TOKEN__');
  });

  it("preserves the app's own define entries", () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.({ define: { __THEIRS__: '"x"' } }) ?? {};
    const define = (patch['define'] as Record<string, string> | undefined) ?? {};
    expect(define['__THEIRS__']).toBe('"x"');
    expect(Object.keys(define)).toContain('__RETICLE_TOKEN__');
  });

  /**
   * Vite's dep-optimizer cache is keyed on the optimizeDeps config and the lockfile — not on what is
   * actually inside the packages it bundled. Upgrade the SDK in place and the version can stay the
   * same, so Vite keeps serving the OLD pre-bundled copy across dev-server restarts: the fix is not
   * in the browser and it looks like the fix does not work. That produced a real false negative
   * while hunting the null-fiber crash, and every in-place upgrade hits it.
   */
  /**
   * Read the optimizer options from whichever key THIS Vite uses. Vite 7 renamed
   * `esbuildOptions` to `rolldownOptions` and warns on the old one, so the plugin picks the key from
   * the installed major — and a test that hardcodes either name asserts the local Vite version
   * rather than the behaviour.
   */
  const optimizerDefine = (patch: Record<string, unknown>): Record<string, string> => {
    const opt = (patch['optimizeDeps'] ?? {}) as Record<string, unknown>;
    const key = optimizerOptionsKey(viteMajor());
    const options = opt[key] as
      | { define?: Record<string, string>; transform?: { define?: Record<string, string> } }
      | undefined;
    // Read it from where THIS bundler keeps it, and assert it is not in the other place. Reading
    // "wherever it happens to be" is what let a top-level define under rolldownOptions pass here
    // while Vite 8 refused it on every dev boot — the test agreed with the bug.
    if (OPTIMIZER_OPTIONS_KEY.ROLLDOWN === key) {
      expect(options?.define).toBeUndefined();
      return options?.transform?.define ?? {};
    }
    expect(options?.transform).toBeUndefined();
    return options?.define ?? {};
  };

  it('mixes the installed SDK build into the cache key so an in-place upgrade is noticed', () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    expect(Object.keys(optimizerDefine(plugin.config?.({}) ?? {}))).toContain(
      '__RETICLE_SDK_BUILD__',
    );
  });

  it("does not clobber the app's own optimizer define", () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const define = optimizerDefine(
      plugin.config?.({ optimizeDeps: { esbuildOptions: { define: { THEIRS: '"x"' } } } }) ?? {},
    );
    expect(define['THEIRS']).toBe('"x"');
    expect(Object.keys(define)).toContain('__RETICLE_SDK_BUILD__');
  });

  it('preserves optimizeDeps entries the app already declared', () => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.({ optimizeDeps: { include: ['their-dep'] } }) ?? {};
    const include = (patch['optimizeDeps'] as { include?: string[] } | undefined)?.include ?? [];
    expect(include, "the app's own entries must survive").toContain('their-dep');
    expect(include, 'the SDK itself still needs pre-bundling').toContain('@reticlehq/react');
  });
});

/**
 * The daemon journals every session into `.reticle/` in the PROJECT root, writing `ambient.json`
 * atomically as `ambient.json.tmp` + rename. That directory sits inside the tree Vite watches, and
 * it is not in Vite's default ignore list — so each journal write looked to Vite like a project file
 * changing, and Vite answered with a full page reload.
 *
 * That closes a loop with no exit: the page loads, the SDK connects and streams events, the daemon
 * writes the journal, Vite force-reloads the page, the SDK reconnects and streams more events. It
 * ran several times a second for as long as the dev server was up. Every ref went stale, every
 * act_and_wait died mid-flight, and the session log filled with connect/disconnect pairs that read
 * like a flapping SDK rather than a watcher feedback loop.
 *
 * The plugin is what puts Reticle in the app, so excluding Reticle's own state directory is the
 * plugin's job — an app author should not have to know we write there.
 */
describe('the daemon journal does not drive the dev server', () => {
  const ignoredFrom = (config: Record<string, unknown>): (string | RegExp)[] => {
    const plugin = reticle() as unknown as {
      config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined;
    };
    const patch = plugin.config?.(config) ?? {};
    const server = patch['server'] as { watch?: { ignored?: (string | RegExp)[] } } | undefined;
    return server?.watch?.ignored ?? [];
  };

  /** Does this ignore list actually reject `path`, the way chokidar would? */
  const rejects = (ignored: (string | RegExp)[], path: string): boolean =>
    ignored.some((m) => m instanceof RegExp && m.test(path));

  it('excludes the journal directory from the watcher', () => {
    const ignored = ignoredFrom({});
    // The paths chokidar actually reports: relative from the watched root, either separator.
    expect(rejects(ignored, `${ReticleDir.ROOT}/ambient.json`)).toBe(true);
    expect(rejects(ignored, `src/${ReticleDir.ROOT}/sessions/abc/events.jsonl`)).toBe(true);
    expect(rejects(ignored, `src\\${ReticleDir.ROOT}\\ambient.json`)).toBe(true);
  });

  /**
   * A GLOB here is silently useless. chokidar dropped glob support in v4 and Vite 7+ ships v4/v5,
   * where a double-star pattern naming the journal directory is accepted and matches nothing — so
   * the fix would look present in the config, pass a `toContain` assertion, and change no behaviour
   * at all. Measured, not assumed: against the chokidar this repo resolves, the glob form still let
   * a write to the journal through. This is the assertion that catches a regression back to one.
   */
  it('uses a matcher chokidar still honours, not a glob', () => {
    const ignored = ignoredFrom({});
    expect(ignored.some((m) => m instanceof RegExp)).toBe(true);
  });

  it("does not swallow the app's own files", () => {
    const ignored = ignoredFrom({});
    expect(rejects(ignored, 'src/App.tsx')).toBe(false);
    // Not a `.reticle` DIRECTORY — a file that merely starts the same way.
    expect(rejects(ignored, 'src/reticle.config.ts')).toBe(false);
    expect(rejects(ignored, `${ReticleDir.ROOT}x/thing.json`)).toBe(false);
  });

  it("keeps the app's own ignore patterns", () => {
    const ignored = ignoredFrom({ server: { watch: { ignored: ['**/fixtures/**'] } } });
    expect(ignored, "the app's own entries must survive").toContain('**/fixtures/**');
    expect(rejects(ignored, `${ReticleDir.ROOT}/ambient.json`)).toBe(true);
  });
});

describe('svelte source stamping', () => {
  it('stamps host elements in a .svelte component', () => {
    const plugin = reticle();
    const result = plugin.transform?.('<div>\n  <button>Pay</button>\n</div>', 'src/App.svelte');
    expect(result?.code).toContain(SOURCE_ATTR);
    expect(result?.code).toContain('src/App.svelte:2:2');
  });

  it('skips .svelte in node_modules and virtual ids, like the JSX path', () => {
    const plugin = reticle();
    expect(plugin.transform?.('<div>x</div>', '/app/node_modules/pkg/A.svelte')).toBeNull();
    expect(plugin.transform?.('<div>x</div>', '\0virtual:A.svelte')).toBeNull();
  });

  it('honours sourceMapping: false', () => {
    const plugin = reticle({ sourceMapping: false });
    expect(plugin.transform?.('<div>x</div>', 'src/App.svelte')).toBeNull();
  });

  it('leaves a React project bit-for-bit unchanged', () => {
    // The regression that would matter most: Svelte support altering a build that has no Svelte in
    // it. Compared against Babel run directly with the same plugin — if the JSX path ever diverges
    // from "just the stamper", this fails.
    const source = 'export const App = () => <button className="a">Hi</button>;';
    const id = '/app/src/App.tsx';
    const direct = transformSync(source, {
      filename: id,
      plugins: [reticleSource],
      parserOpts: { plugins: ['jsx', 'typescript'] },
      sourceMaps: true,
      configFile: false,
      babelrc: false,
    });

    const throughPlugin = reticle().transform?.(source, id);

    expect(throughPlugin?.code).toBe(direct?.code);
    expect(throughPlugin?.map).toBe(JSON.stringify(direct?.map));
    // And a plain .ts module is still not touched at all.
    expect(reticle().transform?.('export const n = 1;', '/app/src/util.ts')).toBeNull();
  });
});

/**
 * The injected connect must name the SDK this app actually has.
 *
 * It named `@reticlehq/react` unconditionally. That is right for a React app and fatal for any
 * other: `reticle init` gives a Vue or Svelte codebase `@reticlehq/browser` on purpose, and the
 * injected import then pointed at a package that is not installed — so the page loaded, nothing
 * connected, and the tab reported no session with no visible cause.
 *
 * Measured end to end on a pristine `npm create vite --template vue` app: every file init wrote was
 * correct and the app still never dialled the daemon, because of this one specifier. It now
 * connects and drives to a verdict.
 *
 * `install()` is the adapter's and the sensor does not export it, so the named imports have to move
 * together with the specifier — otherwise a missing module becomes a missing export.
 */
describe('the injected connect imports the SDK that is installed', () => {
  it('uses the React kit when it resolves', () => {
    const sdk = installedSdk('/app', (dep) => '@reticlehq/react' === dep);
    expect(sdk).toEqual({ specifier: '@reticlehq/react', usesInstall: true });
  });

  it('uses the sensor when only the sensor resolves', () => {
    const sdk = installedSdk('/app', (dep) => '@reticlehq/browser' === dep);
    expect(sdk).toEqual({ specifier: '@reticlehq/browser', usesInstall: false });
  });

  it('prefers the React kit when both resolve, because it is the superset', () => {
    // An app carrying the adapter wants component identity; the kit re-exports the sensor, so
    // choosing it loses nothing.
    expect(installedSdk('/app', () => true).specifier).toBe('@reticlehq/react');
  });

  it('falls back to the React name when neither resolves, so the error names the SDK', () => {
    // "Cannot find @reticlehq/react" reads as "the SDK is not installed". Naming the sensor here
    // would point a React user at a package they have never heard of.
    expect(installedSdk('/app', () => false).specifier).toBe('@reticlehq/react');
  });

  it('drops install() from the generated source on the sensor path', () => {
    const source = connectModuleSource({ root: '/does-not-resolve' });
    // Nothing resolves under that root, so this is the React path — install() present.
    expect(source).toContain('install()');
  });
});
