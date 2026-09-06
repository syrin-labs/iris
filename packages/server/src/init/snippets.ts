/**
 * Generated file contents and copy-paste snippets for `reticle init`. Kept as named constants/builders
 * so the runner never inlines free strings.
 */

import {
  RETICLE_DEFAULT_PORT,
  ReticleDir,
  bridgeWsUrl,
  RETICLE_CLIENT_HOST,
  RETICLE_WS_PATH,
} from '@reticlehq/core';
import { UiLibrary } from './detect.js';
import type { FoundStore } from './capabilities.js';
import { SERVER_VERSION } from '../version/server-version.js';

/**
 * The SDK as one import a plain page can actually resolve.
 *
 * `init` used to tell static-HTML users that a page with no build step could not load the SDK, and
 * to go and stand up a bundler. That is true of a BARE specifier and false of a URL, and the
 * difference was the whole road for every server-rendered app we hear from: FastAPI, Flask, Django,
 * Streamlit, Rails. Proven end to end before this shipped, on a page served by `python3 -m
 * http.server`: a session connected, a snapshot returned, and two act_and_wait calls came back
 * `verified: "yes"`.
 *
 * jsDelivr rather than esm.sh, measured: a third of the requests and a third of the bytes for the
 * same result. `/+esm` is what makes it work, and the bare package URL does NOT: every file in
 * `dist` still carries bare workspace specifiers such as `@reticlehq/core`, so an unbundled entry
 * point dies on the first import. That is also why adding `unpkg`/`jsdelivr` fields to package.json
 * would not help.
 *
 * PINNED to this server's version on purpose. A floating import upgrades the page SDK underneath a
 * daemon that did not move, which is `version_skew` arriving by a route nothing checks.
 */
const CDN_SDK_URL = `https://cdn.jsdelivr.net/npm/@reticlehq/browser@${SERVER_VERSION}/+esm`;

/**
 * The connect argument literal: a non-default port adds a `url`, and a projectId is always passed
 * (so the app is identifiable across port changes). Empty string only when neither applies.
 */
function connectArg(port: number | undefined, projectId?: string): string {
  const parts: string[] = [];
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) {
    parts.push(`url: '${bridgeWsUrl(port)}'`);
  }
  if (projectId !== undefined && projectId.length > 0) parts.push(`projectId: '${projectId}'`);
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}

/**
 * The same literal, with the pairing token folded in.
 *
 * The token belongs INSIDE the call the user pastes. Every other stack has a build step to inline
 * it (the Vite plugin's `define`, Next's NEXT_PUBLIC_*, Astro's config, CRA's .env); the hand-wired
 * paths have none, so `init` inlines the literal it already read. Without it the bridge closes the
 * socket with AUTH_FAILED and no session ever appears: see Bridge's hello handler.
 *
 * An empty token is omitted rather than emitted as `token: ''`. A daemon that could not write to
 * $HOME runs without auth and trusts loopback, and an empty string would fail the comparison against
 * one that does hold a token.
 */
export function connectArgWithToken(
  port: number | undefined,
  projectId: string | undefined,
  pairingToken: string | undefined,
): string {
  const base = connectArg(port, projectId);
  if (pairingToken === undefined || 0 === pairingToken.length) return base;
  const inner = base.length > 0 ? base.slice(1, -1).trim() : '';
  return `{ ${[inner, `token: '${pairingToken}'`].filter((p) => p.length > 0).join(', ')} }`;
}

/**
 * Which SDK package the GENERATED code should import, and whether `install()` applies.
 *
 * This has to agree with `frameworkPackages`, and it did not. That function was changed so a Vue or
 * Svelte app installs `@reticlehq/browser` instead of the React adapter — correctly — while every
 * generated connect snippet still said `import('@reticlehq/react')`. A SvelteKit app would have
 * installed the sensor and then run a hook importing a package that is not there.
 *
 * `install()` is the React adapter's, not the sensor's: `@reticlehq/browser` exports `reticle` and no
 * `install`, so swapping the specifier alone would trade a missing module for a missing export.
 */
export function sdkImport(uiLibrary: UiLibrary): { specifier: string; usesInstall: boolean } {
  const react = uiLibrary !== UiLibrary.VUE && uiLibrary !== UiLibrary.SVELTE;
  return react
    ? { specifier: '@reticlehq/react', usesInstall: true }
    : { specifier: '@reticlehq/browser', usesInstall: false };
}

/**
 * The framework plugin to show ALONGSIDE reticle() in the example, so the ordering is clear.
 *
 * It used to be `react()` unconditionally, which is what a Vue app was shown — a plugin it does not
 * have, four lines after `init` had correctly detected Vue and said so. The example exists to show
 * that `reticle()` goes last, not to tell anyone which UI framework they are using.
 */
