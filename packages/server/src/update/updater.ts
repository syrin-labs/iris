import { execFile } from 'node:child_process';
import { NodePlatform } from '../platform.js';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { loadManifest, saveManifest } from './update-checker.js';
import { RETICLE_NPM_PACKAGE, SERVER_VERSION } from '../version/server-version.js';
import { log } from '../log.js';
import { TelemetryEventKind } from '@reticlehq/core';
import { getTelemetry } from '../telemetry/telemetry.js';
import { wasNudged } from './nudge-credit.js';

/** Which way the installed version moved. A rollback means a release hurt someone enough to retreat. */
const VersionChangeDirection = {
  UPDATE: 'update',
  ROLLBACK: 'rollback',
} as const;
type VersionChangeDirection = (typeof VersionChangeDirection)[keyof typeof VersionChangeDirection];

/**
 * Report a completed version move. Never throws — an install that worked must still be reported done.
 *
 * Exported so the emit path can be exercised directly: `applyUpdate`/`rollback` both run a real npm
 * install and then `process.exit`, so there is no way to reach this through them in a test without
 * mocking the package manager and the process itself.
 */
export async function reportVersionChange(
  from: string,
  to: string,
  direction: VersionChangeDirection,
): Promise<void> {
  try {
    const nudged = wasNudged(to);
    await getTelemetry().emit(TelemetryEventKind.VERSION_CHANGED, {
      // Only when true: an absent flag reads as "we do not know", which is honest for a machine that
      // updated from a shell script or a package bump with no agent involved at all.
      versionChange: { from, to, direction, ...(nudged ? { nudged } : {}) },
    });
  } catch {
    /* best-effort, like every other send */
  }
}

const NPM_BIN = NodePlatform.WINDOWS === platform() ? 'npm.cmd' : 'npm';
const NPM_TIMEOUT_MS = 120_000;

/** How this reticle process was launched — determines which npm strategy to use for updates. */
const ExecutionKind = {
  /** Launched via `npx @reticlehq/server` — npm re-resolves the package on restart. */
  NPX: 'npx',
  /** Installed globally via `npm install -g`. */
  GLOBAL: 'global',
  /** Installed as a local project dependency. */
  LOCAL: 'local',
} as const;
type ExecutionKind = (typeof ExecutionKind)[keyof typeof ExecutionKind];

/**
 * Infer how reticle was launched from process.argv[1].
 *
 * npm's npx cache stores packages under a path containing `_npx`, which is the
 * most reliable cross-platform signal. Local installs always live inside a
 * `node_modules` directory. Everything else is treated as a global install.
 */
function detectExecutionKind(): ExecutionKind {
  return classifyExecutionKind(process.argv[1] ?? '');
}

/**
 * Classify a launch from the entry script path. Pure so it's testable. Global installs ALSO live under
 * a `node_modules`, but under the npm global prefix — a `lib/node_modules` (unix: /usr/local, Homebrew,
 * nvm) or AppData\npm (Windows). Match those FIRST, otherwise a global install is misread as local and
 * `apply_update` npm-installs into the user's own project (polluting their package.json).
 */
export function classifyExecutionKind(script: string): ExecutionKind {
  if (script.includes('/_npx/') || script.includes('\\_npx\\')) return ExecutionKind.NPX;
  const globalSignals = [
    '/lib/node_modules/',
    '\\npm\\node_modules\\',
    '/.nvm/',
    '/homebrew/',
    '/usr/local/',
    '/usr/lib/',
  ];
  if (globalSignals.some((s) => script.includes(s))) return ExecutionKind.GLOBAL;
  if (script.includes('/node_modules/') || script.includes('\\node_modules\\')) {
    return ExecutionKind.LOCAL;
  }
  return ExecutionKind.GLOBAL;
}

