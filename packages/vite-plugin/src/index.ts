import { existsSync, readFileSync } from 'node:fs';
import { missingTokenWarning } from './missing-token.js';
import { ensurePairingToken } from './ensure-token.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from '@babel/core';
import reticleSource from '@reticlehq/babel-plugin';
import {
  RETICLE_DEFAULT_PORT,
  RETICLE_RENDER_PREHOOK,
  bridgeWsUrl,
  ReticleDir,
  ReticleEnv,
  RETICLE_ROOT_GLOBAL,
  RETICLE_SDK_VERSION_GLOBAL,
} from '@reticlehq/core';
import { resolveProjectId } from './project-id.js';
import { discoverDaemonPort } from './discover-port.js';
import { announceDevServer } from './announce.js';
import { SVELTE_FILE, stampSvelte } from './svelte-source.js';
import {
  resolvableChain,
  sdkPackageVersion,
  sdkBuildFingerprint,
  viteMajor,
  optimizerOptionsKey,
  optimizerOptions,
} from './installed.js';

export const RETICLE_VITE_PLUGIN_NAME = 'reticle';

// The React kit the host app imports the SDK from. It re-exports the browser sensor, so a single
// specifier yields both `reticle` (connect) and `install` (the React adapter). NOT `@reticlehq/core`
// — that is the isomorphic foundation and exports neither.
const RETICLE_PACKAGE = '@reticlehq/react';
/** The framework-neutral sensor, which a Vue or Svelte app gets instead. See installedSdk. */
const RETICLE_SENSOR = '@reticlehq/browser';
/**
 * Compile-time global carrying the daemon's pairing token, for connects the plugin does not write
 * itself. The bridge requires the token even on localhost, and nothing in a browser can read the
 * file it lives in.
 */
export const RETICLE_TOKEN_GLOBAL = '__RETICLE_TOKEN__';

/** Files we stamp with source info — JSX/TSX only. */
const JSX_FILE = /\.[jt]sx$/;
/** Rollup virtual-module ids start with a NUL byte; never transform those. */
const VIRTUAL_PREFIX = '\0';
const NODE_MODULES = 'node_modules';

/**
 * The connect code is served as a real module (not an inline <script>) so that Vite's import
 * pipeline resolves the bare `@reticlehq/react` specifier. An inline injected script is NOT run through
 * import resolution, so its bare import would fail in the browser. This path-like id is requested
 * by the injected <script src> and served by the load hook below.
 */
export const RETICLE_CONNECT_MODULE = '/@reticle-connect';

/**
 * The URL the injected `<script src>` must actually point at: `base` + the module id.
 *
 * {@link RETICLE_CONNECT_MODULE} is a SERVER-ROOT path, and emitting it verbatim is only correct
 * when Vite is serving from the root. Under `base: '/playground/'` the browser asked for
 * `/@reticle-connect`, Vite answered 404 with its own "did you mean /playground/@reticle-connect"
 * hint, and the page rendered perfectly while never connecting (#676) — the exact failure shape
 * Reticle exists to catch, in Reticle's own setup path.
 *
 * Vite does not prefix tags returned from `transformIndexHtml`, so the prefix has to be applied
 * here. Only a path base is joined: Vite serves the dev app from the root when `base` is an
 * external URL, so prefixing a CDN origin onto a dev-server module would point the tag off-host.
 */
export function connectModuleUrl(base: string | undefined): string {
  if (undefined === base || !base.startsWith('/')) return RETICLE_CONNECT_MODULE;
  // Trimmed by slicing rather than with `/\/+$/`: a trailing-slash-run regex is a polynomial
  // backtracking shape over a value that comes out of the user's config, and CodeQL is right to
  // flag it. This is linear and says the same thing.
  let end = base.length;
  while (0 < end && '/' === base[end - 1]) end -= 1;
  const trimmed = base.slice(0, end);
  return 0 === trimmed.length ? RETICLE_CONNECT_MODULE : `${trimmed}${RETICLE_CONNECT_MODULE}`;
}

/**
 * The pre-hook, as source for an inline <head> script.
 *
 * Deliberately dependency-free ES5 in a try/catch: it runs before anything else on the page, so it
 * must not assume a bundler, a module system, or that React is present at all. It installs a faithful
 * devtools hook (React calls `inject` and expects a renderer id back, and stores the renderer) and
 * counts commits into a buffer the module-side meter adopts later.
 */
export const RENDER_PREHOOK_SOURCE = `(function(){try{
var K='__REACT_DEVTOOLS_GLOBAL_HOOK__',P='${RETICLE_RENDER_PREHOOK}';
if(globalThis[P])return;
var B={commits:0,sinks:[]};
globalThis[P]=B;
var fire=function(){B.commits++;for(var i=0;i<B.sinks.length;i++){try{B.sinks[i].apply(null,arguments);}catch(e){}}};
var h=globalThis[K];
if(h===undefined){
globalThis[K]={supportsFiber:true,renderers:new Map(),inject:function(r){var id=this.renderers.size+1;this.renderers.set(id,r);return id;},
onScheduleFiberRoot:function(){},onCommitFiberRoot:fire,onPostCommitFiberRoot:function(){},onCommitFiberUnmount:function(){}};
}else{var prev=h.onCommitFiberRoot;h.onCommitFiberRoot=function(){try{fire.apply(null,arguments);}catch(e){}
if(typeof prev==='function')return prev.apply(this,arguments);};}
}catch(e){}})();`;

/**
 * How long after serving the HTML to wait before concluding the entry was never injected.
 *
 * Generous on purpose: the browser has to request the entry, and a cold dev server transforming a
 * large app can take a moment. A false warning would train people to ignore a real one.
 */
const DEV_INJECTION_GRACE_MS = 10_000;