function frameworkPluginExample(uiLibrary: UiLibrary): string {
  switch (uiLibrary) {
    case UiLibrary.VUE:
      return 'vue()';
    case UiLibrary.SVELTE:
      return 'svelte()';
    case UiLibrary.REACT:
    case UiLibrary.PREACT:
      return 'react()';
    default:
      // Nothing detected: name no plugin rather than invent one. The reader keeps whatever they have.
      return '/* your existing plugins */';
  }
}

/** The Vite-config snippet printed when we can't safely auto-patch the config. */
export function viteManual(
  port: number | undefined,
  uiLibrary: UiLibrary = UiLibrary.UNKNOWN,
): string {
  const call = port === undefined ? 'reticle()' : `reticle({ port: ${String(port)} })`;
  return `Add the Reticle plugin to your Vite config:

  import { reticle } from '@reticlehq/vite-plugin';

  export default defineConfig({
    plugins: [${frameworkPluginExample(uiLibrary)}, ${call}],
  });

Keep \`reticle()\` LAST so it sees the output of your other plugins. It only applies during \`vite\`
(dev) — it is dropped from \`vite build\`.`;
}

/** Next.js config wrap — always printed (we never auto-rewrite next.config). */
export function nextConfigManual(configFile: string): string {
  return `Wrap your ${configFile} export with withReticle (keeps SWC, dev-only):

  import { withReticle } from '@reticlehq/next';

  export default withReticle(nextConfig);`;
}

/**
 * The dev-only client component that connects Reticle after hydration.
 *
 * The token is not optional. The bridge requires a pairing token even on localhost, and unlike Vite
 * (where the plugin injects it) a Next app has to carry it through `withReticle`, which publishes it
 * as `NEXT_PUBLIC_RETICLE_TOKEN`. This file used to connect with only a projectId, so every Next
 * setup ended at `bridge refused the connection: authentication failed` and no session ever appeared.
 */
export function nextReticleDevFile(
  port: number | undefined,
  projectId?: string,
  testids: readonly string[] = [],
  stores: readonly string[] = [],
  found: readonly FoundStore[] = [],
): string {
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  const ids = testids.map((t) => `'${t}'`).join(', ');
  // Same rule as the Vite module: a store we found is registered outright, and the commented hint
  // survives only for the libraries we can name but not wire.
  const storeImports = found.map((s) => `import { ${s.ident} } from '${s.importPath}';`).join('\n');
  // Eight spaces: nested inside useEffect → .then callback (see multiline shape below for #684).
  const storeBlock =
    found.length > 0
      ? found.map((s) => `        registerStore('${s.key}', ${s.ident});`).join('\n')
      : 0 === stores.length
        ? '        // No state library detected. If you add one, register it here — see node_modules/@reticlehq/server/docs/usage.md.'
        : stores.map((h) => `        // import your store, then: ${h}`).join('\n');
  const registerNames = found.length > 0 ? ', registerStore' : '';
  // Multiline connect + single blank after imports (#684): the one-line connect and the double blank
  // both fail Prettier on a clean Next install.
  return `'use client';
import { useEffect } from 'react';
${storeImports.length > 0 ? `${storeImports}\n` : ''}
/** Dev-only: connect Reticle + install the React adapter, after hydration. */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@reticlehq/react').then(
      ({ reticle, install, registerCapabilities${registerNames} }) => {
        install();
        // Both provided by withReticle() in next.config. The bridge rejects a connect with no token;
        // the root makes source paths repo-relative instead of absolute.
        const token = process.env.NEXT_PUBLIC_RETICLE_TOKEN;
        const root = process.env.NEXT_PUBLIC_RETICLE_ROOT;
        // withReticle() finds the daemon serving this project on every dev-server start. It wins over
        // any port written into this file at install time, so moving the daemon needs no edit here.
        const url = process.env.NEXT_PUBLIC_RETICLE_URL;
        reticle.connect({
          ${fields}...(url ? { url } : {}),
          ...(token ? { token } : {}),
          ...(root ? { root } : {}),
        });

        // ── Start with ONE flow. ────────────────────────────────────────────────────────────────
        // Registering a store is the highest-value line here: it lets the agent check what the app
        // BELIEVES, not just what it rendered. Pass the STORE, not \`() => store.getState()\` — the
        // store form wires \`subscribe\` too, so every mutation emits a diff; the getter form is
        // read-only.
${storeBlock}
        registerCapabilities({
          testids: [${ids}],${0 === testids.length ? ' // none found; add data-testid to your key elements' : ''}
          signals: [], // names you pass to reticle.signal()
          stores: [${found.map((s) => `'${s.key}'`).join(', ')}], // the keys you registered above
        });
      },
    );
  }, []);
  return null;
}
`;
}

