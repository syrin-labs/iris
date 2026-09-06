/**
 * Node-side questions about what is actually installed in the app.
 *
 * All three answer "what is on disk right now" rather than "what does the plugin do", and each exists
 * because guessing was wrong in a way that reached a user: a declared-but-absent dependency logs a
 * resolve failure on every boot, an unnoticed SDK change leaves stale code in the browser, and an
 * unreported version makes a skewed pair surface as a bare -32000.
 *
 * All three resolve from the APP ROOT, never from this file. The SDK is the user's dependency and
 * deliberately not one of this plugin's, so a resolve based on `import.meta.url` walks the PLUGIN's
 * node_modules — which under pnpm's strict layout does not contain the SDK at all. Every one of these
 * then fell into its own catch and returned the "not installed" answer: no `sdkVersion` on the HELLO,
 * a CONSTANT build fingerprint (so Vite never re-bundled a changed SDK — the exact stale-bundle
 * false-negative the fingerprint exists to prevent), and no optimizeDeps entry for the SDK itself.
 * Silently, for every pnpm user, with no error anywhere.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';

/** The React kit the host app imports the SDK from. Mirrors the constant in index.ts. */
const RETICLE_PACKAGE = '@reticlehq/react';

/** How far up from the resolved entry to look for the manifest beside it. */
const MANIFEST_SEARCH_DEPTH = 5;

/**
 * A `require` rooted at the app rather than at this plugin. `from` is Vite's `config.root`; the
 * `process.cwd()` default matches how Vite itself defaults the root when the config omits it.
 */
function requireFromApp(from: string): NodeJS.Require {
  const absoluteFrom = isAbsolute(from) ? from : resolve(process.cwd(), from);
  return createRequire(join(absoluteFrom, 'package.json'));
}

/**
 * Whether a package can be resolved from the app. Used to avoid declaring an optimizeDeps entry for
 * something the app does not have, which Vite reports as a resolve failure on every boot.
 */