/**
 * How many times the connect module's source may legitimately change in one dev-server session
 * before the plugin says so.
 *
 * The source is a function of the port, the projectId, the pairing token and whether the app has a
 * `reticle-dev` module. In a healthy session that settles almost immediately: the daemon starting
 * after Vite is one change, a dev module being created is another. Anything past a handful means
 * an input is oscillating, and an oscillating connect module is what makes Vite re-resolve it on
 * every page load — the reload loop this counter exists to make audible instead of mysterious.
 */
const CONNECT_CHURN_LIMIT = 5;

/**
 * Said ONCE, and it names the symptom the user is looking at rather than the mechanism, because the
 * mechanism is invisible from a browser: the page reloads and nothing explains why.
 */
export const connectChurnWarning = (): string =>
  `[${RETICLE_VITE_PLUGIN_NAME}] the injected connect module has changed ${String(CONNECT_CHURN_LIMIT)} ` +
  'times in one dev-server session. Something it depends on (the bridge port, the pairing token, ' +
  'or a reticle-dev module appearing and disappearing) is not settling, and that can make the page ' +
  'reload repeatedly. Reticle will keep serving the newest version. Please report this at ' +
  'https://github.com/ReticleHQ/reticle/issues with your vite.config and whether more than one ' +
  'daemon is running (`npx @reticlehq/server status`).';

export interface ReticleVitePluginOptions {
  /** Bridge WebSocket port. Defaults to the SDK default; only baked into connect when non-default. */
  port?: number;
  /**
   * Project root, so React's absolute `_debugSource.fileName` reports repo-relative. Resolved from
   * the Vite config at injection time; set it only to override.
   */
  root?: string;
  /**
   * The installed SDK's version, so a pair skewed against the daemon can name itself instead of
   * surfacing as a bare -32000. Read from the installed package; set it only to override.
   */
  sdkVersion?: string;
  /** Stable session label for the bridge. Defaults to the SDK's auto-generated id. */
  session?: string;
  /**
   * Stable project identity. Defaults to one derived from the app's package.json name + root path,
   * so multi-project session scoping works with zero config. Override only for special setups.
   */
  projectId?: string;
  /** Auth token forwarded to connect when the bridge requires one. */
  token?: string;
  /** Stamp data-reticle-source for React 19 source mapping. Default true (harmless on React <=18). */
  sourceMapping?: boolean;
  /** Auto-inject the dev-gated reticle.connect call. Default true. */
  inject?: boolean;
  /**
   * This build is an Electron/Tauri renderer. Changes two things a desktop shell needs and a web app
   * must not get:
   *
   *  - The plugin also applies to `vite build`. A packaged desktop renderer IS a production build
   *    loaded from `file://` or a custom protocol — there is no dev server — so the default
   *    `apply: 'serve'` drops the plugin entirely and the app ships with no `connect()` at all.
   *  - `connect()` is called with `allowInProduction`, because that same renderer reports
   *    NODE_ENV=production and the SDK's prod backstop would otherwise refuse to start.
   *
   * Off by default and never inferred: turning it on means an instrumented production BUNDLE, which
   * is exactly what a web app must never ship. Keep it behind your own dev-only build (a dev target,
   * or `process.env.NODE_ENV !== 'production'` in vite.config) so it cannot reach a release binary.
   */
  desktop?: boolean;
  /**
   * Record request/response BODIES on `reticle_network`, not just method/url/status.
   *
   * Off by default because a body is the one part of a request that routinely carries a card
   * number, a token or a customer's address, and the daemon journals what it is told.
   *
   * It matters that this is reachable at all. The SDK has supported `captureNetworkBodies` on
   * `connect()` since bodies existed, but the plugin — the documented one-line integration, and the
   * only `connect()` most apps ever have — had no way to pass it, and calling `connect()` a second
   * time is a no-op. So for every app wired the recommended way, a payload was unreachable: on a
   * real payments dashboard, a refund POSTing `amount: 1187.01` into a paise field (a 100x
   * under-refund) was visible to Playwright's request inspector and invisible here.
   *
   * Also settable as `VITE_RETICLE_CAPTURE_BODIES=1`, so it can be turned on for one debugging
   * session without editing vite.config.
   */
  captureNetworkBodies?: boolean;
  /**
   * Make Reticle's OWN presenter visible to snapshots and queries. CONTRIBUTORS ONLY.
   *
   * Reachable here for the same reason `captureNetworkBodies` is: the plugin is the only `connect()`
   * most apps ever have, so an SDK option the plugin cannot pass is an option that does not exist.
   *
   * The presenter is hidden from every tool by design — an agent that can drive Reticle's own
   * interface can fabricate its own impact report. The cost is that a HUD change is the only kind of
   * change Reticle cannot be used to check. This is the hatch for that one case, and the app reports
   * it in its capabilities so a verdict drawn with it open is never mistaken for an ordinary one.
   *
   * Also settable as `VITE_RETICLE_EXPOSE_PRESENTER=1`.
   */
  exposePresenter?: boolean;
  /**
   * Let Reticle run when the page or the bridge is not on localhost.
   *
   * Off by default: the SDK refuses outside localhost so a page on the open internet cannot be
   * instrumented by a bridge it happened to reach. Turn it on for a dev server that CANNOT be served
   * on localhost — a host-based multi-tenant frontend, a white-label app resolving the tenant from
   * the `Host` header, anything with cookie-scoped auth on a custom dev hostname. Without it those
   * apps cannot use Reticle at all, because the plugin is the only `connect()` they have and a
   * second, hand-written one is a no-op.
   *
   * NOT SUFFICIENT ON ITS OWN — a pairing token is also required. `connectionPolicy` in
   * `@reticlehq/browser` refuses a non-localhost connect with "a pairing token is required outside
   * localhost" whenever the token is missing or empty, whatever this flag says. The plugin supplies
   * one automatically from the daemon's `~/.reticle/pairing-token` (see readPairingToken), so a
   * started daemon is normally all it takes; pass `token` yourself only when the daemon's file is
   * unreachable. A non-loopback BRIDGE additionally has to be `wss://`.
   *
   * Also settable as `VITE_RETICLE_ALLOW_NON_LOCALHOST=1`, so it can be turned on for one session
   * without editing vite.config.
   */
  allowNonLocalhost?: boolean;
  /**
   * Where a diagnostic goes. Defaults to the console; injected so the dev-mode injection check is
   * testable without capturing global console output.
   */
  onWarn?: (message: string) => void;
}