/**
 * Astro connect instructions.
 *
 * Astro is Vite-based but SSRs its own HTML, so the plugin's index.html injection never fires, and
 * `vite` is not a direct dependency — so this used to fall through to the generic HTML advice, which
 * tells you to add a connect to an "entry module" Astro does not have, or to bundle the SDK with
 * esbuild. Both are wrong for Astro, and following either gets you nothing.
 *
 * Astro bundles a page `<script>`, so the bare import resolves there. The token has to be inlined by
 * the config because there is no plugin in the page's path to inject it, and `build.target` has to be
 * raised or Astro down-levels the modern SDK bundle and dies on a destructuring transform.
 */
/**
 * Name the file the connect <script> should go in — the layout when one exists, otherwise the page,
 * because a project with no layout has nowhere else to put it and should not be told otherwise.
 */
function layoutHost(layoutPath: string | undefined): string {
  return layoutPath === undefined
    ? '2. This project has no layout, so put it in the page you want instrumented (e.g.\n   src/pages/index.astro) — every page you want a session from needs it — inside <body>:'
    : `2. In ${layoutPath} (or any other page you want instrumented), inside <body>:`;
}

export function astroManual(
  port: number | undefined,
  projectId?: string,
  /**
   * A layout file that actually exists, when one does.
   *
   * Reported from the field: on `examples/framework-react` — which has no layout at all, only
   * `src/pages/index.astro` — init printed thirty lines telling the user to paste into "your
   * layout". Instructions that name a file the project does not have read as a mistake by the
   * reader, and cost them the time it takes to go and confirm it is missing.
   */
  layoutPath?: string,
): string {
  const extra =
    port !== undefined && port !== RETICLE_DEFAULT_PORT
      ? `\n          url: '${bridgeWsUrl(port)}',`
      : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n          projectId: '${projectId}',` : '';
  // Astro owns its Vite instance, so it has a build-time channel of its own: the same `define` that
  // already inlines the token can inline the daemon URL, resolved every time the config is read —
  // that is, on every `astro dev`. The port above is written once at install time and goes stale the
  // moment the daemon moves; this does not.
  //
  // Needs the projectId to know WHICH daemon is ours. Without one there is nothing to match on, and
  // adopting a daemon serving another project would report its state as this app's, so the whole
  // block is omitted rather than made to guess.
  const canDiscover = projectId !== undefined && projectId.length > 0;
  // Interpolated from core rather than typed into the template: this is the same wire string
  // `bridgeWsUrl` builds, and a generator that spells it out by hand is exactly how the four call
  // sites that constant exists to unify drifted apart in the first place.
  const RETICLE_CLIENT_HOST_LITERAL = `ws://${RETICLE_CLIENT_HOST}:`;
  const urlHelper = canDiscover
    ? `
  // The live daemon serving THIS project, re-read on every \`astro dev\`. Same rule as the Vite and
  // Next plugins: skip dead daemons, match on projectId, lowest port wins, '' when none matches.
  function reticleUrl() {
    const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
    let best;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('daemon-') || !file.endsWith('.json')) continue;
        let entry;
        try { entry = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
        if (entry.projectId !== '${projectId}') continue;
        try { process.kill(entry.pid, 0); } catch { continue; }
        if (best === undefined || entry.port < best) best = entry.port;
      }
    } catch { return ''; }
    return best === undefined ? '' : '${RETICLE_CLIENT_HOST_LITERAL}' + best + '${RETICLE_WS_PATH}';
  }
`
    : '';
  const urlDefine = canDiscover ? `\n        __RETICLE_URL__: JSON.stringify(reticleUrl()),` : '';
  const urlRead = canDiscover
    ? `\n      const url = typeof __RETICLE_URL__ !== 'undefined' ? __RETICLE_URL__ : '';`
    : '';
  // After the baked port, so the discovered one wins: later key in an object literal.
  const urlSpread = canDiscover ? `\n          ...(url.length > 0 ? { url } : {}),` : '';
  return `Astro renders its own HTML, so the connect goes in a page <script> and the pairing token is inlined by the config.

1. In astro.config.mjs — inline the daemon's token and raise the build target:

  import { readFileSync, readdirSync } from 'node:fs';
  import { homedir } from 'node:os';
  import { join } from 'node:path';

  function reticleToken() {
    const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
    try { return readFileSync(join(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
  }
${urlHelper}
  export default defineConfig({
    vite: {
      // Astro's default target down-levels the modern SDK bundle and fails on a destructuring transform.
      build: { target: 'es2022' },
      optimizeDeps: { esbuildOptions: { target: 'es2022' } },
      define: {
        __RETICLE_TOKEN__: JSON.stringify(reticleToken()),${urlDefine}
        // Without this, source pointers come back as absolute paths from YOUR machine — useless in a
        // report. Every other framework gets it from its build plugin; Astro owns its Vite instance.
        __RETICLE_ROOT__: JSON.stringify(process.cwd()),
      },
    },
  });

${layoutHost(layoutPath)}

  <script>
    if (import.meta.env.DEV) {
      const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
      const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';${urlRead}
      const { reticle, install } = await import('@reticlehq/react');
      install();
      reticle.connect({${id}${extra}${urlSpread}
          ...(token.length > 0 ? { token } : {}),
          ...(root.length > 0 ? { root } : {}),
      });
    }
  </script>

3. In src/env.d.ts — declare the Vite define names so \`astro check\` can see them (create-astro's
   default build runs check first, and without this it fails with Cannot find name '__RETICLE_TOKEN__'):

  declare const __RETICLE_TOKEN__: string | undefined;
  declare const __RETICLE_ROOT__: string | undefined;

Start the daemon BEFORE \`astro dev\`, so the token file exists when the config is read. Until it does the token is empty and the page reloads once the daemon is up.`;
}

