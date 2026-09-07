/**
 * Astro was the last gated stack where `init` printed a correct recipe and applied none of it — the
 * only ⚠ left on a supported framework, and two hand-copied snippets before a user's first session.
 *
 * Auto-patching is only safe where the shape is unambiguous, so these pin BOTH directions: the
 * common shape is patched, and anything the patcher does not fully recognise (an existing `vite:`
 * key it would have to merge into, a layout with no `</body>`) bails to the printed recipe rather
 * than half-editing a build config.
 */

import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import {
  ASTRO_ENV_DTS_DECLARES,
  patchAstroConfig,
  patchAstroEnvDts,
  patchAstroLayout,
} from './astro-patch.js';
import { PatchKind } from './patch-kind.js';

const PLAIN_CONFIG = `import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [],
});
`;

const PLAIN_LAYOUT = `---
const { title } = Astro.props;
---
<html lang="en">
  <body>
    <slot />
  </body>
</html>
`;

describe('patchAstroConfig', () => {
  it('adds the token/root define and the raised build target to the common shape', () => {
    const patch = patchAstroConfig(PLAIN_CONFIG);
    expect(patch.kind).toBe(PatchKind.APPLY);
    if (patch.kind !== PatchKind.APPLY) return;
    expect(patch.code).toContain('__RETICLE_TOKEN__');
    // Without root, source pointers come back as absolute paths from the machine that ran init.
    expect(patch.code).toContain('__RETICLE_ROOT__');
    // Astro's default target down-levels the modern SDK bundle and dies on a destructuring transform.
    expect(patch.code).toContain("target: 'es2022'");
    expect(patch.code).toContain('defineConfig');
    expect(patch.code).toContain('integrations: []'); // the user's own config survives
  });

  it('is idempotent — a second init reports ALREADY rather than defining the token twice', () => {
    const once = patchAstroConfig(PLAIN_CONFIG);
    if (once.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patchAstroConfig(once.code).kind).toBe(PatchKind.ALREADY);
  });

  /**
   * This used to assert the OPPOSITE — that any `vite:` key bails to a manual step — and that belief
   * was the last genuine install defect in the gate. It bailed while the LAYOUT patch applied anyway,
   * so the app got a connect snippet with no inlined token and no raised build target: a guaranteed
   * non-connection, reported as one OK step and one warning.
   *
   * A `vite: { ... }` block is an object literal; our keys merge in after the brace and whatever is
   * already there is untouched. What still bails is a `vite:` that is NOT a literal — see below.
   */
  it('merges into an existing vite: object rather than bailing', () => {
    const withVite = `import { defineConfig } from 'astro/config';
export default defineConfig({
  vite: { build: { target: 'es2018' } },
});
`;
    const patch = patchAstroConfig(withVite);
    expect(patch.kind).toBe(PatchKind.APPLY);
    if (patch.kind !== PatchKind.APPLY) return;
    expect(patch.code).toContain('__RETICLE_TOKEN__');
    // The app's own setting survives — we add, never replace.
    expect(patch.code).toContain("target: 'es2018'");
  });

  it('refuses a config shape it does not recognise', () => {
    const patch = patchAstroConfig('export default {};\n');
    expect(patch.kind).toBe(PatchKind.MANUAL);
  });
});