/** Structural Vite plugin shape — avoids a hard dependency on `vite` while staying assignable to its `Plugin`. */
export interface ReticleVitePlugin {
  name: string;
  /**
   * Vite's `config` hook. Used to declare the SDK's CJS runtime deps for pre-bundling — see the
   * implementation for why omitting them makes the whole SDK fail to load on linked setups.
   */
  config?: (config: {
    optimizeDeps?: {
      include?: string[];
      /** Whichever key the app used — the plugin reads both and writes the one this Vite wants. */
      esbuildOptions?: Record<string, unknown>;
      rolldownOptions?: Record<string, unknown>;
    };
    define?: Record<string, string>;
    root?: string;
    server?: { watch?: { ignored?: (string | RegExp)[] } };
  }) => {
    optimizeDeps: {
      include: string[];
      // Either `esbuildOptions` or `rolldownOptions`, chosen from the installed Vite's major — v7
      // deprecated the former and warns on every boot, blaming the plugin that set it. Typed as an
      // index signature because the key is computed; the shape under it is the same either way.
      [optionsKey: string]: unknown;
    };
    define: Record<string, string>;
    server: { watch: { ignored: (string | RegExp)[] } };
  };
  /** Absent in desktop mode, where the plugin must also run for `vite build`. */
  apply?: 'serve';
  enforce: 'pre';
  transform: (code: string, id: string) => { code: string; map: string | null } | null;
  resolveId: (id: string, importer?: string) => string | null;
  load: (id: string) => string | null;
  transformIndexHtml: (html: string) => HtmlTag[];
  /** Vite hands over the resolved config; used to resolve the HTML entry exactly. */
  configResolved?: (config: { root?: string; command?: string; base?: string }) => void;
  /** Dev-server hook: keeps the served connect module from outliving the token it was built without. */
  configureServer?: (server: ViteDevServerLike) => void;
  /** Build-time post-condition: desktop injection must have happened. */
  buildEnd?: () => void;
  /** Runs the dev-mode injection check immediately. Test seam for the deferred timer. */
  checkInjectedForTest?: () => void;
}

/**
 * The slice of Vite's dev server this plugin touches, structurally — so `vite` stays a peer the
 * plugin never imports, the same way the Svelte compiler and Playwright are handled elsewhere.
 */
export interface ViteDevServerLike {
  /**
   * Vite's own HTTP server, for the port it ACTUALLY bound and the moment it bound it. Optional and
   * nullable because middleware mode has none — and because a structural stand-in that demands more
   * than Vite guarantees stops being assignable, which red-builds every typechecked config.
   */
  httpServer?: {
    once(event: string, listener: () => void): unknown;
    address(): string | { port: number } | null;
  } | null;
  /**
   * The URLs Vite prints on boot. Read rather than assembled: host, protocol and base are all
   * configurable, so composing a URL here would be a guess about the one thing the dev server can
   * simply be asked.
   */
  resolvedUrls?: { local: string[]; network: string[] } | null;
  middlewares: {
    // METHOD syntax throughout, deliberately. A property-style `(mod: object) => void` is checked
    // strictly (contravariantly) in its parameters, so widening a parameter to `object` makes the
    // type HARDER to satisfy, not easier — and Vite's real server stops being assignable, which
    // red-builds every project that typechecks its config. Methods are checked bivariantly, which is
    // the latitude a structural stand-in is asking for in the first place. See
    // vite-types-assignable.test.ts, which fails at `tsc` if this drifts back.
    use(handler: (req: { url?: string | undefined }, res: unknown, next: () => void) => void): void;
  };
  moduleGraph: {
    getModuleById(id: string): object | undefined;
    invalidateModule(mod: object): void;
  };
}

interface HtmlTag {
  tag: string;
  /** Absent on an inline script, which carries its source in `children` instead. */
  attrs?: Record<string, string>;
  /** Inline source, for a tag that has no `src`. */
  children?: string;
  /** `head-prepend` is required for the render pre-hook: it must run before any module script. */
  injectTo: 'body' | 'head-prepend';
}

/**
 * Is this resolved module id the one the HTML referenced?
 *
 * `resolveId` sees the specifier (`/src/main.tsx`); `transform` sees the absolute path
 * (`/Users/me/app/src/main.tsx`). A suffix match is what bridges them. Any query suffix
 * (`?html-proxy`, `?t=...`) is stripped first so a re-transformed module still matches.
 */
function isHtmlEntry(id: string, specifier: string | undefined, root: string | undefined): boolean {
  if (specifier === undefined) return false;
  const clean = (value: string): string => value.split('?')[0] ?? value;
  const target = clean(specifier);
  const candidate = clean(id);
  if (candidate === target) return true;
  // EXACT when the resolved root is known: Vite reports the HTML's script as a root-relative
  // specifier (`/src/main.tsx`) while `transform` sees the absolute path, and joining the two is a
  // real resolution rather than a guess. Suffix matching alone would also inject into
  // `/other/src/main.tsx`, a different file that merely ends the same way.
  if (root !== undefined && target.startsWith('/')) {
    return candidate === `${root.replace(/\/$/, '')}${target}`;
  }
  // Fallback for the rare case Vite never reported a root — still better than not injecting, and the
  // buildEnd post-condition means a wrong match cannot pass unnoticed as "nothing happened".
  return candidate.endsWith(target.startsWith('/') ? target : `/${target}`);
}

