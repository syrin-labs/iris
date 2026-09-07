/**
 * Workspace redirect: when `init` is run at a monorepo ROOT, wire the app rather than the root.
 *
 * Split out of `run.ts`, which sits one line under the 1000-line backstop — every init change that
 * touches the orchestration now trips the cap before it can be reviewed. This is the part of that
 * file that answers a single, separable question ("is the app somewhere else, and where?"), so it
 * is the seam that costs nothing to move.
 *
 * `runInit` arrives as a parameter rather than an import: re-entering init is the whole point of a
 * redirect, and taking it as an argument keeps this module a leaf instead of forming a cycle with
 * the file it was cut from.
 */

import { join } from 'node:path';
import { detect, Framework } from './detect.js';
import { findWorkspaceApps, PACKAGE_JSON } from './workspace-apps.js';
import { chooseWorkspaceApp } from './app-choice.js';
import type { InitIo, InitOptions, InitResult } from './run.js';

/** Re-enter `init`, scoped to one directory of the workspace. */
export type RunInit = (options: InitOptions, io: InitIo) => InitResult;

const AMBIGUOUS_HEADER =
  'Several apps found in this workspace. Re-run `reticle init` inside the one you want:';

/**
 * When the current directory is a workspace root with no app of its own, wire the app instead of the
 * root. One candidate is wired silently (there is nothing to ask about); several are listed, because
 * guessing which app someone meant is worse than one line of output.
 * Returns null when there is nothing to redirect to — the caller then proceeds here as before.
 */
export function redirectToWorkspaceApp(
  options: InitOptions,
  io: InitIo,
  pkg: unknown,
  runInit: RunInit,
): InitResult | null {
  if (true === options.redirected) return null;
  const rootFiles = new Set(io.rootFiles());
  const here = detect({
    pkg: 'object' === typeof pkg && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    lockfiles: new Set(),
  });
  // `--app` is an INSTRUCTION, and it is read before the guess below. The guess answers "where is
  // the app?" for somebody who did not say; when somebody said, there is nothing left to infer.
  //
  // It used to be read after, and the check underneath returns early for any directory that looks
  // like an app — which a JS monorepo ROOT does, because shared tooling puts `vite` in its
  // devDependencies. So on a real pnpm+turbo monorepo (measured on nuclear, a Tauri v2 app at
  // product scale) `reticle init --app packages/player` silently ignored the flag, installed the
  // SDK into the root's package.json, wrote `.reticle.json` and a whole `src/reticle-dev.ts` into a
  // repository root that has no `src/`, left `packages/player` untouched — and reported three ✓ and
  // one ⚠. The one flag documented for this shape wired the wrong directory and said it worked.
  //
  // Existence is the test, not membership of the discovered list: discovery scans conventional
  // directories, and somebody who names a path knows their own layout better than the scan does.
  const named = options.app === undefined || '' === options.app ? undefined : options.app;
  if (named !== undefined) {
    const wanted = named.replace(/\/+$/, '');
    if (io.exists(`${wanted}/${PACKAGE_JSON}`))
      return enterApp(options, io, wanted, 'Wiring', runInit);
    io.print(`--app ${named} does not name a directory with a package.json in it.`);
    return { ok: false, applied: 0, manual: 1 };
  }
  if (here.framework !== Framework.HTML) return null; // this directory IS the app

  const apps = findWorkspaceApps(io);
  // An explicitly named app answers the ambiguity. Refusing to guess is right, but "re-run inside the
  // one you want" is not something a script, a CI step, or an agent that cannot change directory can
  // act on — so the refusal was a dead end for exactly the callers most likely to hit it.
  const chosen = chooseWorkspaceApp(options.app, apps);
  if (!chosen.ok) {
    io.print(chosen.message);
    return { ok: false, applied: 0, manual: 1 };
  }
  const target = chosen.app ?? (1 === apps.length ? apps[0] : undefined);
  if (target === undefined) {
    if (0 === apps.length) return null; // not a workspace — fall through to the normal HTML plan
    io.print(AMBIGUOUS_HEADER);
    for (const a of apps) io.print(`  ${a}`);
    io.print('');
    io.print(`Or name one without changing directory:  reticle init --app ${apps[0] ?? '<dir>'}`);
    return { ok: false, applied: 0, manual: apps.length };
  }
  return enterApp(options, io, target, 'No app in this directory — wiring', runInit);
}

/**
 * Re-enter `init` scoped to one directory of a workspace.
 *
 * One implementation for both routes in — the app somebody NAMED and the app discovery found when
 * nobody did. They differ only in the sentence printed; scoping the io, moving the cwd and keeping
 * the agent root has to be identical for both, and was worth having twice for exactly as long as it
 * took to get one of them wrong.
 */
function enterApp(
  options: InitOptions,
  io: InitIo,
  target: string,
  lead: string,
  runInit: RunInit,
): InitResult {
  io.print(`${lead} ${target}.`);
  io.print('');
  return runInit(
    {
      ...options,
      cwd: join(options.cwd, target),
      redirected: true,
      // Where the human is STANDING, kept across the redirect: their agent session runs here, so
      // this is the only place a `/reticle` command file can be found by it.
      agentRoot: options.agentRoot ?? options.cwd,
    },
    io.scoped(target),
  );
}