describe('patchAstroLayout', () => {
  it('inserts the dev-only connect script before </body>', () => {
    const patch = patchAstroLayout(PLAIN_LAYOUT, undefined, undefined);
    expect(patch.kind).toBe(PatchKind.APPLY);
    if (patch.kind !== PatchKind.APPLY) return;
    expect(patch.code).toContain('reticle.connect');
    expect(patch.code).toContain('import.meta.env.DEV');
    expect(patch.code.indexOf('reticle.connect')).toBeLessThan(patch.code.indexOf('</body>'));
    expect(patch.code).toContain('<slot />'); // the user's own markup survives
  });

  it('carries a non-default port and the projectId into the connect', () => {
    const patch = patchAstroLayout(PLAIN_LAYOUT, 7331, 'shop-1a2b');
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patch.code).toContain('7331');
    expect(patch.code).toContain('shop-1a2b');
  });

  it('is idempotent — a layout already carrying a connect reports ALREADY', () => {
    const once = patchAstroLayout(PLAIN_LAYOUT, undefined, undefined);
    if (once.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patchAstroLayout(once.code, undefined, undefined).kind).toBe(PatchKind.ALREADY);
  });

  it('refuses a layout with no </body> rather than guessing where the script goes', () => {
    const patch = patchAstroLayout('<slot />\n', undefined, undefined);
    expect(patch.kind).toBe(PatchKind.MANUAL);
  });
});

/**
 * The config patch bailed on any `vite:` key, while the LAYOUT patch applied anyway.
 *
 * Measured on the astro-nanostores fixture — the only genuine install defect left in the gate:
 *
 *   [WARN] Astro config (token + build target) -> astro.config.ts     <- bailed
 *   [OK]   Connect snippet (Astro) -> src/layouts/Layout.astro        <- applied
 *
 * So the app got a connect snippet with no pairing token inlined and no raised build target, which
 * cannot connect. Half-wiring while reporting an OK step is worse than doing nothing: the OK reads as
 * progress, and the ⚠ reads as a caveat rather than the guaranteed failure it is.
 *
 * A `vite: {` block is an object literal we can merge into — our keys go straight after the brace,
 * and anything already there is untouched. A `vite:` that is NOT an object literal (a spread, an
 * imported config) still goes manual, because merging into that is not a text edit anyone can do
 * safely.
 */
describe('an Astro config that already configures vite', () => {
  it('merges into an existing empty vite block', () => {
    const source = `import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  vite: {},\n});\n`;
    const patch = patchAstroConfig(source);
    expect(patch.kind).toBe(PatchKind.APPLY);
    expect(patch.kind === PatchKind.APPLY && patch.code).toContain('__RETICLE_TOKEN__');
  });

  it('merges without disturbing what is already in there', () => {
    const source = `import { defineConfig } from 'astro/config';\nimport mdx from '@astrojs/mdx';\nexport default defineConfig({\n  integrations: [mdx()],\n  vite: {\n    plugins: [somePlugin()],\n    server: { port: 4321 },\n  },\n});\n`;
    const patch = patchAstroConfig(source);
    expect(patch.kind).toBe(PatchKind.APPLY);
    const out = patch.kind === PatchKind.APPLY ? patch.code : '';
    expect(out).toContain('somePlugin()');
    // The port survives; it is no longer contiguous with `server: {` because the watcher ignore
    // merges into that same object.
    expect(out).toContain('port: 4321');
    expect(out).toContain('integrations: [mdx()]');
    expect(out).toContain('__RETICLE_TOKEN__');
  });

  it('still refuses a vite value that is not an object literal', () => {
    // `vite: sharedViteConfig` cannot be merged by editing text, and guessing would corrupt the file.
    const source = `import { defineConfig } from 'astro/config';\nimport sharedViteConfig from './vite.shared';\nexport default defineConfig({\n  vite: sharedViteConfig,\n});\n`;
    expect(patchAstroConfig(source).kind).toBe(PatchKind.MANUAL);
  });

  it('is still idempotent — a second run changes nothing', () => {
    const source = `import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  vite: {},\n});\n`;
    const once = patchAstroConfig(source);
    const content = once.kind === PatchKind.APPLY ? once.code : '';
    expect(patchAstroConfig(content).kind).toBe(PatchKind.ALREADY);
  });
});