/** A module id we may stamp at all: not virtual, not a dependency. Extension decides which stamper. */
function stampableId(id: string): string | null {
  if (id.startsWith(VIRTUAL_PREFIX)) return null;
  if (id.includes(NODE_MODULES)) return null;
  // Strip any query suffix (?worker, ?raw,...) before matching the extension.
  return id.split('?')[0] ?? id;
}

function shouldStamp(id: string): boolean {
  const clean = stampableId(id);
  return clean !== null && JSX_FILE.test(clean);
}

/** A `.svelte` single-file component, which needs the Svelte stamper rather than Babel. */
function shouldStampSvelte(id: string): boolean {
  const clean = stampableId(id);
  return clean !== null && SVELTE_FILE.test(clean);
}

function stamp(code: string, id: string): { code: string; map: string | null } | null {
  const out = transformSync(code, {
    filename: id,
    plugins: [reticleSource],
    parserOpts: { plugins: ['jsx', 'typescript'] },
    sourceMaps: true,
    configFile: false,
    babelrc: false,
  });
  if (out?.code === undefined || null === out.code) return null;
  return {
    code: out.code,
    map: out.map === undefined || null === out.map ? null : JSON.stringify(out.map),
  };
}

/**
 * Read the daemon's auto-provisioned pairing token (~/.reticle/pairing-token, or the
 * RETICLE_PAIRING_TOKEN_DIR override) so the served app can present it. Node-side only — a browser
 * sandbox can't read the file, which is exactly why a rogue localhost app can't forge it. Best-effort:
 * undefined if the daemon hasn't started yet (the page reloads once it has). Exported for testing.
 */
export function readPairingToken(): string | undefined {
  const override = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  const dir =
    override !== undefined && override.length > 0 ? override : join(homedir(), ReticleDir.ROOT);
  // Read-or-CREATE, matching the daemon. Reading alone meant a dev server started before the daemon
  // baked in an empty token and every page it served was refused — with the SDK loading and the
  // socket opening, so nothing looked broken. See ensure-token for the bisect.
  return ensurePairingToken(dir);
}

/**
 * Pass the token through, saying so once when it is absent.
 *
 * Warned HERE rather than at connect time because this is the moment the value is frozen: by the
 * time the app is refused, the empty string was inlined minutes ago and restarting the dev server is
 * the only fix. Once per config resolve, so a watch-mode rebuild does not repeat it.
 */
let tokenWarned = false;
function warnIfTokenMissing(token: string | undefined): string | undefined {
  const warning = missingTokenWarning(token);
  if (warning !== undefined && !tokenWarned) {
    tokenWarned = true;
    console.warn(warning);
  }
  return token;
}

/** Build the `reticle.connect` argument literal — only includes keys the user set. */
function connectArgs(options: ReticleVitePluginOptions): string {
  const args: Record<string, string | number | boolean> = {};
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  if (port !== RETICLE_DEFAULT_PORT) args['url'] = bridgeWsUrl(port);
  if (options.session !== undefined) args['session'] = options.session;
  if (options.projectId !== undefined) args['projectId'] = options.projectId;
  if (options.token !== undefined) args['token'] = options.token;
  // Passed as connect ARGUMENTS, not as a `define`. A define substitutes a bare identifier in the
  // source it transforms; the SDK reads these as `globalThis[NAME]`, a dynamic lookup no define can
  // ever reach — so defining them looked right, shipped, and did nothing. Baking them into the
  // generated connect call is a literal in generated source: no bundler subtleties, works the same
  // in dev and in a desktop build.
  if (options.root !== undefined && options.root.length > 0) args['root'] = options.root;
  if (options.sdkVersion !== undefined && options.sdkVersion.length > 0) {
    args['sdkVersion'] = options.sdkVersion;
  }
  // A desktop renderer is a production build by construction; without this the SDK's prod backstop
  // refuses to connect and the app is silently uninstrumented.
  if (true === options.desktop) args['allowInProduction'] = true;
  // Env wins nothing — it only turns the flag ON, so a config that never set it can still be
  // switched on for one debugging session without editing vite.config and restarting the mental
  // model with it.
  if (true === options.captureNetworkBodies || '1' === process.env['VITE_RETICLE_CAPTURE_BODIES']) {
    args['captureNetworkBodies'] = true;
  }
  // Same shape, same reason. Off unless asked for, in a config or for one session.
  if (true === options.exposePresenter || '1' === process.env['VITE_RETICLE_EXPOSE_PRESENTER']) {
    args['exposePresenter'] = true;
  }
  // Same shape, same reason: without it an app that cannot be served on localhost has no way to
  // reach the SDK option at all. The pairing token still applies — see the option's docstring.
  if (
    true === options.allowNonLocalhost ||
    '1' === process.env['VITE_RETICLE_ALLOW_NON_LOCALHOST']
  ) {
    args['allowNonLocalhost'] = true;
  }
  return Object.keys(args).length > 0 ? JSON.stringify(args) : '';
}

/** The body of the connect module — real imports, resolved by Vite when the module is served. */
/**
 * The conventional app-side dev module: `registerStore` / `registerCapabilities` live here.
 *
 * It is imported by CONVENTION rather than by patching the app's entry file. The connect is injected
 * into a virtual module, so there is nowhere for a user to add these calls without `init` editing
 * `src/main.tsx` — an edit to the file people actually own, for something that is opt-in enrichment.
 * Convention costs one `existsSync` and leaves their entry untouched.
 */
export const RETICLE_DEV_MODULE_CANDIDATES = [
  'src/reticle-dev.ts',
  'src/reticle-dev.js',
  'src/reticle-dev.tsx',
  'src/reticle-dev.jsx',
] as const;

/** The app's dev module, as an importable path — or null when the app has none. */
export function findDevModule(root: string, exists: (p: string) => boolean): string | null {
  for (const rel of RETICLE_DEV_MODULE_CANDIDATES) {
    if (exists(`${root}/${rel}`)) return `/${rel}`;
  }
  return null;
}

