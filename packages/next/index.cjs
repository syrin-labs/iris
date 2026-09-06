'use strict';
// withReticle(nextConfig): adds a dev-only webpack pre-loader that stamps data-reticle-source on
// your JSX so @reticlehq/react can report the source file:line — without disabling SWC. It also
// forwards the daemon's auto-provisioned pairing token to the client so a manual reticle.connect()
// can present it (the bridge requires the token even on localhost).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Kept in sync with @reticlehq/core (ReticleDir / ReticleEnv). This package is plain CJS tooling and
// deliberately has no ESM/TS dependency on core, so the two constants are mirrored here.
const PAIRING_TOKEN_DIR_ENV = 'RETICLE_PAIRING_TOKEN_DIR';
const PAIRING_TOKEN_FILE = 'pairing-token';
const RETICLE_CONFIG_FILE = '.reticle.json';
const RETICLE_HOME_DIR = '.reticle';
// Mirrors core's daemonRegistryFileName: ~/.reticle/daemon-<port>.json.
const DAEMON_ENTRY_PREFIX = 'daemon-';
const DAEMON_ENTRY_SUFFIX = '.json';
// Mirrors core's RETICLE_CLIENT_HOST / RETICLE_WS_PATH. This package is plain CJS tooling with no
// ESM/TS dependency on core, so the values are duplicated here the way the constants above are — and
// pinned to core's by test, because a URL that drifts produces a silent no-connect rather than an
// error anybody sees.
const RETICLE_CLIENT_HOST = 'localhost';
const RETICLE_WS_PATH = '/reticle';

/**
 * Read the pairing token, or create it — whichever process gets there first.
 *
 * The token used to be read ONCE, when next.config was evaluated. Start `next dev` before the
 * daemon and that value was empty, every page was refused, and a reload could not help: there was
 * no token page-side to pick up. The comment that claimed "the client then connects without a token
 * and the page reloads once it has" was false for Next.
 *
 * Same mint as the daemon (24 random bytes, 0600 file, never overwrite). An existing token is
 * reused so a plugin-injected page keeps working after the daemon bounces.
 * @param {string} dir
 * @returns {string | undefined}
 */