/**
 * Merging blindly produced a DUPLICATE key, and the app's copy won.
 *
 * The real astro-nanostores config is `vite: { plugins: [...], build: { chunkSizeWarningLimit } }`.
 * Inserting our block after `vite: {` gave the object TWO `build` keys — and in a JS object literal
 * the last one wins, so `target: 'es2022'` was silently discarded while `init` reported ✓.
 *
 * That is worse than the bail it replaced. The whole reason the block exists is that Astro's default
 * target down-levels the modern SDK bundle and dies on a destructuring transform; losing `target`
 * while claiming success is a green that cannot go red.
 *
 * So a key we would collide with is merged INTO, not duplicated — and if it is not an object literal
 * we can merge into, we go back to refusing, because a corrupted build config is the worst outcome.
 */
describe('merging beside keys the app already set', () => {
  const REAL_SHAPE = `import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    build: {
      chunkSizeWarningLimit: 1500,
    },
  },
})
`;

  it('never emits a duplicate `build` key', () => {
    const patch = patchAstroConfig(REAL_SHAPE);
    expect(patch.kind).toBe(PatchKind.APPLY);
    const out = patch.kind === PatchKind.APPLY ? patch.code : '';
    // Two `build:` inside one object means ours is dead code.
    expect(out.match(/^\s*build\s*:/gm) ?? []).toHaveLength(1);
  });

  it('injects the target INTO the existing build block, keeping what was there', () => {
    const patch = patchAstroConfig(REAL_SHAPE);
    const out = patch.kind === PatchKind.APPLY ? patch.code : '';
    expect(out).toContain("target: 'es2022'");
    expect(out).toContain('chunkSizeWarningLimit: 1500');
    expect(out).toContain('plugins: [tailwindcss()]');
  });

  it('still inlines the token, which is the point of the whole patch', () => {
    const patch = patchAstroConfig(REAL_SHAPE);
    const out = patch.kind === PatchKind.APPLY ? patch.code : '';
    expect(out).toContain('__RETICLE_TOKEN__');
  });

  it('refuses when a colliding key is not an object literal we can merge into', () => {
    const hostile = `import { defineConfig } from 'astro/config'
export default defineConfig({
  vite: {
    build: sharedBuildConfig,
  },
})
`;
    expect(patchAstroConfig(hostile).kind).toBe(PatchKind.MANUAL);
  });
});

/**
 * The Astro connect does `await import('@reticlehq/react')`, and nothing told Vite the SDK exists.
 *
 * So Vite meets it for the first time DURING the first page load, pre-bundles it, and the hashed URL
 * the browser already asked for stops existing:
 *
 *   uncaught: TypeError: Failed to fetch dynamically imported module:
 *   http://localhost:4322/node_modules/.vite/deps/@reticlehq_react.js?v=4ada8de3
 *
 * The import rejects, connect() never runs, and the page looks completely normal — no session, no
 * Reticle error, nothing in the console that names us. Measured on astro-nanostores, where it came
 * and went between runs depending on whether the dep cache happened to be warm; the install gate
 * blamed a different fixture each sweep until the uncaught exception was captured.
 *
 * The Vite plugin has declared the SDK in `optimizeDeps.include` since this bug was first found on a
 * React app. Astro does not use that plugin — its config is patched by hand — so it never got the
 * same protection.
 */
describe('the SDK is pre-declared so the first load is not lost to a dep-optimization', () => {
  it('declares the SDK in optimizeDeps.include on the common shape', () => {
    const patch = patchAstroConfig(PLAIN_CONFIG);
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patch.code).toContain("include: ['@reticlehq/react']");
  });

  it('declares it when the app already has a vite block without optimizeDeps', () => {
    const source = `import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  vite: {\n    server: { port: 4321 },\n  },\n});\n`;
    const patch = patchAstroConfig(source);
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patch.code).toContain("include: ['@reticlehq/react']");
    // The port survives; it is no longer contiguous with `server: {` because the watcher ignore
    // merges into that same object.
    expect(patch.code).toContain('port: 4321');
  });

  it('adds the SDK to an optimizeDeps.include the app already has, rather than shadowing it', () => {
    const source = `import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  vite: {\n    optimizeDeps: { include: ['their-dep'] },\n  },\n});\n`;
    const patch = patchAstroConfig(source);
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    // A SECOND `include:` key in the same object literal is not a merge — the last one wins and one
    // of the two silently disappears. Exactly how `build.target` was lost while init reported OK.
    expect(patch.code).toContain('their-dep');
    expect(patch.code).toContain('@reticlehq/react');
    expect(patch.code.match(/include\s*:/g)?.length ?? 0).toBe(1);
  });
});