/**
 * Which SDK package this app actually has, and whether `install()` applies.
 *
 * The injected connect used to name `@reticlehq/react` unconditionally. That is right for a React
 * app and fatal for any other: `reticle init` gives a Vue or Svelte codebase the framework-neutral
 * `@reticlehq/browser` — deliberately, because a package named `@reticlehq/react` with `react` in
 * its peers has no business in a Vue app — and the injected import then names a package that is not
 * installed, so nothing connects and the page reports no session with no obvious cause.
 *
 * Measured end to end on a pristine `npm create vite --template vue` app: init wrote every file
 * correctly and the tab never dialled the daemon, because of this one specifier.
 *
 * The React kit WINS when both resolve: it is a superset (it re-exports the sensor and adds the
 * adapter), so an app that has it wants component identity. `install()` is the adapter's alone and
 * the sensor does not export it — naming it against the sensor would trade a missing module for a
 * missing export.
 */
export function installedSdk(
  appRoot: string,
  canResolve: (dep: string) => boolean = (dep) => null !== resolvableChain([dep], appRoot),
): { specifier: string; usesInstall: boolean } {
  try {
    const pkgPath = join(appRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps[RETICLE_SENSOR] !== undefined && deps[RETICLE_PACKAGE] === undefined) {
        return { specifier: RETICLE_SENSOR, usesInstall: false };
      }
      if (deps[RETICLE_PACKAGE] !== undefined) {
        return { specifier: RETICLE_PACKAGE, usesInstall: true };
      }
    }
  } catch {
    // Ignore read or parse failures when checking dependencies
  }

  if (canResolve(RETICLE_PACKAGE)) return { specifier: RETICLE_PACKAGE, usesInstall: true };
  if (canResolve(RETICLE_SENSOR)) return { specifier: RETICLE_SENSOR, usesInstall: false };
  // Neither resolves: keep the historical name so the failure reads as "the SDK is not installed"
  // rather than as a package nobody recognises.
  return { specifier: RETICLE_PACKAGE, usesInstall: true };
}

export function connectModuleSource(
  options: ReticleVitePluginOptions,
  devModule: string | null = null,
): string {
  const args = connectArgs(options);
  const sdk = installedSdk(options.root ?? process.cwd());
  const named = sdk.usesInstall ? 'reticle, install' : 'reticle';
  const call = sdk.usesInstall ? 'install();\n' : '';
  // The only place in a Vite app that can see hot updates. `import.meta.hot` exists per module and
  // only for modules Vite serves through its own transform; the SDK is a dependency, pre-bundled by
  // the optimizer, and gets no hot context however it is written — so the channel is handed to it
  // from here and the SDK owns everything after that (including which events it cares about).
  // Guarded, because a desktop build has no dev server and therefore no hot context at all.
  const hot = `if (import.meta.hot) reticle.observeHotUpdates(import.meta.hot);\n`;
  const base = `import { ${named} } from '${sdk.specifier}';\n${call}reticle.connect(${args});\n${hot}`;
  // AFTER connect: registerStore subscribes through the live SDK, and registering before there is a
  // session to report into drops the first diffs.
  return null === devModule ? base : `${base}import('${devModule}');\n`;
}

/**
 * Reticle Vite plugin. Add to your `plugins` array and the entire integration is done:
 *
 * import { reticle } from '@reticlehq/vite-plugin';
 * export default defineConfig({ plugins: [react(), reticle()] });
 *
 * `apply: 'serve'` means Vite drops the plugin entirely from `vite build`, so a web production
 * bundle is never instrumented — gating is the tool's job, not a user-managed env check.
 *
 * `desktop: true` is the ONE documented exception, and it inverts that guarantee deliberately: a
 * packaged Electron/Tauri renderer IS a production build with no dev server, so serve-only gating
 * would ship an app with no connect() at all. The cost is that the flag hands gating back to the
 * caller — keep it behind your own dev-only build target so an instrumented bundle can never reach
 * a release binary.
 */
/**
 * The daemon's journal directory, as a matcher every chokidar major honours.
 *
 * Exported so the one regression test can assert on the matcher itself rather than on a string that
 * looked right and matched nothing.
 */
export const JOURNAL_IGNORE = new RegExp(
  `(^|[\\\\/])${ReticleDir.ROOT.replace('.', '\\.')}([\\\\/]|$)`,
);