/**
 * The app-side dev module the Vite plugin imports by convention.
 *
 * `registerCapabilities` tells the agent what it can drive without guessing; `registerStore` is the
 * one that matters most and the one we cannot write for you — detecting that an app depends on
 * zustand is easy, knowing which module exports the store instance is not, and a wrong import here
 * breaks the module everything else hangs off. So the store lines are generated COMMENTED, naming
 * the libraries actually found in package.json, with the exact call to uncomment.
 */
export function viteDevModuleFile(
  testids: readonly string[],
  stores: readonly string[],
  found: readonly FoundStore[] = [],
  uiLibrary: UiLibrary = UiLibrary.REACT,
): string {
  // The specifier has to be the package `frameworkPackages` installed. This file is the Vite path —
  // the commonest install there is — and it was hardcoded to `@reticlehq/react` while a Vue or
  // Svelte app was being given `@reticlehq/browser`, so the generated file imported something that
  // was not there. Caught by running `init` against a pristine Vue app, not by any gate.
  //
  // The sensor exports `registerCapabilities` and `registerStore` (and the store adapters) just as
  // the React kit does; the only thing it lacks is `install()`, which this file never called.
  const sdk = sdkImport(uiLibrary);
  const ids = testids.map((t) => `'${t}'`).join(', ');
  // A store we FOUND is imported and registered outright — the whole point of the file. The hints
  // stay only for the libraries we can name but not wire (they need an argument we cannot infer).
  const storeImports = found.map((s) => `import { ${s.ident} } from '${s.importPath}';`).join('\n');
  const storeBlock =
    found.length > 0
      ? found.map((s) => `  registerStore('${s.key}', ${s.ident});`).join('\n')
      : 0 === stores.length
        ? '  // No state library detected. If you add one, register it here — see node_modules/@reticlehq/server/docs/usage.md.'
        : stores.map((h) => `  // import your store, then: ${h}`).join('\n');
  const registerImport =
    found.length > 0 ? 'registerCapabilities, registerStore' : 'registerCapabilities';
  return `// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { ${registerImport} } from '${sdk.specifier}';
${storeImports.length > 0 ? `${storeImports}\n` : ''}
if (import.meta.env.DEV) {
  // ── Start with ONE flow. ─────────────────────────────────────────────────────────────────────
  // You do not need to describe the whole app to get value, and trying to is the slow path. Register
  // the store your most important flow reads, and list the testids that flow touches. Add more later,
  // when a flow you actually replay needs them.
  //
  // Registering a store is the highest-value line in this file: it lets the agent check what the app
  // BELIEVES, not just what it rendered — the class of bug a screenshot cannot see. Pass the STORE,
  // not \`() => store.getState()\`: the store form wires \`subscribe\` too, so every mutation emits a
  // state diff; the getter form is read-only and silently produces empty diffs.
${storeBlock}

  registerCapabilities({
    testids: [${ids}],${0 === testids.length ? ' // none found; add data-testid to your key elements' : ''}
    signals: [], // names you pass to reticle.signal()
    stores: [${found.map((s) => `'${s.key}'`).join(', ')}], // the keys you registered above
  });
}
`;
}

/** Where that module goes. Matches @reticlehq/vite-plugin's convention list. */
export const VITE_DEV_MODULE_PATH = 'src/reticle-dev.ts';

