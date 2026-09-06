/**
 * How each framework gets wired: the Vite plugin, the three Next files, the SvelteKit client hook.
 * Split out of `plan.ts` — that file is the plan's SHAPE (statuses, ordering, the agent/MCP steps),
 * this one is the per-framework detail, and they grow for different reasons.
 */

import { bridgeWsUrl } from '@reticlehq/core';
import { patchViteConfig, VitePatchKind } from './vite-config.js';
import { patchNextConfig, patchRootLayout, patchPagesApp } from './next-patch.js';
import {
  ASTRO_ENV_DTS_PATH,
  patchAstroConfig,
  patchAstroEnvDts,
  patchAstroLayout,
} from './astro-patch.js';
import {
  CRA_DEV_MODULE_IMPORT,
  CRA_ENV_PATH,
  CRA_TOKEN_PER_MACHINE_NOTICE,
  TOKEN_VAR,
  craDevModuleFile,
  craDevModulePath,
  craEnvPatch,
  craImportPatch,
} from './cra.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import {
  viteManual,
  NEXT_LAYOUT_MANUAL,
  NEXT_LAYOUT_PATH,
  viteDevModuleFile,
  VITE_DEV_MODULE_PATH,
  nextReticleDevFile,
  NEXT_RETICLE_DEV_PATH,
  nextConfigManual,
  svelteKitHooksFile,
  SVELTEKIT_HOOKS_PATH,
  UNVERIFIED_FRAMEWORK_NOTE,
  astroManual,
  nuxtManual,
  NUXT_PLUGIN_PATH,
  webpack4TranspileNote,
  WEBPACK4_REACT_SCRIPTS_MAJOR,
  reactRouterManual,
  REACT_ROUTER_ENTRY_PATH,
  htmlManual,
} from './snippets.js';
import { StepStatus, type PlanInput, type Step } from './plan.js';
import { Framework } from './detect.js';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { CSP_STEP_TITLE } from './csp-check.js';
import { diagnoseWebCsp } from './csp-doctor.js';

/** What adding `reticle()` to a Vite config buys, which differs by framework. */
export const VITE_PLUGIN_DETAIL = {
  /** A plain Vite app gets both halves from the plugin. */
  VITE: 'add reticle() to plugins (also injects connect())',
  /**
   * SvelteKit renders through app.html, so the plugin's HTML injection never fires and connect()
   * comes from the client hook instead. The plugin is still required: it is what stamps
   * data-reticle-source into .svelte components, and without it every verdict on a SvelteKit app
   * comes back with no file:line at all.
   */
  SVELTEKIT: 'add reticle() to plugins (stamps data-reticle-source in .svelte components)',
  /**
   * React Router framework mode renders through its own request handler, so the plugin's HTML
   * injection never fires and connect() comes from the client entry instead. The plugin is still
   * required for the same reason it is under SvelteKit: without it every verdict on the app comes
   * back with no file:line at all.
   */
  REACT_ROUTER: 'add reticle() to plugins (stamps data-reticle-source in .tsx components)',
} as const;

const CAPABILITIES_TITLE = 'Capabilities + store';

/**
 * The one step `init` genuinely cannot finish, addressed to the AGENT reading this report.
 *
 * It used to read "Capabilities are empty until you edit that file" and describe the consequence to
 * a human — homework, in a report a human mostly does not read, naming no file to open and no thing
 * to look for. The agent that ran `init` is right there, has the codebase, and can finish this in
 * the same minute; what it needed was the specific instruction, not the rationale.
 *
 * What is left is exactly what could not be PROVEN from source: which atoms/actor/queryClient an
 * adapter-wrapped store should be built from, and which elements matter enough to name. `init`
 * emits nothing it cannot prove, because a wrong import here throws on every dev page load — worse
 * than an empty file.
 */
const CAPABILITIES_TODO_TITLE = 'AGENT: finish the capabilities file';

