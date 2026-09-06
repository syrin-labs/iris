/**
 * Wiring Reticle into a Create React App project.
 *
 * CRA had no automated path: init reported `⚠ Connect snippet → index.html`, a target that cannot
 * work. CRA's `public/index.html` is a static template the bundler never processes for modules, so a
 * bare import in it resolves to nothing. `src/index.tsx` is what gets bundled, and that is where the
 * connect has to arrive.
 *
 * The token is the second half of the problem. Every other stack has somewhere to inline it —
 * Vite defines `__RETICLE_TOKEN__`, the Astro and HTML snippets read the file in Node. `src/index.tsx`
 * is browser code inside a bundler that inlines exactly one thing: environment variables prefixed
 * `REACT_APP_`. So it travels through `.env.development.local`, which is CRA's own documented
 * mechanism and is gitignored by CRA's own template.
 */

import { bridgeWsUrl } from '@reticlehq/core';
import { CLI } from './agent-rules.js';

/** The line added to `src/index.tsx` / `src/index.js`. Side-effect import: the module guards itself on NODE_ENV. */
export const CRA_DEV_MODULE_IMPORT = "import './reticle-dev';";

/**
 * Where the connect module lands — `.ts` only when the app already speaks TypeScript.
 *
 * A JavaScript CRA project has no tsconfig and cannot resolve `.ts` (#675). Emitting `.ts` there
 * makes the first compile after init fail while the plan still reports `[✓]`.
 */
export function craDevModulePath(typescript: boolean): string {
  return typescript ? 'src/reticle-dev.ts' : 'src/reticle-dev.js';
}

/** TypeScript default path — prefer `craDevModulePath` when the project's language is known. */
export const CRA_DEV_MODULE_PATH = craDevModulePath(true);
export const CRA_ENV_PATH = '.env.development.local';
export const TOKEN_VAR = 'REACT_APP_RETICLE_TOKEN';
/**
 * The bridge URL, carried through the same channel as the token.
 *
 * CRA is the one supported stack with no build-time hook of ours: no plugin, no config wrapper, no
 * `define`. Vite and Astro re-resolve the daemon every dev-server start and Next does it through
 * `withReticle`; CRA has nowhere to run that code. So the URL goes where the token already goes, and
 * is refreshed by the same `init` step that refreshes the token.
 *
 * That makes `reticle init` the heal rather than the dev server, which is weaker and is stated
 * plainly in the step's own detail. It is still strictly better than a URL frozen into a source file
 * the owner has to hand-edit, and `.env.development.local` is already the per-machine file.
 */
export const URL_VAR = 'REACT_APP_RETICLE_URL';

/**
 * What the app itself says when the token is not there.
 *
 * The token is a per-machine secret and CRA's own template gitignores the file it lives in, so it
 * CANNOT travel with the repo — that part is correct and must stay. What was wrong is that it failed
 * silently: a teammate clones, runs `npm start`, and the app connects with an empty token, so the
 * only signal is the bridge's generic `authentication failed` in a console nobody had open. Naming
 * the variable, the gitignored file and the one command that fixes it turns a dead app into a
 * one-line repair. Every other stack reads the token in Node at dev-server start (the Vite plugin,
 * withReticle); CRA has no such hook without ejecting, so this message is the fix.
 */
export const CRA_TOKEN_MISSING_NOTE =
  `${TOKEN_VAR} is not set, so Reticle cannot pair with the daemon. ` +
  `The pairing token is per-machine and ${CRA_ENV_PATH} is gitignored by CRA's template, ` +
  `so it does not survive a clone. Run \`${CLI} init\` in this project to write it for this machine.`;

/**
 * Said as its own NOTICE line, beside the write — not inside it.
 *
 * The caveat has always been in the write step's `detail`, and the write step renders `[✓]`. But
 * `SKILL.md` tells whoever reads the report: *"If every line is `✓`, `·` or `–`, skip to Step 4 and
 * validate."* So the one fact that makes this install conditional sat in the one place the reading
 * protocol says to ignore — which is exactly how it was reported to us as "4 OK marks and no
 * warning". The words were on screen; the reader was following instructions.
 *
 * It cannot simply be promoted: `run.ts` only writes steps whose status is APPLY, so demoting the
 * token step to NOTICE would stop it writing the token and break the install outright.
 */
export const CRA_TOKEN_PER_MACHINE_NOTICE =
  `${CRA_ENV_PATH} is in CRA's own .gitignore, so the token just written does not travel. ` +
  'It works on THIS machine and nowhere else: a teammate cloning the repo, CI, or a container ' +
  'gets an app that boots, never pairs, and reports it only in the browser console. ' +
  `Each developer runs \`${CLI} init\` once locally.`;