/** Default root-layout path, used when no layout was found on disk (reporting only). */
export const NEXT_LAYOUT_PATH = 'app/layout.tsx';

/** Mount instruction for the root layout. */
export const NEXT_LAYOUT_MANUAL = `Mount <ReticleDev /> in your root layout (app/layout.tsx), dev-only:

  import { ReticleDev } from './reticle-dev';
  // inside <body>:
  {process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}`;

/**
 * Manual connect guidance for projects without a Vite/Next plugin. Most such projects still use a
 * BUNDLER (CRA, webpack, Parcel, Vue/Svelte CLIs) — for those, the connect goes in the entry MODULE,
 * where a bare `@reticlehq/react` import resolves. A bare import in a plain index.html does NOT resolve in
 * the browser, so we never tell a bundled app to do that (the old advice silently failed for CRA).
 */
/**
 * The whole install, for a page with no build step, as one block a person can paste.
 *
 * Extracted so the `no package.json` exit can print the SAME snippet `htmlManual` offers. That exit
 * is the one every server-rendered app reaches (FastAPI, Flask, Django, Rails, Streamlit), it is
 * where `init` stops, and until now it stopped with an explanation instead of an answer. A message
 * that says "add the snippet below" and then prints no snippet is the same defect wearing the
 * opposite sign, so the two share a builder rather than a copy.
 */
export function staticPageSnippet(connectArgLiteral: string): string {
  return `      <script type="module">
        import { reticle } from '${CDN_SDK_URL}';
        reticle.connect(${connectArgLiteral});
      </script>`;
}

/**
 * Streamlit has no served HTML template, and `st.markdown` inserts script markup without executing
 * it. Streamlit 1.63 added an explicit JavaScript boundary to `st.html`; use a classic script there
 * so it can dynamically import the ESM SDK in the app document. A head marker makes reruns
 * idempotent and is removed after an import failure so the next rerun can retry.
 */
export function streamlitPageSnippet(connectArgLiteral: string): string {
  return `import streamlit as st

st.html(
    """
    <script>
      (() => {
        if (document.getElementById('reticle-streamlit-connect')) return;
        const marker = document.createElement('meta');
        marker.id = 'reticle-streamlit-connect';
        document.head.appendChild(marker);
        void import('${CDN_SDK_URL}')
          .then(({ reticle }) => reticle.connect(${connectArgLiteral}))
          .catch((error) => {
            marker.remove();
            throw error;
          });
      })();
    </script>
    """,
    unsafe_allow_javascript=True,
)`;
}

export function htmlManual(
  port: number | undefined,
  projectId?: string,
  pairingToken?: string,
): string {
  const withToken = connectArgWithToken(port, projectId, pairingToken);
  const tokenNote =
    pairingToken === undefined || 0 === pairingToken.length
      ? ''
      : `\n\n  The \`token\` is this machine's pairing token, read from ~/.reticle/pairing-token. Keep it: the
  bridge REJECTS a connect without it ("authentication failed") and no session appears. It is
  per-machine and local-only, so do not commit it — a teammate's daemon mints their own.`;
  return `No Vite/Next plugin detected — wire the dev-only connect by hand. Pick the form for your setup:

  • Bundled app (Create React App, webpack, Parcel, Vue/Svelte CLI, etc.) — add to your ENTRY module
    (e.g. src/index.js or src/main.js), where '@reticlehq/react' resolves through your bundler:

      if (process.env.NODE_ENV !== 'production') {
        void import('@reticlehq/react').then(({ reticle, install }) => {
          install();
          reticle.connect(${withToken});
        });
      }${tokenNote}

  • Plain HTML with NO build step (FastAPI, Flask, Django, Rails, Streamlit, a hand-written page) —
    paste this into the page, in a template you only serve in development. There is nothing to
    install: no npm, no bundler, no package.json.

${staticPageSnippet(withToken)}

  Serving the app on something other than localhost (a hosts-file alias, a LAN IP, a container, a
  tunnel)? You need TWO things, not one: \`allowNonLocalhost: true\` AND a pairing token, passed as
  \`token\` on the same connect. The flag alone is NOT sufficient — off localhost the SDK refuses
  without a token as well, and that refusal is page-side, so the daemon sees only silence and every
  \`reticle doctor\` check still passes. The token is the one in \`~/.reticle/pairing-token\` (the
  build plugins read the same file). Without both, the SDK says so in the browser console only, so
  from here it looks exactly like nothing happened.`;
}

export const NEXT_RETICLE_DEV_PATH = 'app/reticle-dev.tsx';
export const SVELTEKIT_HOOKS_PATH = 'src/hooks.client.ts';