/**
 * The daemon journals into `.reticle/` in the project root and rewrites `ambient.json` atomically
 * (`.tmp` + rename) for as long as a session is live. Astro dev is a Vite dev server watching that
 * root, and `.reticle/` is not in Vite's default ignore list — so each journal write read as a
 * project file changing and Vite answered with a full page reload, which reconnected the SDK, which
 * produced more journal writes. The loop ran several times a second and made every ref stale.
 *
 * Astro does not load the Vite plugin, so the plugin's fix does not reach it.
 */
/**
 * Pull the regex literal out of the emitted config and use it as a real matcher. Asserting on the
 * TEXT alone is how a dead ignore ships: a glob reads correctly, passes `toContain`, and matches
 * nothing on the chokidar Vite 7+ actually uses.
 */
const emittedWatchMatcher = (code: string): RegExp => {
  // Greedy on purpose: the pattern contains `/` inside a character class, so a lazy match stops
  // inside it and produces an unterminated expression.
  const literal = /ignored:\s*\[\/(.+)\/\]/.exec(code);
  if (literal?.[1] === undefined) throw new Error(`no regex literal in: ${code}`);
  return new RegExp(literal[1]);
};

describe('patchAstroEnvDts (#677)', () => {
  it('creates src/env.d.ts when the file is absent', () => {
    const patch = patchAstroEnvDts(null);
    expect(patch.kind).toBe(PatchKind.APPLY);
    if (patch.kind !== PatchKind.APPLY) return;
    expect(patch.code).toBe(ASTRO_ENV_DTS_DECLARES);
  });

  it('appends the declares without clobbering an existing create-astro env.d.ts', () => {
    const existing = '/// <reference path="../.astro/types.d.ts" />\n';
    const patch = patchAstroEnvDts(existing);
    expect(patch.kind).toBe(PatchKind.APPLY);
    if (patch.kind !== PatchKind.APPLY) return;
    expect(patch.code).toContain('reference path');
    expect(patch.code).toContain('__RETICLE_TOKEN__');
    expect(patch.code).toContain('__RETICLE_ROOT__');
  });

  it('is a no-op when the declares are already present', () => {
    expect(patchAstroEnvDts(ASTRO_ENV_DTS_DECLARES).kind).toBe(PatchKind.ALREADY);
  });
});

describe('the daemon journal does not drive the dev server', () => {
  it('excludes the journal directory from the watcher', () => {
    const patch = patchAstroConfig(PLAIN_CONFIG);
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    const matcher = emittedWatchMatcher(patch.code);
    expect(matcher.test(`${ReticleDir.ROOT}/ambient.json`)).toBe(true);
    expect(matcher.test(`src/${ReticleDir.ROOT}/sessions/a/events.jsonl`)).toBe(true);
    // Not the journal — a file that merely starts the same way.
    expect(matcher.test('src/App.tsx')).toBe(false);
    expect(matcher.test(`${ReticleDir.ROOT}x/thing.json`)).toBe(false);
  });

  it('merges into a server block the app already has, rather than shadowing it', () => {
    const source = `import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  vite: {\n    server: { port: 4321 },\n  },\n});\n`;
    const patch = patchAstroConfig(source);
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected a patch');
    expect(patch.code).toContain('port: 4321');
    expect(emittedWatchMatcher(patch.code).test(`${ReticleDir.ROOT}/ambient.json`)).toBe(true);
    // A second `server:` key in the same object literal is not a merge — the last one wins.
    expect(patch.code.match(/server\s*:/g)?.length ?? 0).toBe(1);
  });
});