function capabilitiesTodo(path: string, stores: readonly string[]): string {
  return (
    `This app's state lives in a library nothing in the running app points at, so it is the one ` +
    `thing Reticle cannot find for itself — reticle_state will not see it until you say where it ` +
    `is.\n` +
    `Do this now, before driving anything:\n` +
    `  1. In ${path}, uncomment the suggested line and complete it: ${stores.join('; ')}.\n` +
    `  2. Prove it: drive one flow and check reticle_state returns your key. An empty state read ` +
    `means the line is still not doing anything, whatever else went green.`
  );
}

/**
 * The dev module carrying `registerCapabilities` / `registerStore`.
 *
 * Without it every app came up `hasCapabilities: false` with a `reticle_state` holding nothing but
 * `__reticle_renders` — the state-truth read was unavailable on every app out of the box. Written
 * only when absent, because it is the one generated file a user is expected to EDIT.
 */
/**
 * Is there state left that ONLY the app can hand over?
 *
 * This used to ask a much bigger question — "does the generated file register anything at all?" —
 * and fired on almost every install, because almost every install generated a file whose testids
 * and stores were both empty. The answer was homework: go read the source, uncomment a line, add
 * data-testid attributes, then drive to prove it. Several turns, on every onboarding.
 *
 * Two of those three are no longer anyone's homework. Testids are read from the live DOM, and a
 * store passed through a React context provider (Redux, TanStack Query) is discovered and
 * registered on the first commit. What is left is the genuinely unreachable case: a module-scope
 * store, or one needing an argument only the source supplies — Zustand, Jotai atoms, an XState
 * actor. Nothing in the running app points at those, so the notice still has to fire, and it now
 * fires ONLY there.
 *
 * `wired` are stores init resolved and wrote a live `registerStore` call for. Hints are not
 * registrations: they land in the file as a commented line, and counting one as a registration
 * silences the notice whose whole purpose is to say "act on the hint".
 */
function needsManualStore(hints: readonly string[], wired: readonly unknown[]): boolean {
  return hints.length > 0 && 0 === wired.length;
}

function capabilitiesStep(input: PlanInput): Step[] {
  if (true === input.viteDevModuleExists) {
    return [
      {
        title: CAPABILITIES_TITLE,
        target: VITE_DEV_MODULE_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists, left alone, it is yours to edit',
      },
    ];
  }
  const testids = input.testids ?? [];
  const stores = input.storeHints ?? [];
  const wired = input.foundStores ?? [];
  // Testids no longer need counting here. They are read from the live DOM at announce time, so a
  // number printed at install time would be a stale claim about a codebase that is about to change —
  // which is exactly what "no data-testid values yet" used to be on an app whose testids arrive with
  // a lazy route.
  const found = 'testids read from the live DOM';
  // A store we found and WIRED is a registration, so the notice must not fire. A store HINT is not:
  // `stores` holds suggestions, written into the file as a commented line of the form
  // `// import your store, then: registerStore(...)`. Counting a suggestion as a registration let
  // the hint silence the notice whose entire job is to say "act on the hint".
  //
  // Measured against a real product UI (rowy — 70+ deps, jotai, a whole src/atoms tree): init
  // detected jotai, offered one commented line, emitted NO notice, and wrote
  // `registerCapabilities({ testids: [], signals: [], stores: [] })`. So `hasCapabilities` stayed
  // false, `reticle_state` was empty forever, and the install gate reported "connected: 1,
  // manual ⚠: none". Every check green, state observability zero.
  //
  // jotai is still exactly that case. A Redux or TanStack app is not, any more: its store rides a
  // context provider and the React adapter registers it on the first commit, so `storeHints` no
  // longer names either one and this notice no longer fires for them.
  const nothingToRegister = needsManualStore(stores, wired);
  return [
    {
      title: CAPABILITIES_TITLE,
      target: VITE_DEV_MODULE_PATH,
      status: StepStatus.APPLY,
      detail: `${found}; ${
        wired.length > 0
          ? `registered ${wired.map((s) => `'${s.key}'`).join(', ')} from your source`
          : stores.length > 0
            ? `store: uncomment the ${String(stores.length)} suggested line(s)`
            : 'no state library detected'
      }`,
      write: {
        path: VITE_DEV_MODULE_PATH,
        content: viteDevModuleFile(testids, stores, wired, input.detection.uiLibrary),
      },
      dependsOnInstall: true,
    },
    // The write is real; what it registers is not. `registerCapabilities({ testids: [], signals: [],
    // stores: [] })` registers nothing, so `hasCapabilities` stays false — correctly — and the ✓
    // above reads as if the feature is on. Reported as exactly that confusion: "hasCapabilities false
    // on every session while init said ✓ Capabilities + store".
    //
    // Beside the write rather than replacing it, for two reasons: only APPLY steps are written
    // (run.ts), and SKILL.md tells the reader to skip ✓ lines — so a caveat carried on the ✓ is a
    // caveat nobody reads.
    ...(nothingToRegister
      ? [
          {
            title: CAPABILITIES_TODO_TITLE,
            target: VITE_DEV_MODULE_PATH,
            status: StepStatus.NOTICE,
            detail: capabilitiesTodo(VITE_DEV_MODULE_PATH, stores),
          } satisfies Step,
        ]
      : []),
  ];
}

