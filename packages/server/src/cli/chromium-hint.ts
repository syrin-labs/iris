/**
 * A Chromium hint you can satisfy by following it.
 *
 * `npx playwright install chromium` looks obviously right and is quietly wrong. `npx` resolves the
 * LATEST playwright, which pins a different browser revision than the playwright the daemon actually
 * bundles — so the command downloads ~90 MiB of a build the daemon will not use, and the check still
 * says missing afterwards. Reported from the field by an agent whose machine already had five
 * chromium builds, none of them the wanted one, with no way to learn which one was wanted.
 *
 * The same reporter came back, because pinning the command fixes only half of it. Their five builds
 * sat in the standard Windows browsers root and the line still read a flat `missing`, which leaves
 * two readings — "the check is broken" and "none of these count" — and no way to choose. Present at
 * the wrong revision and absent entirely are different problems: one is a single pinned download,
 * the other means the lookup is aimed at a root nothing was ever installed into. Collapsing them is
 * what made the loop unbreakable.
 *
 * Three things fix it, and they are what any unsatisfiable check needs: pin the command to the
 * version doing the asking, say what was probed, and separate the verdicts that have different
 * fixes. The wanted revision and the browsers root are both read back off the path Playwright itself
 * resolves, so `PLAYWRIGHT_BROWSERS_PATH` and every platform default are honoured by construction
 * rather than by a table of roots this file would have to keep in step with Playwright's.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

/** What the check found, gathered by the caller so this stays pure and testable. */
export interface ChromiumProbe {
  /** Executable path the daemon's own playwright resolves to; undefined when playwright is absent. */
  executablePath?: string | undefined;
  /** Whether that path exists on disk. */
  exists: boolean;
  /** Version of the playwright the DAEMON bundles — not whatever `npx` would fetch. */
  playwrightVersion?: string | undefined;
  /** The revision that path names, e.g. `chromium-1223`. Undefined if the path has no revision in it. */
  wantedRevision?: string | undefined;
  /** The browsers root the lookup used, wherever `PLAYWRIGHT_BROWSERS_PATH` and the platform put it. */
  browsersRoot?: string | undefined;
  /** Chromium revisions actually sitting in that root, wanted or not. */
  installedRevisions?: readonly string[] | undefined;
}

/**
 * A browsers-root entry that is a chromium build.
 *
 * Deliberately not matching `chromium_headless_shell-*`: it lives beside the full build and is a
 * different artifact, so counting it would let a root holding only headless shells report the full
 * browser as present-but-mismatched.
 */
const CHROMIUM_DIR = /^chromium-\d+$/;

/** The same directory name as a path segment, on either separator, so Windows paths split too. */
const CHROMIUM_SEGMENT = /[\\/](chromium-\d+)[\\/]/;

/**
 * Pin an `npx playwright <subcommand>` invocation to the playwright the daemon actually bundles.
 *
 * Unpinned is still the right fallback: a wrong-revision download is a bad outcome, but no command
 * at all is a worse one. Shared by `chromiumInstallCommand` and `chromiumInstallDepsCommand`, which
 * differ only in the subcommand they need pinned.
 */
function pinnedPlaywrightCommand(subcommand: string, playwrightVersion?: string): string {
  const pin = playwrightVersion === undefined ? 'playwright' : `playwright@${playwrightVersion}`;
  return `npx ${pin} ${subcommand}`;
}

/** The install command, pinned when we know what to pin to. */
export function chromiumInstallCommand(playwrightVersion?: string): string {
  return pinnedPlaywrightCommand('install chromium', playwrightVersion);
}

/**
 * The install-deps command, pinned the same way `chromiumInstallCommand` is.
 *
 * A missing OS shared library (e.g. `libnspr4.so`) is a different failure from a missing browser
 * binary: the binary is already there, but Playwright's own host-requirement check refuses to launch
 * it. `npx playwright install chromium` does nothing for that case — the fix is `install-deps`, and
 * it needs the same pin for the same reason: unpinned, `npx` can resolve a different playwright than
 * the one the daemon bundles.
 */
