/**
 * Pure, conservative patchers for an Astro app: the config gets the token/root `define` and the
 * raised build target, one layout gets the dev-only connect `<script>`.
 *
 * Astro was the last gated framework where `init` printed a correct recipe and applied none of it —
 * the only ⚠ left on a supported stack, and the user's first session was two hand-copied snippets
 * away. Astro is Vite-based but renders its own HTML, so the Vite plugin's injection never fires and
 * there is no entry module to wire: the connect has to live in a page or layout `<script>`, and the
 * token has to be inlined by the config because nothing else is in the page's path to inject it.
 *
 * Both patchers bail to `manual` (the printed recipe) on any shape they do not fully recognise.
 * Half-editing a build config is worse than a documented manual step.
 */

import { RETICLE_DEFAULT_PORT, ReticleDir, bridgeWsUrl } from '@reticlehq/core';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import { UiLibrary } from './detect.js';
import { sdkImport } from './snippets.js';

/** Present in a patched config AND in a hand-followed recipe — so both count as already wired. */
const CONFIG_MARKER = '__RETICLE_TOKEN__';
/** Present in a patched layout and in the printed recipe's script. */
const LAYOUT_MARKER = 'reticle.connect';

/**
 * The SDK, declared so Vite pre-bundles it BEFORE the first page load.
 *
 * The connect script does `await import('@reticlehq/react')`. Undeclared, Vite meets that import
 * mid-load, pre-bundles it, and the hashed `/node_modules/.vite/deps/@reticlehq_react.js?v=…` URL
 * the browser already requested stops existing — the import rejects with "Failed to fetch
 * dynamically imported module", connect() never runs, and the page looks entirely normal. Measured
 * on astro-nanostores, intermittent on whether the dep cache was warm. The Vite plugin has declared
 * the SDK for this exact reason since the bug was first found on React; Astro is hand-patched and
 * never got it.
 */
const SDK_INCLUDE_LITERAL = `'@reticlehq/react'`;
/**
 * The daemon's journal directory, kept out of the dev server's watcher.
 *
 * The daemon writes `.reticle/` into the project root and rewrites `ambient.json` atomically
 * (`.tmp` + rename) for as long as a session is live. Astro dev is a Vite dev server watching that
 * root, and `.reticle/` is not in Vite's default ignore list — so every journal write read as a
 * project file changing and Vite answered with a full page reload. That closes a loop with no exit:
 * the page loads, the SDK connects and streams events, the daemon journals them, Vite reloads the
 * page, the SDK reconnects. It ran several times a second for as long as the dev server was up,
 * and the symptom looked nothing like the cause — stale refs, actions dying mid-flight, and a log
 * full of connect/disconnect pairs that read as a flapping SDK.
 *
 * The Vite plugin sets the same ignore in its `config` hook. Astro is hand-patched and never loads
 * that plugin, so it needs its own.
 *
 * A RegExp, not a glob. chokidar dropped glob support in v4 and Vite 7+ ships v4/v5, where a
 * double-star pattern is accepted and matches nothing — the ignore would be visibly present in the
 * config and do nothing at all. Measured against the chokidar this repo resolves.
 */
const WATCH_IGNORE_LITERAL = `/(^|[\\\\/])\\.${ReticleDir.ROOT.slice(1)}([\\\\/]|$)/`;
/**
 * An `include:` the app already declared — ours joins that array instead of adding a second key.
 * Deliberately not anchored to a newline: `optimizeDeps: { include: ['x'] }` on one line is the
 * common way to write it, and requiring a line break made the merge miss it and duplicate the key.
 */