/**
 * Said to the user's face rather than discovered later. React, Next, Remix and Astro each have an
 * app and a CI gate; SvelteKit has neither, so "it generated some wiring" is not evidence it works.
 */
/**
 * Said out loud when the app does not render through React. The SDK is framework-agnostic — DOM,
 * network, console and routing all still work — but `@reticlehq/react` is a React adapter, so
 * component names and source mapping do not, and no CI gate covers this stack. Reporting all-green
 * here is the one thing this project exists not to do.
 */
export function unverifiedUiLibraryNote(library: string): string {
  // Preact is not in the same position as Vue or Svelte and must not be told it is. The React
  // adapter reaches Preact through `preact/compat`, which is what `docs/frameworks.mdx` has always
  // said, so telling a Preact reader they get no component identity contradicts our own docs and
  // talks them out of a package that is the right one for them. It is still ungated, which is the
  // honest caveat, and #129 is the issue for closing that.
  const identity =
    'preact' === library
      ? 'React component identity — component names and stacks — comes from `@reticlehq/react`, which reaches Preact through `preact/compat`. That path is not covered by a CI gate here, so treat it as expected-to-work rather than proven.'
      : 'What `@reticlehq/react` adds and you will NOT get is React component identity: component names and component stacks.';
  return `Detected a ${library} app. Reticle's DOM, network, console and state tools work here. ${'vue' === library ? 'Source `file:line` does NOT come through: the build plugin stamps JSX and, separately, Svelte components, and a Vue single-file component is neither — measured, a Svelte counter reports `src/lib/Counter.svelte:5` and the same drive on Vue reports no source at all.' : 'Source `file:line` does too — the build plugin stamps it for this library (measured on preact and svelte).'} ${identity} ${'vue' === library ? 'The install gate scaffolds a Vue app from scratch on every change, so this SETUP is proven; no gate drives a Vue app to a verdict, so the drive is not.' : `No CI gate covers ${library}.`} Driven on every change: Vite + React, Next.js, Remix, Astro. If something doesn't work, please open an issue.`;
}

export const UNVERIFIED_FRAMEWORK_NOTE =
  'Reticle has no SvelteKit app and no CI gate for one, so this wiring is untested — it may work, but nothing proves it and nothing will tell us if it breaks. Supported and gated today: Vite + React, Next.js, Remix and Astro. If the hook does not register a session, please open an issue.';

/**
 * Dev-only client hook that connects Reticle in a SvelteKit app. SvelteKit renders through app.html and
 * never triggers Vite's index.html injection (verified), so the standard plugin can't auto-connect —
 * a client hook is the reliable path. SvelteKit runs src/hooks.client.ts on the client at startup.
 */
export function svelteKitHooksFile(
  port: number | undefined,
  projectId?: string,
  uiLibrary: UiLibrary = UiLibrary.SVELTE,
): string {
  // SvelteKit is Svelte, so this defaults to the sensor rather than the React adapter — and the
  // import here MUST match what `frameworkPackages` installed, or the hook loads a package that is
  // not in node_modules. See sdkImport.
  const sdk = sdkImport(uiLibrary);
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  return `// Dev-only: connect Reticle on the client. SvelteKit renders via app.html, so the Vite-plugin
// index.html injection doesn't fire — connect from this client hook instead.
if (import.meta.env.DEV) {
  void import('${sdk.specifier}').then(({ reticle${sdk.usesInstall ? ', install' : ''} }) => {
    ${sdk.usesInstall ? 'install();' : '// No React adapter here: the sensor has no install() to call.'}
    // The bridge requires the pairing token even on localhost. Nothing in a browser can read the
    // file it lives in, so @reticlehq/vite-plugin inlines it here at build time. Without it the
    // console reads "bridge refused the connection: authentication failed" and no session appears.
    const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
    const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
    const sdkVersion = typeof __RETICLE_SDK_VERSION__ !== 'undefined' ? __RETICLE_SDK_VERSION__ : '';
    reticle.connect({
      ${fields}...(token.length > 0 ? { token } : {}),
      ...(root.length > 0 ? { root } : {}),
      ...(sdkVersion.length > 0 ? { sdkVersion } : {}),
    });
  });
}

declare const __RETICLE_TOKEN__: string | undefined;
declare const __RETICLE_ROOT__: string | undefined;
declare const __RETICLE_SDK_VERSION__: string | undefined;
`;
}

/** The react-scripts major below which webpack cannot parse what @reticlehq/browser ships. */
export const WEBPACK4_REACT_SCRIPTS_MAJOR = 5;