/** Add the import after the last existing one, or null when it is already present. */
export function craImportPatch(source: string): string | null {
  if (source.includes(CRA_DEV_MODULE_IMPORT)) return null;
  const lines = source.split('\n');
  // After the LAST import: React's own imports must still run first, and a side-effect import placed
  // above them would connect before the app exists.
  let lastImport = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*import\s/.test(line)) lastImport = index;
  }
  lines.splice(lastImport + 1, 0, CRA_DEV_MODULE_IMPORT);
  return lines.join('\n');
}

/** Set the token variable, or null when nothing needs to change. */
export function craEnvPatch(existing: string | null, token: string, url?: string): string | null {
  if ('' === token) return null;
  const pairs: readonly (readonly [string, string])[] = [
    [TOKEN_VAR, token],
    ...(url !== undefined && url.length > 0 ? [[URL_VAR, url] as const] : []),
  ];
  let next = null === existing || '' === existing.trim() ? '' : existing;
  for (const [name, value] of pairs) {
    const line = `${name}=${value}`;
    if (next.includes(line)) continue;
    // Replace rather than append: two assignments of one variable is a silent coin flip on which
    // wins, and for the URL that coin decides which daemon the app talks to.
    if (new RegExp(`^${name}=`, 'm').test(next)) {
      next = next.replace(new RegExp(`^${name}=.*$`, 'm'), line);
    } else {
      next = `${'' === next || next.endsWith('\n') ? next : `${next}\n`}${line}\n`;
    }
  }
  return next === (existing ?? '') ? null : next;
}

/** Options for the CRA connect module. */
interface CraDevModuleOptions {
  /**
   * When false, emit a `.js`-shaped body (no `export {}`). Default true for callers that predate
   * the language branch.
   */
  typescript?: boolean;
}

/** The dev-only connect module imported from the app entry. */
export function craDevModuleFile(
  port: number | undefined,
  projectId?: string,
  options: CraDevModuleOptions = {},
): string {
  const typescript = false !== options.typescript;
  const fields: string[] = [];
  // `bridgeWsUrl`, not a hand-written string. This was the only client URL in the product spelling
  // the host as `127.0.0.1` while every other generator said `localhost` — same endpoint, but a
  // difference with no reason behind it is the kind that becomes a real one after somebody edits half
  // of it.
  if (port !== undefined) fields.push(`url: '${bridgeWsUrl(port)}'`);
  if (projectId !== undefined && projectId.length > 0) fields.push(`projectId: '${projectId}'`);
  // Multiline on purpose (#684): a single-line connect + console.error fails CRA boilerplate
  // Prettier (printWidth 80) and the project's own lint blocks a clean install.
  const connectFields = [
    ...fields.map((f) => `      ${f},`),
    '      ...(url.length > 0 ? { url } : {}),',
    '      ...(token.length > 0 ? { token } : {}),',
  ].join('\n');
  // Split so every emitted line stays under a CRA boilerplate printWidth of 80 (#684). A single
  // JSON.stringify of the whole note is ~290 characters and fails prettier-as-eslint on install.
  // Chunks are joined with `+` in the emitted file; together they equal `[reticle] ${CRA_TOKEN_MISSING_NOTE}`.
  const missingChunks = [
    `[reticle] ${TOKEN_VAR} is not set, so Reticle `,
    'cannot pair with the daemon. The pairing token is ',
    `per-machine and ${CRA_ENV_PATH} is gitignored by `,
    "CRA's template, so it does not survive a clone. Run ",
    `\`${CLI} init\` in this project to write it for this `,
    'machine.',
  ].map((c) => JSON.stringify(c));
  // Eight spaces match the indent inside `console.error(` below.
  const missingExpr = missingChunks.join(' +\n        ');
  // `export {}` is a TypeScript empty-module marker. A `.js` file with it is fine under Babel, but
  // the workaround reporters used was to drop it when renaming to `.js` — keep the JS emit clean.
  const trailer = typescript ? '\nexport {};\n' : '\n';
  return `// Dev-only: connect Reticle. Imported for its side effect from src/index.tsx.
//
// CRA's public/index.html is a static template the bundler never processes for
// modules, so the connect cannot live there. The pairing token arrives through
// REACT_APP_RETICLE_TOKEN because REACT_APP_* is the only thing CRA inlines
// into browser code.
if (process.env.NODE_ENV === 'development') {
  void import('@reticlehq/react').then(({ reticle, install }) => {
    install();
    const token = process.env.${TOKEN_VAR} ?? '';
    // Written by \`reticle init\` from the daemon that was live when it ran, and
    // refreshed by re-running it. CRA gives us no hook to resolve this at
    // dev-server start, so if the daemon moves, re-run \`reticle init\` rather
    // than editing the url below.
    const url = process.env.${URL_VAR} ?? '';
    // Loud on purpose: without this the only symptom is the bridge's generic
    // auth failure.
    if (token.length === 0) {
      console.error(
        ${missingExpr},
      );
    }
    // Still attempt it — a bridge running without a token pairs fine.
    reticle.connect({
${connectFields}
    });
  });
}
${trailer}`;
}