export function chromiumInstallDepsCommand(playwrightVersion?: string): string {
  return pinnedPlaywrightCommand('install-deps chromium', playwrightVersion);
}

/**
 * Split a resolved executable path into the browsers root and the revision under it, or null.
 *
 * Reading them back off Playwright's own answer is the point. The alternative is reconstructing the
 * root from `PLAYWRIGHT_BROWSERS_PATH` plus a per-platform default, which is a copy of Playwright's
 * resolution rules that drifts the first time they change one — and getting it wrong here means
 * telling a user their browsers are missing while looking in the wrong directory, which is the exact
 * failure this file exists to stop.
 */
export function parseChromiumRevision(
  executablePath: string,
): { revision: string; root: string } | null {
  const match = CHROMIUM_SEGMENT.exec(executablePath);
  if (null === match) return null;
  const revision = match[1];
  if (revision === undefined) return null;
  return { revision, root: executablePath.slice(0, match.index) };
}

/** Chromium revisions present in a browsers root. Empty on an unreadable or absent root. */
function installedRevisions(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((entry) => CHROMIUM_DIR.test(entry))
      .sort();
  } catch {
    // No root at all is the commonest case here and is not an error: it means nothing was installed.
    return [];
  }
}

/**
 * Ask the playwright THIS process would use, not the one `npx` would fetch.
 *
 * `executablePath()` resolves the revision the daemon will actually launch AND the root it will look
 * in, which is why the probe never reads `PLAYWRIGHT_BROWSERS_PATH` itself.
 */
export async function probeChromium(): Promise<ChromiumProbe> {
  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    const parsed = parseChromiumRevision(executablePath);
    return {
      executablePath,
      exists: existsSync(executablePath),
      playwrightVersion: bundledPlaywrightVersion(),
      ...(null === parsed
        ? {}
        : {
            wantedRevision: parsed.revision,
            browsersRoot: parsed.root,
            installedRevisions: installedRevisions(parsed.root),
          }),
    };
  } catch {
    // Playwright itself is absent — a different problem from a missing browser, and the hint says so.
    return { exists: false };
  }
}

/** The bundled playwright's version, or undefined if it cannot be read (the hint then goes unpinned). */
export function bundledPlaywrightVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg: unknown = require('playwright/package.json');
    if ('object' === typeof pkg && null !== pkg && 'version' in pkg) {
      const { version } = pkg;
      if ('string' === typeof version) return version;
    }
  } catch {
    /* an unreadable package.json is not worth failing a diagnostic over */
  }
  return undefined;
}

/** The doctor line for the Chromium check — verdict, what was probed, and how to satisfy it. */
export function chromiumHint(probe: ChromiumProbe): string {
  if (probe.exists) {
    // Naming the revision on the happy line too: it is the number the mismatch line talks about, and
    // a reader comparing two machines has nothing to compare without it.
    return probe.wantedRevision === undefined
      ? '✓ installed'
      : `✓ installed (${probe.wantedRevision})`;
  }
  const command = chromiumInstallCommand(probe.playwrightVersion);
  if (probe.executablePath === undefined) {
    return `✗ the playwright package is not installed; run: ${command}`;
  }
  const present = probe.installedRevisions ?? [];
  if (present.length > 0 && probe.wantedRevision !== undefined) {
    // The reported machine. Every fact here is one the reader could not otherwise get: what is
    // wanted, what is there, and where "there" is. `npx playwright install chromium` unpinned adds
    // a build to this list and changes nothing, which is what happened.
    return (
      `✗ wrong revision — the bundled playwright wants ${probe.wantedRevision}; ` +
      `${probe.browsersRoot ?? ''} holds ${present.join(', ')}. run: ${command}`
    );
  }
  // Naming the path is what turns "missing" from a verdict into evidence: a reader with browsers on
  // disk can see immediately whether this is a missing install or a lookup pointed somewhere else
  // (PLAYWRIGHT_BROWSERS_PATH, a different browsers root, a revision bump).
  return `✗ missing — looked for ${probe.executablePath}; run: ${command}`;
}