/**
 * What to do when the bundler cannot parse our SDK at all.
 *
 * `@reticlehq/browser` ships untranspiled optional chaining and logical assignment.
 * react-scripts 4 runs webpack 4, whose parser predates both, AND excludes `node_modules` from
 * Babel -- so the build dies inside our `dist/` with a syntax error pointing at a file the user did
 * not write, before any session can exist (#680).
 *
 * Nothing else in `init` can catch this. Every check we run passes: the package installs, the entry
 * import is written, the token is inlined. The app simply does not compile, and the error names
 * `@reticlehq/browser/dist/index.js` rather than anything about Reticle.
 *
 * Two ways out, in the order a reader should consider them, because the second is the one that does
 * not require editing a bundler config to run a dev-only tool.
 */
export function webpack4TranspileNote(reactScriptsMajor: number): string {
  return `react-scripts ${String(reactScriptsMajor)} runs webpack 4, whose parser predates optional
  chaining and logical assignment. @reticlehq/browser ships both untranspiled, and react-scripts
  excludes node_modules from Babel — so \`npm start\` fails with a syntax error inside
  @reticlehq/browser/dist/index.js and no session is ever possible. Nothing else in this report can
  see that: the install, the import and the token are all correct.

  Either upgrade to react-scripts 5 (webpack 5 parses both natively, and needs no change on your
  side), or transpile this one package. With react-app-rewired or craco, add it to Babel's include:

      // config-overrides.js (react-app-rewired)
      const path = require('path');
      module.exports = (config) => {
        const rule = config.module.rules.find((r) => Array.isArray(r.oneOf))
          .oneOf.find((r) => String(r.test).includes('js') && r.include);
        rule.include = [rule.include, path.resolve('node_modules/@reticlehq/browser')];
        return config;
      };

  Scope it to @reticlehq/browser and nothing else: widening Babel across node_modules costs every
  rebuild in the project, for a dev-only dependency.`;
}

/** React Router's client-entry override point, in framework mode. */
export const REACT_ROUTER_ENTRY_PATH = 'app/entry.client.tsx';

/**
 * The React Router framework-mode recipe, printed rather than written.
 *
 * `app/entry.client.tsx` is an OVERRIDE: React Router supplies a default client entry, and the file
 * only exists once an app opts out of it. Generating one containing our import and nothing else
 * would replace that default with a file that never hydrates — an app that connected to Reticle and
 * rendered nothing. Same judgement `astroSteps` already makes about a layout: a half-written entry
 * is worse than a documented manual step.
 *
 * Two shapes, because the file may or may not be there, and the answer is different:
 *   - it exists  -> add one line to it, and only that line
 *   - it does not -> create it from React Router's own default, plus that line
 */
export function reactRouterManual(
  port: number | undefined,
  projectId?: string,
  entryExists = false,
): string {
  const connect = connectArg(port, projectId);
  const line = `if (import.meta.env.DEV) void import('/@reticle-connect');`;
  const head = `React Router framework mode renders HTML through its own request handler, so the Vite
  plugin's index.html injection never fires and the connect script never reaches the page. The
  plugin is still required — it stamps data-reticle-source, which is what puts file:line on every
  verdict — but connect() has to come from the client entry.`;
  if (entryExists) {
    return `${head}

  Add this to the TOP of ${REACT_ROUTER_ENTRY_PATH}, above the hydration call:

      ${line}

  The import is the module @reticlehq/vite-plugin serves; it carries the port, the project id and
  this machine's pairing token already, so there is nothing to fill in${0 === connect.length ? '' : ` (connect args: ${connect})`}.`;
  }
  return `${head}

  ${REACT_ROUTER_ENTRY_PATH} does not exist yet. It is an OVERRIDE of React Router's default client
  entry, so it has to hydrate as well as connect — a file containing only the import would replace
  the default with one that never hydrates. Create it with React Router's own default plus the
  import:

      import { HydratedRouter } from 'react-router/dom';
      import { StrictMode, startTransition } from 'react';
      import { hydrateRoot } from 'react-dom/client';

      ${line}

      startTransition(() => {
        hydrateRoot(
          document,
          <StrictMode>
            <HydratedRouter />
          </StrictMode>,
        );
      });

  Check it against your React Router version's documented default entry before saving — this is the
  v7 shape, and it is the half that must be right whether or not Reticle is in it.`;
}

/** Where a Nuxt dev-only client plugin belongs. `.client` keeps it out of SSR; Nuxt auto-registers it. */
export const NUXT_PLUGIN_PATH = 'app/plugins/reticle.client.ts';