export function isResolvable(specifier: string, from: string = process.cwd()): boolean {
  try {
    requireFromApp(from).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory holding `specifier`'s own manifest, resolved from `from`. Null when it is not there.
 *
 * Resolves the entry and walks up to the manifest beside it rather than requiring
 * `<pkg>/package.json` directly: a package with an `exports` map may refuse that subpath, and our
 * own packages do.
 */
function packageDirOf(specifier: string, from: string): string | null {
  try {
    let dir = dirname(requireFromApp(from).resolve(specifier));
    for (let up = 0; up < MANIFEST_SEARCH_DEPTH; up++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (parsed.name === specifier) return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable from here — the caller's next chain, or nothing.
  }
  return null;
}

/**
 * Vite's nested include form — `a > b > c` — for a chain that fully resolves, else null.
 *
 * A single-segment chain is just the bare specifier, so this also answers "can the app see it
 * itself". Each further segment is resolved from the PREVIOUS package's directory, which is what
 * Vite does with the `>` form and the only way to name a dependency the app root cannot see under
 * pnpm or npm's nested layout. SvelteKit ships `svelte > clsx` for the same reason.
 */
export function resolvableChain(chain: readonly string[], from: string): string | null {
  let base = from;
  for (const segment of chain) {
    const dir = packageDirOf(segment, base);
    if (null === dir) return null;
    base = dir;
  }
  return 0 === chain.length ? null : chain.join(' > ');
}

/** The installed SDK's package version, for the HELLO's `sdkVersion`. Node-side only. */
export function sdkPackageVersion(from: string = process.cwd()): string {
  const require_ = requireFromApp(from);
  // Preferred: the package exports its own manifest. Newer SDKs do.
  try {
    const pkg = require_(`${RETICLE_PACKAGE}/package.json`) as { version?: string };
    if ('string' === typeof pkg.version) return pkg.version;
  } catch {
    // Falls through — see below.
  }
  // Fallback, and it is load-bearing rather than defensive: an OLDER SDK has no `./package.json`
  // in its exports map, and an older SDK is precisely the skew we are trying to name. Resolve the
  // main entry instead and walk up to the manifest beside it.
  try {
    let dir = dirname(require_.resolve(RETICLE_PACKAGE));
    for (let up = 0; up < MANIFEST_SEARCH_DEPTH; up++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if ('string' === typeof parsed.version) return parsed.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable (not installed yet, exotic layout) — report nothing rather than guessing.
  }
  return '';
}

/**
 * A fingerprint of the installed SDK build, mixed into `optimizeDeps` so Vite re-bundles when the
 * SDK changes.
 *
 * Vite's dep-optimizer cache is keyed on the `optimizeDeps` config and the lockfile — NOT on the
 * contents of the packages it bundled. Upgrade the SDK in place (a patched dist, a linked checkout,
 * an overlay) and the version in `package.json` can stay the same, so Vite keeps serving the OLD
 * pre-bundled copy out of `node_modules/.vite` across dev-server restarts. The fix you just shipped
 * is simply not in the browser, and it looks like the fix does not work. That cost a real
 * false-negative during this bug hunt, and every user upgrading in place hits the same thing.
 *
 * Size+mtime is enough: it changes whenever the bundle does and costs one `stat`.
 */
export function sdkBuildFingerprint(from: string = process.cwd()): string {
  try {
    const entry = requireFromApp(from).resolve(RETICLE_PACKAGE);
    const { size, mtimeMs } = statSync(entry);
    return `${String(size)}-${String(Math.trunc(mtimeMs))}`;
  } catch {
    // Unresolvable (not installed yet, exotic layout) — a constant is still correct, just inert.
    return 'unknown';
  }
}

/**
 * The installed Vite's major version, or null when it cannot be read.
 *
 * Asked from the APP's root, never the plugin's: the plugin and the app can resolve different Vites
 * in a monorepo, and the one whose deprecation warnings the user sees is the app's.
 */
export function viteMajor(from: string = process.cwd()): number | null {
  try {
    const pkg = requireFromApp(from)('vite/package.json') as { version?: string };
    const major = parseInt((pkg.version ?? '').split('.')[0] ?? '', 10);
    return isNaN(major) ? null : major;
  } catch {
    return null;
  }
}

/** Vite renamed the dep-optimizer's passthrough options when it moved to rolldown. */
export const OPTIMIZER_OPTIONS_KEY = {
  ESBUILD: 'esbuildOptions',
  ROLLDOWN: 'rolldownOptions',
} as const;
type OptimizerOptionsKey = (typeof OPTIMIZER_OPTIONS_KEY)[keyof typeof OPTIMIZER_OPTIONS_KEY];

/**
 * Which key carries optimizer options on this Vite.
 *
 * Vite 7 moved the dep optimizer to rolldown and deprecated `optimizeDeps.esbuildOptions`, warning
 * on every boot to use `rolldownOptions` instead — a warning attributed to whichever plugin set it,
 * which is us. Unknown versions get the older key: a deprecation notice is a much smaller failure
 * than an option the installed Vite has never heard of.
 */
export function optimizerOptionsKey(major: number | null): OptimizerOptionsKey {
  return null !== major && 7 <= major
    ? OPTIMIZER_OPTIONS_KEY.ROLLDOWN
    : OPTIMIZER_OPTIONS_KEY.ESBUILD;
}

/**
 * The optimizer options object, with `define` where THIS bundler will accept it.
 *
 * esbuild reads `define` from the top level of its options. Rolldown does not — it rejects the key
 * outright and reads defines from `transform.define` instead. Vite 8 surfaces that as a warning on
 * every dev boot, attributed to whichever plugin set the option:
 *
 *   Warning: Invalid input options (1 issue found)
 *   - For the "define". Invalid key: Expected never but received "define".
 *
 * The app still ran, which is why this survived: the option was dropped, `__RETICLE_SDK_BUILD__`
 * stopped participating in the optimizer cache key, and the only visible symptom was a warning with
 * Reticle's name on it. Reported by a user on vite@8.0.16.
 *
 * An inherited top-level `define` is MOVED rather than dropped on the rolldown path — it is the
 * app's own, it meant something, and passing it through unchanged is what produced the warning.
 */
export function optimizerOptions(
  key: OptimizerOptionsKey,
  inherited: Record<string, unknown>,
  add: Record<string, string>,
): Record<string, unknown> {
  const inheritedDefine = (inherited['define'] ?? {}) as Record<string, string>;
  if (OPTIMIZER_OPTIONS_KEY.ROLLDOWN !== key) {
    return { ...inherited, define: { ...inheritedDefine, ...add } };
  }
  const { define: _moved, ...rest } = inherited;
  const transform = (inherited['transform'] ?? {}) as Record<string, unknown>;
  const transformDefine = (transform['define'] ?? {}) as Record<string, string>;
  return {
    ...rest,
    transform: { ...transform, define: { ...inheritedDefine, ...transformDefine, ...add } },
  };
}