export function reticle(options: ReticleVitePluginOptions = {}): ReticleVitePlugin {
  const sourceMapping = options.sourceMapping !== false;
  const inject = options.inject !== false;
  const desktop = true === options.desktop;
  // Resolve the stable projectId once (explicit option, else derived from package.json + cwd) so the
  // app is identifiable across port changes with zero config.
  const resolved: ReticleVitePluginOptions = {
    ...options,
    projectId: resolveProjectId(options.projectId, process.cwd()),
  };
  /**
   * The specifier the HTML points at, e.g. `/src/main.tsx`.
   *
   * Stored UNRESOLVED, because that is what `resolveId` receives — while `transform` is handed the
   * absolute resolved path. Comparing the two directly never matches, and the failure is silent:
   * the bundle simply ships with no connect() in it. Hence `isHtmlEntry`'s suffix comparison.
   */
  let htmlEntrySpecifier: string | undefined;
  /** Vite's resolved project root, for exact entry resolution. Undefined until configResolved. */
  let root: string | undefined;
  /** 'serve' | 'build'. The dev check only applies to serve; buildEnd covers the other. */
  let command: string | undefined;
  /** Vite's resolved `base`. Undefined until configResolved, which is before any HTML is served. */
  let base: string | undefined;
  const warn = options.onWarn ?? ((message: string) => globalThis.console.warn(message));
  /** Whether connect() actually reached a module — asserted at buildEnd, never assumed. */
  let injected = false;
  /**
   * Resolve port + token at the moment of injection, not at plugin construction. By the time a
   * module is served or built the daemon is up and has written its pairing token; resolving early
   * would bake in `undefined` and the app would fail auth on every connect.
   */
  const resolveLazy = (): ReticleVitePluginOptions => {
    const port = resolved.port ?? discoverDaemonPort(resolved.projectId);
    const withPort = port !== undefined ? { ...resolved, port } : resolved;
    const token = withPort.token ?? readPairingToken();
    const withToken = token !== undefined ? { ...withPort, token } : withPort;
    // Resolved here for the same reason as the token: these are Node-side facts about the installed
    // tree, and they travel in the generated connect call rather than through a `define`.
    const appRoot = withToken.root ?? root ?? process.cwd();
    const sdkVersion = withToken.sdkVersion ?? sdkPackageVersion(appRoot);
    return { ...withToken, root: appRoot, sdkVersion };
  };
  /**
   * The connect module's source as it would be served RIGHT NOW. Recomputed rather than cached: the
   * daemon's token and the app's dev module can both appear after the dev server started, which is
   * the whole reason the module is re-read at all.
   */
  const currentConnectSource = (): string =>
    connectModuleSource(resolveLazy(), root === undefined ? null : findDevModule(root, existsSync));
  /** The source `load` last handed to Vite, or undefined before the first serve. */
  let lastServedConnectSource: string | undefined;
  /** How many times the served source has actually changed. See connectChurnWarning. */
  let connectChanges = 0;
  /**
   * The BUILD message. A build always runs every transform, so "my transform never ran" and "the
   * bundle has no connect()" are the same statement there, and stating it as a certainty is correct.
   */
  const notInjectedMessage = (): string =>
    `[${RETICLE_VITE_PLUGIN_NAME}] could not inject reticle.connect(): the HTML entry module was ` +
    'never matched, so this app carries no instrumentation and will never connect. Check that ' +
    'index.html references your entry with a <script type="module" src="...">, or pass ' +
    '`inject: false` and call reticle.connect({ token: __RETICLE_TOKEN__ }) yourself. The plugin ' +
    'still inlines that define; a connect without it is refused.';

  /**
   * The DEV message, which must be weaker — and this is the whole reason the two are separate.
   *
   * In serve, `injected` records "my transform ran THIS session", which is not the same as "the app
   * has no connect()". Vite serves an unchanged module straight from its transform cache, so on a
   * warm cache the transform never runs, the flag stays false, and the old wording announced that
   * the app "will never connect" while the served entry demonstrably contained the injection —
   * verified by fetching it from the dev server. A false alarm, in the tool whose entire argument is
   * that it does not raise them.
   *
   * So dev reports what it actually knows: unconfirmed, with the benign explanation first.
   */
  const unconfirmedInjectionMessage = (): string =>
    `[${RETICLE_VITE_PLUGIN_NAME}] could not confirm reticle.connect() was injected: the HTML entry ` +
    'module was not transformed this session. That is expected when Vite served it from its ' +
    'transform cache. If the app does not appear in `reticle status`, restart the dev server with ' +
    '`--force` to bypass the cache, then check that index.html references your entry with a ' +
    '<script type="module" src="...">.';

  /** Warn (never throw) in dev — a running dev server should report the doubt, not die of it. */
  const checkInjected = (): void => {
    if (!desktop || !inject || injected) return;
    warn(unconfirmedInjectionMessage());
  };

  return {
    name: RETICLE_VITE_PLUGIN_NAME,
    // Web: serve-only, so a production bundle can never carry the SDK — gating is the tool's job.
    // Desktop: a packaged renderer IS a production build with no dev server, so the plugin must also
    // run for `vite build` or the shipped app has no connect() at all.
    ...(true === options.desktop ? {} : { apply: 'serve' as const }),
    enforce: 'pre',
    /**
     * Declare the SDK itself and the optimizer cache fingerprint.
     *
     * The browser SDK used to need extra CJS query-engine deps here. It no longer imports that
     * second accessibility engine, so keeping those names would make Vite pre-bundle packages the
     * app may not have and blame Reticle for a false `Failed to resolve dependency` warning.
     */
    config(config: {
      optimizeDeps?: {
        include?: string[];
        esbuildOptions?: Record<string, unknown>;
        rolldownOptions?: Record<string, unknown>;
      };
      define?: Record<string, string>;
      /** Vite's UserConfig root; undefined means the cwd. `configResolved` runs too late for this. */
      root?: string;
      /** The app's own watcher config; its `ignored` list is preserved, never replaced. */
      server?: { watch?: { ignored?: (string | RegExp)[] } };
    }) {
      // Everything below asks what the APP has installed, so every lookup is rooted here and never
      // at the plugin's own location. Vite defaults an omitted root to the cwd; so do we.
      const appRoot = config.root ?? process.cwd();
      const optimizerKey = optimizerOptionsKey(viteMajor(appRoot));
      return {
        // Keep the daemon's journal out of the dev server's watcher.
        //
        // The daemon writes `.reticle/` into the PROJECT root — session journals, and `ambient.json`
        // rewritten atomically as `ambient.json.tmp` + rename on a live session. Vite watches the
        // project root and does not ignore that directory, so every journal write read as a project
        // file changing and Vite answered with a full page reload.
        //
        // That is a loop with no exit: page loads -> SDK connects and streams events -> daemon
        // journals them -> Vite reloads the page -> SDK reconnects -> more events. It ran several
        // times a second for as long as the dev server was up, and the damage was total but
        // misattributed: every ref went stale, every act_and_wait died mid-flight, and the log
        // filled with connect/disconnect pairs that looked like a flapping SDK rather than a
        // watcher chasing its own tail.
        //
        // A RegExp, not a glob, and that is the whole difference between this working and not.
        // chokidar dropped glob support in v4 — Vite 7+ ships v4/v5, where a pattern like
        // `**/.reticle/**` is silently accepted and matches nothing. MEASURED against the chokidar
        // this repo resolves: with the glob, a write to `.reticle/ambient.json` still fires; with
        // this RegExp it does not, while a normal file still does. Vite's own defaults are globs and
        // have the same problem, which is why it is not safe to copy their shape here.
        //
        // Anchored on `^` or a separator so it matches the directory and not a file that merely ends
        // in those characters, and both separators are accepted because chokidar reports the path in
        // the platform's own form.
        //
        // Appends to the app's list rather than replacing it, so nothing it already excluded is lost.
        server: {
          watch: {
            ignored: [...(config.server?.watch?.ignored ?? []), JOURNAL_IGNORE],
          },
        },
        // Expose the daemon's pairing token to hand-written connects in the same Vite app. The
        // plugin's own injected connect gets the token directly, but a connect the USER writes —
        // SvelteKit's client hook, a custom entry — had no way to reach a file only Node can read,
        // so it called connect() with no credential and the bridge answered "authentication
        // failed". Empty until the daemon has provisioned one; the page reloads once it has.
        define: {
          ...(config.define ?? {}),
          [RETICLE_TOKEN_GLOBAL]: JSON.stringify(warnIfTokenMissing(readPairingToken()) ?? ''),
          // Lets the SDK report React's absolute `_debugSource.fileName` as a repo-relative path,
          // so source looks the same whichever React version an app is on.
          // Kept for HAND-WRITTEN connects (SvelteKit's hook, a custom entry): those live in app
          // source, where a define does substitute. The plugin's own injected connect passes both as
          // arguments instead — see connectArgs.
          [RETICLE_ROOT_GLOBAL]: JSON.stringify(appRoot),
          [RETICLE_SDK_VERSION_GLOBAL]: JSON.stringify(sdkPackageVersion(appRoot)),
        },
        optimizeDeps: {
          // Part of the cache key, not of the build: changing it is what makes Vite notice that the
          // SDK on disk is not the SDK it pre-bundled. See sdkBuildFingerprint.
          //
          // Under the key THIS Vite wants. Vite 7 moved the optimizer to rolldown and deprecated
          // `esbuildOptions`, warning on every boot — a warning attributed to the plugin that set
          // it, which is us.
          // Inherited from whichever key the app used, and `define` placed where this bundler will
          // take it — rolldown refuses it at the top level. See optimizerOptions.
          [optimizerKey]: optimizerOptions(
            optimizerKey,
            {
              ...(config.optimizeDeps?.esbuildOptions ?? {}),
              ...(config.optimizeDeps?.rolldownOptions ?? {}),
            },
            { __RETICLE_SDK_BUILD__: JSON.stringify(sdkBuildFingerprint(appRoot)) },
          ),
          include: [
            ...(config.optimizeDeps?.include ?? []),
            // The SDK ITSELF. Without this, Vite does not learn about @reticlehq/react until the
            // injected connect module is requested — mid-flight, on the very first page load. It
            // then pre-bundles it and forces a full reload, and the connect is lost in that reload:
            // no WebSocket, no session, no console message. The FIRST load after `reticle init` —
            // the one the whole product is judged on — silently did nothing, and it worked on the
            // next refresh, which is the worst possible shape for a bug like this.
            //
            // Whichever SDK this app actually has: naming `@reticlehq/react` in a Vue app that was
            // given the sensor produces the exact boot warning the note below is about, for a
            // package that is correctly absent.
            installedSdk(appRoot).specifier,
          ],
        },
      };
    },
    transform(code, id) {
      // Desktop injection: prepend connect() to the HTML's own entry module. It is a REAL module, so
      // its bare `@reticlehq/react` import resolves through the normal pipeline in both dev and
      // build — which a virtual <script src> only ever did in dev.
      if (desktop && inject && isHtmlEntry(id, htmlEntrySpecifier, root)) {
        injected = true;
        const withConnect = `${connectModuleSource(resolveLazy())}\n${code}`;
        const stamped = sourceMapping && shouldStamp(id) ? stamp(withConnect, id) : null;
        return stamped ?? { code: withConnect, map: null };
      }
      if (!sourceMapping) return null;
      // `.svelte` runs on the RAW component source, which is only still markup because this plugin
      // declares `enforce: 'pre'` and therefore transforms before @sveltejs/vite-plugin-svelte. No
      // map: the insertions are within a line and never move one, and a wrong map is worse than none.
      if (shouldStampSvelte(id)) {
        const stamped = stampSvelte(code, id);
        return null === stamped ? null : { code: stamped, map: null };
      }
      if (!shouldStamp(id)) return null;
      return stamp(code, id);
    },
    resolveId(id, importer) {
      // Desktop: remember the module the HTML points at, so `transform` can prepend connect() into
      // it. A packaged build has no dev server, so the serve-time trick below — a <script src> at a
      // virtual URL — would emit a tag pointing at a file that does not exist. That shipped an app
      // with a dead script and NO instrumentation, which is worse than not injecting at all.
      // `includes`, not `endsWith`: in a BUILD Vite rewrites the html entry through an html-proxy
      // id (`/index.html?html-proxy&index=0.js`), so an endsWith check silently never matches and
      // nothing is injected — which is exactly how this shipped a bundle with no connect() in it.
      if (desktop && inject && importer !== undefined && importer.includes('.html')) {
        htmlEntrySpecifier = id;
      }
      // Return the id verbatim so Vite serves it back to load (the bare imports inside it then
      // go through normal resolution). No NUL prefix: the browser requests it as a URL.
      return inject && id === RETICLE_CONNECT_MODULE ? RETICLE_CONNECT_MODULE : null;
    },
    load(id) {
      if (!inject || id !== RETICLE_CONNECT_MODULE) return null;
      const source = currentConnectSource();
      lastServedConnectSource = source;
      return source;
    },
    configResolved(config) {
      root = config.root;
      command = config.command;
      base = config.base;
    },
    /**
     * Serve the connect module fresh, every time.
     *
     * `load` reads the daemon's pairing token at serve time precisely because the daemon may start
     * after the dev server — but Vite caches the module it produced, and answers every later request
     * from that cache, INCLUDING after a full page reload. So a dev server started first served a
     * tokenless connect module once and then kept serving it: the SDK got a 1008 `authentication
     * failed`, stopped retrying (correctly — a wrong token does not fix itself), and `reticle status`
     * showed no session while the page demonstrably contained `/@reticle-connect`. Only restarting
     * the dev server cleared it, which is not a step anybody guesses.
     *
     * Dropping the cached module before it is served makes `load` re-read the token, so starting the
     * daemon and reloading the page is enough.
     *
     * Only when the source would ACTUALLY differ, though. This used to invalidate on every request
     * for the module, forever — and a module that is force-invalidated on every request is
     * re-resolved against Vite's dep optimizer on every page load, which is the shape of a
     * self-sustaining reload loop: reload → request → invalidate → re-resolve → reload. Reported
     * from the field on a Vite + React Router app pinned to a non-default port: every route
     * reloaded the whole page about once a second, `/@reticle-connect` was fetched in every cycle,
     * and removing the plugin stopped it instantly. Comparing the source first costs one string
     * compare, keeps the late-daemon fix intact (the token appearing IS a change), and makes the
     * module inert once it has settled.
     */
    configureServer(server) {
      if (!inject) return;
      // Tell `~/.reticle` this dev server exists, the moment it is actually listening.
      //
      // This is the one fact nobody outside this process could observe: the plugin is loaded in the
      // dev server that is RUNNING, not merely present in a config file on disk. Its absence is the
      // commonest setup failure there is — a plugin added to a config the running server already
      // read — and until now that failure was indistinguishable from every other one.
      //
      // Deliberately reads the port and URL off the server rather than composing them. The port may
      // be `strictPort: false` and have moved, the host and base are configurable, and every one of
      // those is something the user can change under us.
      const announce = (): void => {
        const address = server.httpServer?.address();
        const port =
          'object' === typeof address && null !== address && undefined !== address
            ? address.port
            : undefined;
        if (undefined === port) return;
        const opts = resolveLazy();
        const withdraw = announceDevServer({
          port,
          pid: process.pid,
          root: opts.root ?? process.cwd(),
          url: server.resolvedUrls?.local[0] ?? `http://localhost:${String(port)}/`,
          ...(opts.sdkVersion === undefined || 0 === opts.sdkVersion.length
            ? {}
            : { sdkVersion: opts.sdkVersion }),
          startedAt: Date.now(),
          ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
        });
        server.httpServer?.once('close', withdraw);
        // `close` does not fire on Ctrl-C, which is how a dev server usually dies. The read side
        // checks liveness anyway, so a missed withdrawal degrades rather than lies — these just
        // keep the directory tidy in the cases we can catch.
        process.once('exit', withdraw);
        process.once('SIGINT', withdraw);
        process.once('SIGTERM', withdraw);
      };
      // Already bound in some setups (middleware mode, a restart), not yet in the common one.
      if (null === server.httpServer?.address() || undefined === server.httpServer?.address()) {
        server.httpServer?.once('listening', announce);
      } else {
        announce();
      }
      server.middlewares.use((req, _res, next) => {
        // Matched against BOTH forms: plugin middlewares run ahead of Vite's own base
        // middleware, so the request still carries `base` here, while a middleware-mode host may
        // have stripped it already.
        const requestPath = (req.url ?? '').split('?')[0];
        if (requestPath === RETICLE_CONNECT_MODULE || requestPath === connectModuleUrl(base)) {
          if (currentConnectSource() !== lastServedConnectSource) {
            connectChanges++;
            if (CONNECT_CHURN_LIMIT === connectChanges) warn(connectChurnWarning());
            const mod = server.moduleGraph.getModuleById(RETICLE_CONNECT_MODULE);
            if (mod !== undefined) server.moduleGraph.invalidateModule(mod);
          }
        }
        next();
      });
    },
    /**
     * Desktop injection is silent when it misses — the bundle simply has no connect() in it and the
     * app looks wired while reporting nothing. That happened twice while this was being built. A
     * build that could not instrument must fail loudly instead of shipping a binary that lies.
     */
    buildEnd() {
      if (!desktop || !inject || injected) return;
      throw new Error(notInjectedMessage());
    },
    checkInjectedForTest: checkInjected,
    transformIndexHtml() {
      // In serve, the HTML is sent BEFORE the browser requests the entry module, so the check has to
      // be deferred — asserting here would fire on every healthy start. Unref'd so a dev server is
      // never held open by it.
      if (desktop && inject && 'serve' === command) {
        const timer = setTimeout(checkInjected, DEV_INJECTION_GRACE_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      // Desktop injects via the entry module instead (see transform) — a tag here would be a dead
      // URL in a packaged build.
      if (!inject || desktop) return [];
      return [
        // A CLASSIC inline script in <head>, and it has to be both.
        //
        // React reads `__REACT_DEVTOOLS_GLOBAL_HOOK__` when its renderer injects — which happens as
        // soon as react-dom evaluates. A `type="module"` script runs in document order AFTER the
        // app's entry module, so the connect module below can never install the hook in time.
        // Measured on two independent Vite apps: the hook existed with our callback attached and
        // `renderers.size === 0`, so the render meter counted zero forever while the docs advertised
        // commit counts. This runs during parse, before any module, and the meter adopts its buffer.
        { tag: 'script', children: RENDER_PREHOOK_SOURCE, injectTo: 'head-prepend' },
        { tag: 'script', attrs: { type: 'module', src: connectModuleUrl(base) }, injectTo: 'body' },
      ];
    },
  };
}