/**
 * The Nuxt recipe, written out in full because every trap in it is one somebody actually hit.
 *
 * Reported from the field, in the order they were hit: `init` classified a Nuxt 4 app as `html`, so
 * it installed a package named `@reticlehq/react` (with `react` in its peer dependencies) into a Vue
 * codebase — the reporter only continued after auditing our dist to confirm there are no React
 * imports at runtime, which most people will not do. It then handed over a snippet guarded on
 * `window.location.hostname === 'localhost'`, which fails twice over in Nuxt: `window` does not
 * exist during SSR, and the dev host here was a hosts-file alias (required for the backend's
 * white-label origin detection), so the guard was false and the connect never ran — no error, no log
 * line, nothing to debug. And nothing said a running dev server does not pick up a new plugin.
 *
 * So: `import.meta.dev` (build-time, host-independent) instead of a hostname check, `.client.ts`
 * instead of an SSR guard, the framework-neutral sensor instead of the React kit, the non-localhost
 * flag named up front, and the restart said out loud.
 */
export function nuxtManual(port: number | undefined, projectId?: string): string {
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : base.slice(1, -1).trim();
  const connect = '' === fields ? 'reticle.connect()' : `reticle.connect({ ${fields} })`;
  return `Nuxt owns its own Vite instance and renders its own HTML, so there is no vite.config to patch
and no index.html to inject into. Wire it with a dev-only CLIENT plugin, which is Nuxt's own idiom:

1. Create ${NUXT_PLUGIN_PATH}:

     export default defineNuxtPlugin(() => {
       // import.meta.dev is the correct guard: it is resolved at build time, so it does not care
       // what hostname you develop on. Do NOT guard on window.location.hostname === 'localhost' —
       // that is false on any hosts-file alias or LAN address, and window does not exist in SSR.
       if (!import.meta.dev) return
       void import('@reticlehq/browser').then(({ reticle }) => {
         ${connect}
       })
     })

   The .client.ts suffix is load-bearing: it is what keeps this out of the server bundle.

2. Restart the dev server. A dev server that is already running does not pick up a new plugin —
   it will not appear in .nuxt/plugins/client.mjs, and the app will come up with no SDK at all.

3. If your dev host is anything other than localhost (a hosts-file alias, a LAN IP, a tunnel), that
   connect call needs TWO additions, not one: allowNonLocalhost: true AND a pairing token passed as
   token. The flag alone is NOT sufficient off localhost. The token is the one in
   ~/.reticle/pairing-token. Without both, the SDK loads and then refuses, and the only sign is one
   line in the browser console.

4. Add this to nuxt.config, so the dev server does not watch Reticle's own journal:

     vite: { server: { watch: { ignored: [/(^|[\\\\/])\\.${ReticleDir.ROOT.slice(1)}([\\\\/]|$)/] } } }

   Reticle journals every session into ${ReticleDir.ROOT}/ in your project root, rewriting one file
   in it continuously while a session is live. Nuxt's dev server watches that root, so without this
   it sees each write as a project file changing and full-reloads the page — which reconnects the
   SDK, which produces the next write. The loop runs several times a second and looks like anything
   except what it is: refs go stale, actions die mid-flight, and the session appears to flap.
   It is a RegExp rather than a glob on purpose — chokidar dropped glob support in v4, so a
   double-star pattern here is accepted and matches nothing.

The package is @reticlehq/browser — the framework-neutral sensor. DOM, network, console, routing and
source file:line all work in Vue. What you do not get is React component identity, which is the only
thing the React adapter adds. There is no Nuxt app in this project's CI, so this path is UNVERIFIED:
if something does not work, please open an issue.`;
}

/**
 * Root-level project config for Reticle. Written by `reticle init`; read by `reticle mcp` for the port
 * and by tooling for the stable projectId (the app's identity across port changes).
 */
export function reticleConfigContent(
  framework: string,
  port: number | undefined,
  projectId?: string,
  installSource?: string,
): string {
  const fields: Record<string, unknown> = { framework };
  if (projectId !== undefined && projectId.length > 0) fields['projectId'] = projectId;
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) fields['port'] = port;
  // How this install arrived, recorded HERE because it is a property of the install and the only
  // moment anything knows it is the moment it happens. It reaches us as an environment variable set
  // by whichever channel ran the install, and an environment variable is gone by the next command,
  // so every event after this one reported `unknown` and the question "which channel actually
  // converts" could not be asked at all. Written once, read for the life of the project.
  //
  // A closed vocabulary, narrowed before it gets here, so this can never carry a path or a URL.
  if (installSource !== undefined && installSource.length > 0) {
    fields['installSource'] = installSource;
  }
  return `${JSON.stringify(fields, null, 2)}\n`;
}