/** Walk up from cwd until a directory containing package.json is found. */
function findLocalProjectRoot(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

interface RunNpmOptions {
  cwd?: string;
}

function runNpm(args: string[], opts: RunNpmOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      NPM_BIN,
      args,
      { timeout: NPM_TIMEOUT_MS, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) },
      (err, _stdout, stderr) => {
        if (err !== null) {
          reject(
            new Error(`npm ${args.join(' ')} failed: ${stderr !== '' ? stderr : err.message}`),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

interface NpmInstall {
  args: string[];
  cwd?: string;
}

/**
 * The npm argv (and optional cwd) that installs `version` for the given launch kind, or null for
 * npx (which re-resolves the package on the next restart — no install needed). Installs
 * `@reticlehq/server` — the package that actually carries the `reticle` bin — never
 * `@reticlehq/core`, which is schema-only and has no executable.
 */
export function installArgs(
  version: string,
  kind: ExecutionKind,
  localRoot: string | null,
): NpmInstall | null {
  if (kind === ExecutionKind.NPX) return null;
  const pkg = `${RETICLE_NPM_PACKAGE}@${version}`;
  if (kind === ExecutionKind.LOCAL && localRoot !== null) {
    return { args: ['install', pkg], cwd: localRoot };
  }
  return { args: ['install', '-g', pkg] };
}

async function installVersion(version: string, kind: ExecutionKind): Promise<void> {
  const localRoot = kind === ExecutionKind.LOCAL ? findLocalProjectRoot() : null;
  const plan = installArgs(version, kind, localRoot);
  if (null === plan) {
    // npx re-resolves the package from npm on the next Claude Code restart — no npm
    // install needed. The restart itself is what triggers the update.
    log('reticle_update_npx_strategy', {
      note: 'Running via npx — exiting so Claude Code restarts and npx fetches the new version',
    });
    return;
  }
  if (kind === ExecutionKind.LOCAL && null === localRoot) {
    // Could not find a project root — fell back to a global install as a safe default.
    log('reticle_update_local_no_root', { fallback: 'global' });
  }
  await runNpm(plan.args, plan.cwd !== undefined ? { cwd: plan.cwd } : {});
}

async function installVersionRollback(version: string, kind: ExecutionKind): Promise<void> {
  if (kind === ExecutionKind.NPX) {
    log('reticle_rollback_npx_strategy', {
      note: 'Running via npx — update your .mcp.json args to pin the version you want to restore',
    });
    return;
  }
  await installVersion(version, kind);
}

/**
 * Install targetVersion using the appropriate strategy for the detected execution kind,
 * then exit so Claude Code restarts with the new binary. Saves the current version
 * first so rollback can restore it.
 */
export async function applyUpdate(targetVersion: string): Promise<void> {
  const manifest = loadManifest();
  if (manifest !== null) {
    saveManifest({ ...manifest, previousVersion: manifest.currentVersion });
  }

  const kind = detectExecutionKind();
  log('reticle_update_applying', { version: targetVersion, executionKind: kind });
  await installVersion(targetVersion, kind);
  log('reticle_update_applied', { version: targetVersion, executionKind: kind });
  // Emitted AFTER the install succeeded, so the metric counts versions that actually landed rather
  // than attempts. Awaited, unlike every other send in the product: `process.exit(0)` on the next
  // line would kill an in-flight fire-and-forget POST, and this event is rare enough that the wait
  // costs nothing. A failed send still cannot block the exit — `emit` swallows its own errors.
  await reportVersionChange(SERVER_VERSION, targetVersion, VersionChangeDirection.UPDATE);
  process.exit(0);
}

/**
 * Reinstall the previousVersion saved in the update manifest using the appropriate
 * strategy, then exit so Claude Code restarts with the restored binary.
 */
export async function rollback(): Promise<void> {
  const manifest = loadManifest();
  if (null === manifest || manifest.previousVersion === undefined) {
    throw new Error('No previous version available for rollback');
  }
  const prev = manifest.previousVersion;
  const kind = detectExecutionKind();
  log('reticle_rollback_applying', { version: prev, executionKind: kind });
  await installVersionRollback(prev, kind);
  log('reticle_rollback_applied', { version: prev, executionKind: kind });
  // A rollback is a release-quality alarm — someone shipped something that broke a real user badly
  // enough for them to go backwards. Worth knowing about within the hour, not at the next retro.
  await reportVersionChange(SERVER_VERSION, prev, VersionChangeDirection.ROLLBACK);
  // For npx, exiting would let the next restart re-resolve @latest — rolling FORWARD, the opposite
  // of rollback. installVersionRollback already told the user to pin the version in.mcp.json, so
  // stay running rather than trigger that. Other kinds installed the old version and must restart.
  if (kind !== ExecutionKind.NPX) process.exit(0);
}