const EXISTING_INCLUDE = /(\s*include\s*:\s*\[)/;

const DEFINE_CONFIG = /defineConfig\s*\(\s*\{/;
/** A `vite:` key whose value is an object LITERAL — the one shape we can merge into safely. */
const VITE_OBJECT_KEY = /(^\s*vite\s*:\s*\{)/m;
/** Any `vite:` key at all. One that is not an object literal (a spread, an imported config) is ours to refuse. */
const ANY_VITE_KEY = /^\s*vite\s*:/m;
const BODY_CLOSE = '</body>';

const HELPER = `
function reticleToken() {
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
  try { return readFileSync(join(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
}
`;

const HELPER_IMPORTS = `import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
`;

/**
 * The keys we add inside `vite:`, each with what it must contain.
 *
 * Kept as a list rather than one blob because a config that already sets one of these must be merged
 * INTO, not duplicated: the real astro-nanostores config has `build: { chunkSizeWarningLimit }`, and
 * inserting our own `build` beside it gave the object two — where the last one wins, so
 * `target: 'es2022'` was silently discarded while init reported success. Losing that target is not
 * cosmetic: Astro's default down-levels the modern SDK bundle and dies on a destructuring transform.
 */
const VITE_KEYS: readonly { key: string; inner: string }[] = [
  { key: 'build', inner: `\n      target: 'es2022',` },
  {
    key: 'optimizeDeps',
    inner: `\n      include: [${SDK_INCLUDE_LITERAL}],\n      esbuildOptions: { target: 'es2022' },`,
  },
  {
    key: 'define',
    inner: `\n      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),\n      __RETICLE_ROOT__: JSON.stringify(process.cwd()),`,
  },
  // Merged in first, so a `server: { port }` the app already set keeps its port. An app that
  // already sets `server.watch` itself is the one shape this loses to — the inner `watch` key would
  // be duplicated and the app's would win — which is the same nested-merge ceiling `build` has.
  { key: 'server', inner: `\n      watch: { ignored: [${WATCH_IGNORE_LITERAL}] },` },
];

/** Whole-key form, for a `vite:` block that does not have the key at all. */
const WHOLE: Readonly<Record<string, string>> = {
  build: `\n    build: { target: 'es2022' },`,
  optimizeDeps: `\n    optimizeDeps: { include: [${SDK_INCLUDE_LITERAL}], esbuildOptions: { target: 'es2022' } },`,
  define: `\n    define: {\n      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),\n      __RETICLE_ROOT__: JSON.stringify(process.cwd()),\n    },`,
  server: `\n    server: { watch: { ignored: [${WATCH_IGNORE_LITERAL}] } },`,
};

/**
 * Add our keys to an existing `vite: { ... }` block, merging into any the app already set.
 *
 * Returns null when a colliding key is not an object literal (`build: sharedConfig`) — there is no
 * brace to merge into, and duplicating or replacing it would corrupt someone's build.
 */
function mergeIntoViteBlock(source: string, braceAt: number): string | null {
  let out = source;
  for (const { key, inner } of VITE_KEYS) {
    // Scoped to the vite block by searching from its opening brace: a `build:` under `markdown:` or
    // at the top level is somebody else's key and must not be touched.
    const existing = new RegExp(`(\\n\\s*${key}\\s*:\\s*)([\\{A-Za-z_])`).exec(out.slice(braceAt));
    if (existing?.index === undefined) {
      out = `${out.slice(0, braceAt)}${WHOLE[key] ?? ''}${out.slice(braceAt)}`;
      continue;
    }
    // The character after the colon decides: `{` is a literal we can open; anything else is a
    // reference we must not touch.
    if (existing[2] !== '{') return null;
    const at = braceAt + existing.index + existing[0].length; // just past the `{`
    // An `include:` the app already wrote is an ARRAY, and a second `include:` key in the same
    // object literal is not a merge — the last one wins and one of the two silently disappears.
    // That is how `build.target` was lost while init still reported success. Join their array.
    // Scoped to THIS block's braces: an `include:` under a later key is somebody else's array, and
    // appending the SDK to it would both miss the target and edit a config we were not asked to.
    const own = 'optimizeDeps' === key ? EXISTING_INCLUDE.exec(blockAfter(out, at)) : null;
    if (own?.index === undefined) {
      out = insertAt(out, at, inner);
      continue;
    }
    // Their array first, then the rest of our keys at the block's start — inserting at the LOWER
    // offset second keeps the first offset valid.
    out = insertAt(out, at + own.index + own[0].length, `${SDK_INCLUDE_LITERAL}, `);
    out = insertAt(out, at, withoutInclude(inner));
  }
  return out;
}

function insertAt(source: string, at: number, text: string): string {
  return `${source.slice(0, at)}${text}${source.slice(at)}`;
}

/**
 * The text from just inside an opening brace to its match — a brace count, not a parser.
 *
 * Enough for the one question asked of it (does THIS object literal already declare `include`), and
 * honest about its limit: a `{` or `}` inside a string literal in someone's Vite config would fool
 * it. That only ever shortens or lengthens the window we search for `include:` in, so the worst case
 * is the same duplicate-key merge we would have done before, never a corrupted file.
 */
function blockAfter(source: string, at: number): string {
  let depth = 1;
  for (let i = at; i < source.length; i++) {
    if ('{' === source[i]) depth += 1;
    else if ('}' === source[i]) {
      depth -= 1;
      if (0 === depth) return source.slice(at, i);
    }
  }
  return source.slice(at);
}

/** The optimizeDeps inner minus our `include:` line, for when the app already has one to join. */
function withoutInclude(inner: string): string {
  return inner.replace(`\n      include: [${SDK_INCLUDE_LITERAL}],`, '');
}

/**
 * The `vite:` block Astro needs. `build.target` is raised because Astro's default down-levels the
 * modern SDK bundle and dies on a destructuring transform; `__RETICLE_ROOT__` is defined because
 * without it every source pointer comes back as an absolute path from the machine that ran `init`.
 */
const VITE_BLOCK = `  vite: {
    build: { target: 'es2022' },
    optimizeDeps: { include: [${SDK_INCLUDE_LITERAL}], esbuildOptions: { target: 'es2022' } },
    define: {
      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),
      __RETICLE_ROOT__: JSON.stringify(process.cwd()),
    },
    server: { watch: { ignored: [${WATCH_IGNORE_LITERAL}] } },
  },
`;

export function patchAstroConfig(source: string): SourcePatch {
  if (source.includes(CONFIG_MARKER)) return { kind: PatchKind.ALREADY };
  // A `vite: { ... }` block is an object literal, so our keys can go straight after the brace and
  // whatever is already in there is untouched. Refusing outright was the only genuine install defect
  // left in the gate: the config bailed while the LAYOUT patch applied anyway, leaving an app with a
  // connect snippet, no inlined token and no raised build target — which cannot connect, reported as
  // one OK step and one warning.
  const viteObject = VITE_OBJECT_KEY.exec(source);
  if (viteObject?.index !== undefined) {
    const at = viteObject.index + viteObject[0].length;
    const merged = mergeIntoViteBlock(source, at);
    if (merged !== null) {
      return {
        kind: PatchKind.APPLY,
        code: `${HELPER_IMPORTS}${merged.trimStart()}\n${HELPER}`.trimEnd() + '\n',
      };
    }
    return {
      kind: PatchKind.MANUAL,
      reason:
        'this config sets a `vite` key Reticle needs (build / optimizeDeps / define) to something ' +
        'other than an object literal — merging into it is your call, not a text edit Reticle should make',
    };
  }
  if (ANY_VITE_KEY.test(source)) {
    // `vite: sharedConfig` — not an object literal, so there is no brace to merge into and guessing
    // would corrupt a build config. The recipe is the honest answer here.
    return {
      kind: PatchKind.MANUAL,
      reason:
        'this config sets `vite:` to something other than an object literal — merging into it is your call, not a text edit Reticle should make',
    };
  }
  const opening = DEFINE_CONFIG.exec(source);
  if (opening?.index === undefined) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a `defineConfig({ ... })` call to extend",
    };
  }
  const at = opening.index + opening[0].length;
  const withBlock = `${source.slice(0, at)}\n${VITE_BLOCK}${source.slice(at)}`;
  return {
    kind: PatchKind.APPLY,
    code: `${HELPER_IMPORTS}${withBlock.trimStart()}\n${HELPER}`.trimEnd() + '\n',
  };
}

/** The dev-only connect that goes inside the layout's `<body>`. */
function astroConnectScript(
  port: number | undefined,
  projectId: string | undefined,
  uiLibrary: UiLibrary,
): string {
  // Must match what `frameworkPackages` installed. Astro hosts islands from any framework, so an
  // Astro app whose islands are Vue or Svelte gets the sensor, and a script importing the React
  // adapter would load a package that is not in node_modules. See sdkImport.
  const sdk = sdkImport(uiLibrary);
  const url =
    port !== undefined && port !== RETICLE_DEFAULT_PORT
      ? `\n          url: '${bridgeWsUrl(port)}',`
      : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n          projectId: '${projectId}',` : '';
  return `    <script>
      if (import.meta.env.DEV) {
        const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
        const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
        const { reticle${sdk.usesInstall ? ', install' : ''} } = await import('${sdk.specifier}');
        ${sdk.usesInstall ? 'install();' : '// The sensor has no install(); that is the React adapter.'}
        reticle.connect({${id}${url}
          ...(token.length > 0 ? { token } : {}),
          ...(root.length > 0 ? { root } : {}),
        });
      }
    </script>
`;
}

export function patchAstroLayout(
  source: string,
  port: number | undefined,
  projectId: string | undefined,
  uiLibrary: UiLibrary = UiLibrary.REACT,
): SourcePatch {
  if (source.includes(LAYOUT_MARKER)) return { kind: PatchKind.ALREADY };
  const at = source.lastIndexOf(BODY_CLOSE);
  if (at < 0) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a `</body>` to place the connect script before",
    };
  }
  return {
    kind: PatchKind.APPLY,
    code: `${source.slice(0, at)}${astroConnectScript(port, projectId, uiLibrary)}${source.slice(at)}`,
  };
}

/** Where Astro keeps ambient types — `create-astro` ships this file. */
export const ASTRO_ENV_DTS_PATH = 'src/env.d.ts';

/**
 * The declarations `astro check` needs for the Vite `define` names (#677).
 *
 * Matching SvelteKit's `hooks.client.ts` typing: `string | undefined`, because the define can be
 * absent when the pairing token file is missing.
 */
export const ASTRO_ENV_DTS_DECLARES =
  'declare const __RETICLE_TOKEN__: string | undefined;\n' +
  'declare const __RETICLE_ROOT__: string | undefined;\n';

/** Present once either declare is in the file — both are written together. */
const ENV_DTS_MARKER = '__RETICLE_TOKEN__';

/**
 * Append the Vite-define ambient declarations to `src/env.d.ts`, or create the file.
 *
 * Without this, `create-astro`'s default `"astro check && astro build"` fails with four
 * `ts(2304) Cannot find name '__RETICLE_TOKEN__'` errors after a clean init (#677).
 */
export function patchAstroEnvDts(existing: string | null): SourcePatch {
  if (null !== existing && existing.includes(ENV_DTS_MARKER)) {
    return { kind: PatchKind.ALREADY };
  }
  if (null === existing || '' === existing.trim()) {
    return { kind: PatchKind.APPLY, code: ASTRO_ENV_DTS_DECLARES };
  }
  const base = existing.endsWith('\n') ? existing : `${existing}\n`;
  return { kind: PatchKind.APPLY, code: `${base}${ASTRO_ENV_DTS_DECLARES}` };
}