function ensurePairingToken(dir) {
  const file = path.join(dir, PAIRING_TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Read or mint the daemon's auto-provisioned pairing token (~/.reticle/pairing-token, or the
 * RETICLE_PAIRING_TOKEN_DIR override). Node-side only. Minting here is what makes `next dev` before
 * the daemon still authenticate.
 * @returns {string | undefined}
 */
function readPairingToken() {
  return ensurePairingToken(reticleHomeDir());
}

/**
 * Find the live daemon serving THIS project and return its websocket URL.
 *
 * The Vite plugin has always done this (`discoverDaemonPort`), and core's `pickDaemonPort` documents
 * the rule as shared by "both the vite and next plugins" — but this package never implemented the
 * next half. The consequence was a frozen port: `reticle init` baked `url: 'ws://localhost:<port>'`
 * into the generated ReticleDev component at install time, and the app dialled that forever. Move the
 * daemon and a Next app silently dials a port nothing is listening on, with no error anywhere except
 * a console warning in a browser nobody is watching.
 *
 * The rule is core's, mirrored rather than imported for the same reason the constants above are: this
 * package is plain CJS tooling with no ESM/TS dependency on core. Kept deliberately identical:
 *   1. drop dead daemons (crashed, or a stale entry left by a kill -9);
 *   2. among the living, prefer a projectId match, lowest port on a tie;
 *   3. return undefined when nothing matches, so the app falls back to the default port rather than
 *      auto-connecting to a daemon serving a DIFFERENT project — a wrong connect is worse than an
 *      honest default, because it reports another app's state as this one's.
 *
 * The projectId is READ from `.reticle.json` rather than re-derived. Re-deriving would duplicate
 * core's slug + hash rule in a third place, and a drift there does not fail loudly: it silently
 * matches no daemon, which is the exact bug this function exists to remove.
 * @returns {string | undefined}
 */
/**
 * Where Reticle keeps its per-user state: the pairing token AND the daemon registry.
 *
 * Honours the same RETICLE_PAIRING_TOKEN_DIR override the token reader uses, because it is the same
 * directory. One override rather than two keeps a test (or a sandbox) from pointing the two halves at
 * different places and getting a token from one daemon with the port of another.
 */
function reticleHomeDir() {
  const override = process.env[PAIRING_TOKEN_DIR_ENV];
  return override !== undefined && override.length > 0
    ? override
    : path.join(os.homedir(), RETICLE_HOME_DIR);
}

/** process.kill(pid, 0) throws iff the process is gone: the same liveness probe the daemon uses. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function discoverDaemonUrl(cwd = process.cwd(), home = reticleHomeDir(), alive = defaultIsAlive) {
  let projectId;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, RETICLE_CONFIG_FILE), 'utf8'));
    projectId = typeof parsed?.projectId === 'string' ? parsed.projectId : undefined;
  } catch {
    return undefined; // no .reticle.json: this project has not been through `reticle init`
  }
  if (projectId === undefined || projectId.length === 0) return undefined;
  const dir = home;
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined; // no ~/.reticle yet: no daemon has ever run here
  }
  const ports = [];
  for (const file of files) {
    if (!file.startsWith(DAEMON_ENTRY_PREFIX) || !file.endsWith(DAEMON_ENTRY_SUFFIX)) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // a half-written or corrupt entry is not a daemon
    }
    if (entry?.projectId !== projectId) continue;
    if (typeof entry.port !== 'number' || typeof entry.pid !== 'number') continue;
    if (!alive(entry.pid)) continue;
    ports.push(entry.port);
  }
  if (ports.length === 0) return undefined;
  return `ws://${RETICLE_CLIENT_HOST}:${String(Math.min(...ports))}${RETICLE_WS_PATH}`;
}

/**
 * The stamping loader, addressed by package export so both bundlers can resolve it. Turbopack takes
 * loaders by module id, not by absolute path.
 */
const LOADER_MODULE = '@reticlehq/next/loader';

/**
 * The top-level `turbopack` config key is stable from Next 15.3; before that it was
 * `experimental.turbo`, and an unknown top-level key makes Next print an "Invalid next.config.js
 * options detected" warning on every boot. Older Next also defaults to webpack, so it does not need
 * the key at all — emitting it would be pure noise in somebody's terminal.
 * @returns {boolean}
 */
function supportsTurbopackKey() {
  try {
    const { version } = require('next/package.json');
    const [major, minor] = String(version)
      .split('.')
      .map((n) => parseInt(n, 10));
    if (!Number.isFinite(major)) return true; // unreadable version: assume modern, matching npm's default
    if (major > 15) return true;
    return major === 15 && Number.isFinite(minor) && minor >= 3;
  } catch {
    return true;
  }
}

/**
 * Turbopack rules mirroring the webpack pre-loader.
 *
 * Next 16 made Turbopack the DEFAULT, and a config carrying a `webpack` key with no `turbopack` key
 * is a hard startup error there ("This build is using Turbopack, with a webpack config and no
 * turbopack config") — so `withReticle` killed `next dev` outright for every new Next app. Emitting
 * both keys means whichever bundler is running finds its own wiring and neither errors on the other.
 * @param {Record<string, unknown> | undefined} existing
 */
function turbopackConfig(existing) {
  const rule = { loaders: [LOADER_MODULE] };
  const prev = existing !== undefined && existing !== null ? existing : {};
  const prevRules = prev.rules !== undefined && prev.rules !== null ? prev.rules : {};
  return {
    ...prev,
    rules: {
      ...prevRules,
      // No `as:` — the loader only stamps attributes, so the module type is unchanged. Naming the
      // type here makes Turbopack rewrite the module id (./x.tsx → ./x.tsx.tsx) and every import breaks.
      '*.tsx': rule,
      '*.jsx': rule,
    },
  };
}

/**
 * The React kit the host app imports the SDK from. Deliberately NOT a dependency of this package —
 * it is the user's own install, probed for its version and nothing else. Declaring it here would
 * force the React adapter onto every Next user, including the ones who never import it.
 */
const RETICLE_SDK_PACKAGE = '@reticlehq/react';

/** How far up from the resolved entry to look for the manifest beside it. */
const MANIFEST_SEARCH_DEPTH = 5;

/**
 * Resolve from the APP, not from this file. `next.config.js` is loaded with cwd at the project root,
 * where the user's `@reticlehq/react` always is. A bare `require` resolves relative to THIS package
 * instead, and since the SDK is deliberately not a dependency here, that lookup fails outright under
 * pnpm's strict node_modules layout — silently, into a `catch` that returns ''. Every pnpm Next user
 * therefore reported no `sdkVersion`, which is the one value that turns a skewed pair into a named
 * mismatch rather than a bare -32000.
 * @param {string} specifier
 * @returns {string}
 */
function resolveFromApp(specifier) {
  return require.resolve(specifier, { paths: [process.cwd()] });
}

/**
 * The installed SDK's package version, for the HELLO's `sdkVersion`. Mirrors
 * `@reticlehq/vite-plugin`'s `sdkPackageVersion` — this package is plain CJS tooling with no
 * dependency on the TS packages, so the logic is duplicated rather than imported.
 * @returns {string}
 */
function sdkPackageVersion() {
  // Preferred: the package exports its own manifest. Newer SDKs do.
  try {
    const { version } = require(resolveFromApp(`${RETICLE_SDK_PACKAGE}/package.json`));
    if (typeof version === 'string') return version;
  } catch {
    // Falls through — see below.
  }
  // Fallback, and it is load-bearing rather than defensive: an OLDER SDK has no `./package.json` in
  // its exports map, and an older SDK is precisely the skew this value exists to name.
  try {
    let dir = path.dirname(resolveFromApp(RETICLE_SDK_PACKAGE));
    for (let up = 0; up < MANIFEST_SEARCH_DEPTH; up++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const { version } = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof version === 'string') return version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable (not installed, exotic layout) — report nothing rather than guessing.
  }
  return '';
}

/**
 * @param {import('next').NextConfig} [nextConfig]
 * @returns {import('next').NextConfig}
 */
function withReticle(nextConfig = {}) {
  // Production builds are untouched — this is a dev-time aid only.
  if (process.env.NODE_ENV === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  const token = readPairingToken();
  const daemonUrl = discoverDaemonUrl();
  return {
    ...nextConfig,
    ...(supportsTurbopackKey() ? { turbopack: turbopackConfig(nextConfig.turbopack) } : {}),
    // Expose the token to the client bundle as process.env.NEXT_PUBLIC_RETICLE_TOKEN (Next's convention
    // for client-readable env), so a dev-only client connect can present it. Minted here if the file
    // is missing: Next evaluates this once, so an empty value is frozen and a reload cannot pick a
    // later token up. Omitted only when the directory is unwritable.
    env: {
      ...nextConfig.env,
      ...(token !== undefined ? { NEXT_PUBLIC_RETICLE_TOKEN: token } : {}),
      // The project root, so the SDK can report React's absolute `_debugSource.fileName` as a
      // repo-relative path. Passed via `env` rather than a webpack DefinePlugin because Turbopack — the
      // Next 16 default — never runs the webpack branch, and a source pointer that only works on one
      // of the two bundlers is worse than one that works on neither.
      NEXT_PUBLIC_RETICLE_ROOT: process.cwd(),
      // The daemon serving THIS project, discovered on every dev-server start rather than baked in
      // at install time. Without it the generated connect keeps whatever port `init` happened to see,
      // and a daemon that later moves is unreachable with no error the user ever sees.
      ...(daemonUrl !== undefined ? { NEXT_PUBLIC_RETICLE_URL: daemonUrl } : {}),
      // So a version-skewed pair can name itself instead of surfacing as a bare -32000.
      NEXT_PUBLIC_RETICLE_SDK_VERSION: sdkPackageVersion(),
    },
    webpack(config, ctx) {
      config.module = config.module || { rules: [] };
      config.module.rules = config.module.rules || [];
      config.module.rules.push({
        test: /\.(t|j)sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: require.resolve('./loader.cjs') }],
      });
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}

module.exports = { withReticle, readPairingToken, discoverDaemonUrl };