export function viteSteps(input: PlanInput, detail: string = VITE_PLUGIN_DETAIL.VITE): Step[] {
  // Capabilities are independent of whether the config needed patching. Attaching them to the APPLY
  // branch meant a re-run on an already-wired app silently never created the module.
  return [...viteConfigSteps(input, detail), ...capabilitiesStep(input)];
}

function viteConfigSteps(input: PlanInput, detail: string): Step[] {
  const cfg = input.viteConfig;
  const port = input.options.port;
  if (null === cfg) {
    return [
      {
        title: 'Vite plugin',
        target: 'vite.config',
        status: StepStatus.MANUAL,
        detail: viteManual(port, input.detection.uiLibrary),
      },
    ];
  }
  const patch = patchViteConfig(cfg.source, port, true === input.captureBodies);
  if (patch.kind === VitePatchKind.ALREADY) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.ALREADY,
        detail: 'reticle() already in plugins',
      },
    ];
  }
  if (patch.kind === VitePatchKind.MANUAL) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.MANUAL,
        detail: `${patch.reason}\n\n${viteManual(port, input.detection.uiLibrary)}`,
      },
    ];
  }
  return [
    {
      title: 'Vite plugin',
      target: cfg.path,
      status: StepStatus.APPLY,
      detail,
      write: { path: cfg.path, content: patch.code },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Turn a conservative source patch into a step: applied when it patched, already when the wiring is
 * there, and the hand-edit instructions when the file shape wasn't one we recognise.
 */
function patchStep(
  title: string,
  path: string,
  patch: SourcePatch,
  applyDetail: string,
  manualDetail: string,
): Step {
  if (patch.kind === PatchKind.ALREADY) {
    return { title, target: path, status: StepStatus.ALREADY, detail: 'already wired' };
  }
  if (patch.kind === PatchKind.MANUAL) {
    return {
      title,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${patch.reason}\n\n${manualDetail}`,
    };
  }
  return {
    title,
    target: path,
    status: StepStatus.APPLY,
    detail: applyDetail,
    write: { path, content: patch.code },
    dependsOnInstall: true,
  };
}

/**
 * Next used to be the ONLY stack with hand edits left over — and both of them fail silently when
 * skipped, so a Next user's app booted, connected to nothing, and said nothing about why. Both are
 * now patched by the same conservative rules the Vite config gets.
 */
/** The env var withReticle sets from the discovered daemon, and the component must read. */
const NEXT_DAEMON_URL_ENV = 'NEXT_PUBLIC_RETICLE_URL';

/**
 * The two-line edit that unfreezes an existing install's port.
 *
 * Stated as the edit rather than as a problem, because the reader is an agent that can apply it in
 * one write and is otherwise going to ask what to do.
 */
const NEXT_DEV_FILE_STALE_DETAIL =
  'predates daemon discovery, so it dials the port init saw when it ran. In this file add ' +
  '`const url = process.env.NEXT_PUBLIC_RETICLE_URL;` and spread `...(url ? { url } : {})` into ' +
  'reticle.connect(), after any url already there. Nothing else needs to change.';

export function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devPath = input.nextReticleDevPath ?? NEXT_RETICLE_DEV_PATH;
  // An install that predates daemon discovery has a component that never reads the discovered URL,
  // so it keeps dialling whatever port `init` saw on the day it ran. Re-running `init` used to call
  // that "file exists" and move on, which is why the defect survives an upgrade. Named as work.
  //
  // Never overwritten: this file is the one an app owner edits — registered stores, capabilities,
  // their own signals. Rewriting it to fix two lines would take the rest with it. Undefined source
  // means it was not read, and an unread file stays ALREADY rather than becoming invented work.
  const devStale =
    true === input.nextReticleDevExists &&
    'string' === typeof input.nextReticleDevSource &&
    !input.nextReticleDevSource.includes(NEXT_DAEMON_URL_ENV);
  const devFile: Step = input.nextReticleDevExists
    ? devStale
      ? {
          title: 'ReticleDev component',
          target: devPath,
          status: StepStatus.MANUAL,
          detail: NEXT_DEV_FILE_STALE_DETAIL,
        }
      : {
          title: 'ReticleDev component',
          target: devPath,
          status: StepStatus.ALREADY,
          detail: 'file exists',
        }
    : {
        title: 'ReticleDev component',
        target: devPath,
        status: StepStatus.APPLY,
        detail: 'create dev-only connect component',
        write: {
          path: devPath,
          content: nextReticleDevFile(
            input.options.port,
            input.options.projectId,
            input.testids ?? [],
            input.storeHints ?? [],
            // Next's dev module is not a sibling of `src/` — its imports are resolved from wherever
            // the component actually lands (`app/`, or `src/app/` in a --src-dir app).
            input.nextFoundStores ?? [],
          ),
        },
        dependsOnInstall: true,
      };

  const configPatch: SourcePatch =
    null === input.nextConfigSource || input.nextConfigSource === undefined
      ? { kind: PatchKind.MANUAL, reason: `no ${configFile} found` }
      : patchNextConfig(input.nextConfigSource);
  const layout = input.nextLayout ?? null;
  // Pages Router mounts through pages/_app, App Router through the root layout — different edits,
  // and picking by path is what stops a Pages app being handed the layout patch that cannot apply.
  const isPagesRouter = layout !== null && /(^|\/)pages\/_app\.[jt]sx?$/.test(layout.path);
  const layoutPatch: SourcePatch =
    null === layout
      ? { kind: PatchKind.MANUAL, reason: 'no root layout (app/layout.tsx) or pages/_app found' }
      : isPagesRouter
        ? patchPagesApp(layout.source, input.nextReticleDevImport)
        : patchRootLayout(layout.source);

  // The same question the Vite path asks. Skipped when the module already exists: its contents are
  // the user's, and re-nagging about a file we did not write is noise.
  const nextTodo: Step[] =
    true !== input.nextReticleDevExists &&
    needsManualStore(input.storeHints ?? [], input.nextFoundStores ?? [])
      ? [
          {
            title: CAPABILITIES_TODO_TITLE,
            target: devPath,
            status: StepStatus.NOTICE,
            detail: capabilitiesTodo(devPath, input.storeHints ?? []),
          },
        ]
      : [];

  return [
    devFile,
    ...nextTodo,
    patchStep(
      'Next config (withReticle)',
      configFile,
      configPatch,
      'wrap the export in withReticle (source mapping, dev-only)',
      nextConfigManual(configFile),
    ),
    patchStep(
      'Mount ReticleDev',
      layout?.path ?? NEXT_LAYOUT_PATH,
      layoutPatch,
      'mount <ReticleDev /> in the root layout (dev-only)',
      NEXT_LAYOUT_MANUAL,
    ),
  ];
}

/**
 * SvelteKit is WIRED but not SUPPORTED, and the plan says so out loud.
 *
 * There is no SvelteKit app in `apps/` and no CI gate for one, so nothing proves this hook still
 * registers a session — every other framework init offers (React, Next, Remix, Astro) has both. The
 * wiring is real and may well work; what is missing is anything that would tell us when it stops.
 * Silently emitting it reads as a support claim, which is the thing this project exists to not do.
 */
/**
 * The one failure `init` cannot otherwise see: the bundler will not parse our SDK.
 *
 * Every check in this report passes on a react-scripts 4 app -- the package installs, the entry
 * import is written, the token is inlined -- and then `npm start` dies with a syntax error inside
 * `@reticlehq/browser/dist/index.js`, a file the user did not write, naming nothing about Reticle
 * (#680). A green report over a build that cannot compile is the same class of lie as a green report
 * over an app that cannot connect.
 *
 * FIRST in the CRA step list, deliberately: it decides whether any of the steps below it can run at
 * all.
 */
function webpack4Step(input: PlanInput): Step[] {
  const major = input.detection.reactScriptsMajor;
  if (major === undefined || major >= WEBPACK4_REACT_SCRIPTS_MAJOR) return [];
  return [
    {
      title: `react-scripts ${String(major)} cannot parse the SDK`,
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: webpack4TranspileNote(major),
    },
  ];
}

/**
 * Create React App: the connect goes in `src/index.tsx`, the token in `.env.development.local`.
 *
 * The previous plan pointed at `index.html`, which cannot work — CRA's is a static template the
 * bundler never processes for modules. Reported from a real cra-redux-saga app.
 */
export function craSteps(input: PlanInput): Step[] {
  const entry = input.craEntry ?? null;
  // Match the project language the same way Next does (#675): a JS CRA app cannot resolve `.ts`.
  const modulePath = craDevModulePath(input.detection.typescript);
  const steps: Step[] = [
    ...webpack4Step(input),
    {
      title: 'Reticle connect module',
      target: modulePath,
      status: StepStatus.APPLY,
      detail: 'create the dev-only connect (CRA cannot inject through public/index.html)',
      write: {
        path: modulePath,
        content: craDevModuleFile(input.options.port, input.options.projectId, {
          typescript: input.detection.typescript,
        }),
      },
      dependsOnInstall: true,
    },
  ];
  const token = input.pairingToken ?? '';
  // The daemon that is live NOW, not the one baked into the module at first install. CRA has no
  // build hook, so this is refreshed by re-running `init` rather than by starting the dev server.
  const env = craEnvPatch(
    input.craEnv ?? null,
    token,
    input.options.port === undefined ? undefined : bridgeWsUrl(input.options.port),
  );
  if (env !== null) {
    steps.push({
      title: 'Pairing token',
      target: CRA_ENV_PATH,
      status: StepStatus.APPLY,
      // REACT_APP_* is the only thing CRA inlines into browser code; without the token the bridge
      // refuses the connection and no session appears. Say the file is gitignored HERE, at the one
      // moment someone is looking: the token is per-machine and cannot travel, so every teammate
      // has to run init once or their clone is dead with no explanation.
      detail: `set ${TOKEN_VAR} (the only channel CRA inlines) — ${CRA_ENV_PATH} is gitignored, so each teammate must run \`reticle init\` on their own machine`,
      write: { path: CRA_ENV_PATH, content: env },
    });
    // Beside the write, not inside it. A ✓ line is one SKILL.md tells the reader to skip, and this
    // is the fact that decides whether the install works for anyone but the person running it.
    steps.push({
      title: 'Pairing token is per-machine',
      target: CRA_ENV_PATH,
      status: StepStatus.NOTICE,
      detail: CRA_TOKEN_PER_MACHINE_NOTICE,
    });
  } else if ('' === token) {
    // No daemon has ever run here, so there is no token to inline. Omitting the step entirely made
    // init report all-green for an app that could never pair.
    steps.push({
      title: 'Pairing token',
      target: CRA_ENV_PATH,
      status: StepStatus.MANUAL,
      // `reticle serve`, not `reticle start` — the latter is not a verb this CLI dispatches, and
      // this message is read by someone whose app boots and never pairs. Handing them a command
      // that errors is a second dead end on the first.
      detail: `no pairing token yet — the daemon writes one on first run. Start it with \`reticle serve\` (or let your agent run \`reticle mcp\`), then \`reticle init\` again to write ${TOKEN_VAR}`,
    });
  }
  if (null === entry) {
    steps.push({
      title: 'Connect snippet (CRA)',
      target: 'src/index.tsx',
      status: StepStatus.MANUAL,
      detail: `Add \`${CRA_DEV_MODULE_IMPORT}\` to your app entry (src/index.tsx or src/index.js), after the existing imports.`,
    });
    return steps;
  }
  const patched = craImportPatch(entry.source);
  steps.push(
    null === patched
      ? {
          title: 'Connect snippet (CRA)',
          target: entry.path,
          status: StepStatus.ALREADY,
          detail: 'already imported',
        }
      : {
          title: 'Connect snippet (CRA)',
          target: entry.path,
          status: StepStatus.APPLY,
          detail: 'import the dev-only connect module',
          write: { path: entry.path, content: patched },
          dependsOnInstall: true,
        },
  );
  return steps;
}

/**
 * Nuxt: one manual step carrying the whole recipe, and no pretence of more.
 *
 * There is no Nuxt app in `apps/` and no CI gate for one, so an auto-written plugin would be a
 * support claim nothing backs — the same reasoning SvelteKit already carries. What this DOES fix is
 * everything that made the previous fall-through actively wrong: Nuxt was classified as `html`, so
 * it was handed the React kit and a localhost-guarded snippet that cannot run in a Vue app.
 */
export function nuxtSteps(input: PlanInput): Step[] {
  return [
    {
      title: 'Connect snippet (Nuxt)',
      target: NUXT_PLUGIN_PATH,
      status: StepStatus.MANUAL,
      detail: nuxtManual(input.options.port, input.options.projectId),
    },
  ];
}

/**
 * React Router framework mode: the client-entry connect, printed rather than written.
 *
 * `app/entry.client.tsx` is an override of a default React Router supplies, so writing one
 * containing our import and nothing else would replace that default with a file that never
 * hydrates. See `reactRouterManual`.
 */
export function reactRouterSteps(input: PlanInput): Step[] {
  return [
    {
      title: 'Connect snippet (React Router)',
      target: REACT_ROUTER_ENTRY_PATH,
      status: StepStatus.MANUAL,
      detail: reactRouterManual(
        input.options.port,
        input.options.projectId,
        true === input.reactRouterEntryExists,
      ),
    },
  ];
}

export function svelteKitSteps(input: PlanInput): Step[] {
  const unverified: Step = {
    title: 'SvelteKit is UNVERIFIED',
    target: SVELTEKIT_HOOKS_PATH,
    status: StepStatus.NOTICE,
    detail: UNVERIFIED_FRAMEWORK_NOTE,
  };
  // SvelteKit can't use the Vite-plugin injection (it renders via app.html) — wire a client hook
  // that SvelteKit runs on startup, which is the path that can register a session at all.
  if (true === input.svelteKitHooksExists) {
    return [
      unverified,
      {
        title: 'Reticle client hook',
        target: SVELTEKIT_HOOKS_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      },
    ];
  }
  return [
    unverified,
    {
      title: 'Reticle client hook',
      target: SVELTEKIT_HOOKS_PATH,
      status: StepStatus.APPLY,
      detail: 'create dev-only client connect (SvelteKit renders via app.html)',
      write: {
        path: SVELTEKIT_HOOKS_PATH,
        content: svelteKitHooksFile(
          input.options.port,
          input.options.projectId,
          input.detection.uiLibrary,
        ),
      },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Astro: the config define + build target, and the connect script in ONE layout.
 *
 * Astro was the last gated stack left printing a recipe it did not apply. It still falls back to the
 * printed one whenever the choice is not obvious — no config, no single layout, or a shape the
 * patchers do not fully recognise — because which page or layout to instrument is a real decision
 * and a half-edited build config is worse than a documented manual step.
 */
export function astroSteps(input: PlanInput): Step[] {
  const config = input.astroConfig ?? null;
  const layout = input.astroLayout ?? null;
  const manual = astroManual(input.options.port, input.options.projectId, layout?.path);
  if (null === config || null === layout) {
    return [
      {
        title: 'Connect snippet (Astro)',
        // Name what is actually there. `astro.config + layout` pointed at a layout this project may
        // not have — reported on a fixture with only src/pages/index.astro.
        target:
          null === layout ? 'astro.config + a page (no layout found)' : 'astro.config + layout',
        status: StepStatus.MANUAL,
        detail: manual,
      },
    ];
  }
  // ATOMIC. The connect snippet is useless without the config: the token is inlined by the config,
  // so a layout patched on its own gives an app that dials the bridge and is refused. Measured on a
  // real fixture — config ⚠, layout ✓ — which reads as one step done and one caveat when it is
  // actually a guaranteed non-connection. If either half cannot be applied, BOTH go manual with the
  // single recipe that does the whole job.
  const manualWithLayout = astroManual(input.options.port, input.options.projectId, layout.path);
  const configPatch = patchAstroConfig(config.source);
  const layoutPatch = patchAstroLayout(
    layout.source,
    input.options.port,
    input.options.projectId,
    input.detection.uiLibrary,
  );
  if (configPatch.kind === PatchKind.MANUAL || layoutPatch.kind === PatchKind.MANUAL) {
    return [
      {
        title: 'Connect snippet (Astro)',
        target: `${config.path} + ${layout.path}`,
        status: StepStatus.MANUAL,
        detail: manualWithLayout,
      },
    ];
  }
  const envPatch = patchAstroEnvDts(input.astroEnvDts ?? null);
  return [
    patchStep(
      'Astro config (token + build target)',
      config.path,
      configPatch,
      'inline the pairing token and raise build.target to es2022',
      manualWithLayout,
    ),
    patchStep(
      'Connect snippet (Astro)',
      layout.path,
      layoutPatch,
      'add the dev-only connect <script> before </body>',
      manualWithLayout,
    ),
    // Declares the Vite define names so `astro check` (create-astro's default build) can see them
    // (#677). Independent of the two halves above: even an ALREADY config/layout still needs this
    // when the env file was never written.
    patchStep(
      'Astro env types (Vite defines)',
      ASTRO_ENV_DTS_PATH,
      envPatch,
      'declare __RETICLE_TOKEN__ / __RETICLE_ROOT__ for astro check',
      manualWithLayout,
    ),
  ];
}

/**
 * A Content-Security-Policy whose `connect-src` excludes the bridge, said out loud at install time.
 *
 * Both reported cases were Next apps where `init` printed success for every step and the app then
 * never connected: the browser blocked the WebSocket and reported it in its own console, which
 * nothing on this side reads. A NOTICE rather than a step, because editing someone's security policy
 * is theirs to do — but it carries the exact text to paste, which is the difference between a
 * warning and a fix.
 */
export function cspStep(input: PlanInput): Step[] {
  // Reads the SAME list `reticle doctor` reads. It used to read a hand-written pair —
  // `[nextConfigSource, nextLayout?.source]` — while csp-doctor.ts already carried the full set
  // including `index.html`, which is where every Vite and Electron app declares its policy. So the
  // command you run BEFORE anything works checked less than the one you run after it has failed.
  //
  // Measured on MarkText, a production Electron editor: its renderer sets `default-src 'self'` with
  // no `connect-src`, the browser blocked the bridge WebSocket, and `init` printed a clean plan. The
  // daemon cannot see a dial that never left the page, so nothing anywhere said why — and the check
  // that would have said it was sitting one import away.
  // The pre-read Next sources are folded in ON TOP of the shared list, not replaced by it: init
  // resolves `nextConfigFile` across more spellings than CSP_FILES names (`.mts`, for one), and a
  // layout is found by search rather than by a fixed path. Two sources of the same truth is the
  // problem being fixed here — one of them being a SUPERSET is not.
  const extra: Record<string, string | undefined> = {
    ...(input.nextConfigFile !== null && input.nextConfigFile !== undefined
      ? { [input.nextConfigFile]: input.nextConfigSource ?? undefined }
      : {}),
    ...(input.nextLayout ? { [input.nextLayout.path]: input.nextLayout.source } : {}),
  };
  const read = (file: string): string | undefined => extra[file] ?? input.cspSources?.[file];
  const findings = diagnoseWebCsp(read, input.options.port ?? RETICLE_DEFAULT_PORT, [
    ...Object.keys(extra),
  ]);
  const first = findings[0];
  if (first === undefined) return [];
  return [
    {
      title: CSP_STEP_TITLE,
      target: first.file,
      status: StepStatus.NOTICE,
      // `problem` already ends with the text to paste; `fix` is the same sentence for callers that
      // want it on its own (doctor renders them separately). Printing both said it twice.
      detail: first.problem,
    },
  ];
}

/**
 * The per-framework half of the plan, dispatched on the detected framework.
 *
 * Lives here rather than in `buildPlan` because every branch of it calls a function defined in this
 * file: the dispatch and the steps it dispatches to grow together, and keeping them apart put a
 * list that is entirely per-framework detail in the file that owns the plan's SHAPE. The 1000-line
 * backstop makes that cost concrete — two independent framework additions each grew `plan.ts`, and
 * together they crossed the cap while neither did alone.
 */
export function frameworkSteps(input: PlanInput): Step[] {
  const steps: Step[] = [];
  if (input.detection.framework === Framework.VITE) {
    steps.push(...viteSteps(input));
  } else if (input.detection.framework === Framework.NEXT) {
    steps.push(...nextSteps(input));
  } else if (input.detection.framework === Framework.ASTRO) {
    steps.push(...astroSteps(input));
  } else if (input.detection.framework === Framework.CRA) {
    steps.push(...craSteps(input));
  } else if (input.detection.framework === Framework.NUXT) {
    steps.push(...nuxtSteps(input));
  } else if (input.detection.framework === Framework.REACT_ROUTER) {
    steps.push(...reactRouterSteps(input));
    // The Vite plugin too, for the reason SvelteKit gets it: React Router framework mode IS a Vite
    // app, and the plugin is what stamps data-reticle-source. Without it the app connects and every
    // verdict comes back with no file:line.
    steps.push(...viteSteps(input, VITE_PLUGIN_DETAIL.REACT_ROUTER));
  } else if (input.detection.framework === Framework.SVELTEKIT) {
    steps.push(...svelteKitSteps(input));
    // The Vite plugin as well as the client hook. `init` already INSTALLS @reticlehq/vite-plugin for
    // SvelteKit and then never wired it into the config, so it sat in package.json doing nothing —
    // which is why a SvelteKit app connected fine and every verdict came back with no file:line.
    steps.push(...viteSteps(input, VITE_PLUGIN_DETAIL.SVELTEKIT));
  } else {
    steps.push({
      title: 'Connect snippet',
      target: 'index.html',
      status: StepStatus.MANUAL,
      detail: htmlManual(input.options.port, input.options.projectId, input.pairingToken),
    });
  }
  return steps;
}
