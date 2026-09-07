/**
 * The self-update command pair — `reticle update` and `reticle rollback`.
 *
 * Split out of cli.ts, which sits at the 600-line cap: these two are one cohesive unit (swap the
 * installed version, restart) and the file they came from is the CLI's dispatch table, which grows
 * for entirely different reasons.
 */
import { checkForUpdate } from '../update/update-checker.js';
import { updateTarget } from '../update/update-nudge.js';
import { applyUpdate, rollback } from '../update/updater.js';
import { refreshAgentRules } from '../init/refresh-rules.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { log } from '../log.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reticleDepsOf, sdkSyncCommand } from '../update/sdk-sync.js';
import { detectPackageManager } from '../init/detect.js';
import { buildNodeIo } from '../init/node-io.js';

/**
 * Bring the SDK in the CURRENT project to the version being installed.
 *
 * Best-effort and non-fatal on purpose: `reticle update` is run from wherever the human happens to
 * be, which is often not an app at all. A directory with no manifest, or one that has none of our
 * packages, simply has nothing to sync — that is a normal outcome, not a failure, and it must never
 * stop the CLI half from happening.
 */
function syncProjectSdk(target: string): void {
  const cwd = process.cwd();
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return; // not an app directory
  }
  const packages = reticleDepsOf(manifest);
  const io = buildNodeIo(cwd);
  const pm = detectPackageManager(new Set(io.rootFiles()), new Set(io.listDirs('node_modules')));
  const cmd = sdkSyncCommand(pm, packages, target);
  if (null === cmd) {
    log('reticle_update_sdk', { synced: false, reason: 'no @reticlehq packages in this project' });
    return;
  }
  const ok = io.exec(cmd.command, cmd.args);
  log('reticle_update_sdk', { synced: ok, packages, to: target, packageManager: pm });
  if (!ok) {
    log('reticle_update_sdk_failed', {
      hint: `run \`${cmd.command} ${cmd.args.join(' ')}\` by hand, then restart the dev server`,
    });
  }
}

/** `reticle update` — install the latest server version, sync the app's SDK, and restart. */
export async function handleUpdate(): Promise<void> {
  try {
    const manifest = await checkForUpdate(SERVER_VERSION, () => Date.now());
    // Direction, not inequality: the registry being DIFFERENT is not the registry being newer, and
    // the old gate happily installed a downgrade — reported by a user. See updateTarget.
    const target = updateTarget(manifest);
    if (target === undefined) {
      log('reticle_update', {
        ok: false,
        message: 'already on the latest version',
        version: SERVER_VERSION,
      });
      return;
    }
    log('reticle_update', { ok: true, from: SERVER_VERSION, to: target });
    // Bring this project's agent rules up with the version.
    //
    // The managed block has always been updatable — marker-delimited, idempotent by comparing
    // content — and nothing called it after the first install. `mergeMarkedInstruction` is reachable
    // from `buildPlan` alone, so a project set up on an older release kept that release's
    // instructions forever and every improvement to them reached new projects only.
    //
    // That is backwards: the people who most need better instructions are the ones already
    // installed and not getting value, and this is the moment they are touching the install anyway.
    // Only files that ALREADY carry the block are touched, and only inside the markers.
    const refreshed = refreshAgentRules(process.cwd(), {
      read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      write: (path, content) => {
        writeFileSync(path, content, 'utf8');
      },
    });
    if (0 !== refreshed.updated.length)
      log('reticle_rules_refreshed', { files: refreshed.updated, to: target });
    // The app's SDK FIRST, then the CLI. `reticle update` used to swap only the CLI, so the command
    // whose job is keeping an install current was itself a way to produce a version-skewed pair —
    // and the skew message told people to run it to fix an outdated SDK, which it could not do.
    //
    // Before the CLI swap because `applyUpdate` never returns (it execs and exits). If this half
    // fails the daemon is still the older one, which is the direction the HELLO check names clearly
    // and a re-run fixes; the reverse would leave a new daemon talking to an old page.
    syncProjectSdk(target);
    await applyUpdate(target); // calls process.exit; Claude Code restarts
  } catch (error) {
    log('reticle_update_failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

/** `reticle rollback` — restore the previous server version and restart. */
export async function handleRollback(): Promise<void> {
  try {
    await rollback(); // calls process.exit
  } catch (error) {
    log('reticle_rollback_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
