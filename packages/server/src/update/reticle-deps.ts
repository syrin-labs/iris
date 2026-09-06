/**
 * The `@reticlehq/*` packages a project actually declares.
 *
 * Shared by `reticle update` (which syncs them) and the version-skew remedy (which names them).
 * Lives here, not in `init/`, so the daemon library path can read a package.json without pulling
 * the installer in behind it.
 */

/** Everything we publish is scoped here. */
const RETICLE_SCOPE = '@reticlehq/';
/**
 * The CLI. Never an app dependency: it carries the Node MCP server and `ws`, and putting it in a
 * browser app's tree is what the retired `@reticlehq/core` umbrella got wrong.
 */
const SERVER_PACKAGE = '@reticlehq/server';

function namesIn(section: unknown): string[] {
  if ('object' !== typeof section || null === section) return [];
  return Object.keys(section);
}

/** The Reticle packages this project declares, from either dependency section. */
export function reticleDepsOf(pkgJson: unknown): string[] {
  if ('object' !== typeof pkgJson || null === pkgJson) return [];
  const manifest = pkgJson as Record<string, unknown>;
  const declared = [...namesIn(manifest['dependencies']), ...namesIn(manifest['devDependencies'])];
  return [...new Set(declared)].filter(
    (name) => name.startsWith(RETICLE_SCOPE) && name !== SERVER_PACKAGE,
  );
}
