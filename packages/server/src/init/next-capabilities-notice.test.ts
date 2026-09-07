/**
 * The "your capabilities file registers nothing" notice must not be a Vite-only courtesy.
 *
 * `capabilitiesStep` is called from `viteSteps` and from nowhere else, so the `ℹ AGENT: finish the
 * capabilities file` notice has only ever appeared on Vite apps. Next bakes the same
 * `registerCapabilities({ testids, stores })` call into `app/reticle-dev.tsx` through
 * `nextReticleDevFile`, and can produce exactly the same empty registration, with no notice and a
 * `✓` on every step.
 *
 * Measured 2026-08-23 against the `next14-mobx-monorepo` fixture (a real Next app, mobx in
 * `package.json`): `init` printed five steps, all `✓`, and no capabilities line at all. mobx is
 * adapter-wrapped, so init can only offer a commented hint, so the written file registers nothing,
 * so `hasCapabilities` stays false and `reticle_state` has nothing to read. Permanently, silently.
 *
 * This is the same defect already fixed for Vite, one framework over. The Vite fix keyed the notice
 * on what the file REGISTERS rather than on what init could SUGGEST; the Next path never asked the
 * question at all.
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';

const CAPS_TODO = /finish the capabilities file/i;

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    detection: {
      framework: Framework.NEXT,
      uiLibrary: UiLibrary.REACT,
      typescript: true,
      reactMajor: 18,
      needsSourceMapping: true,
      packageManager: PackageManager.PNPM,
    } satisfies Detection,
    claudeCli: true,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: 'next.config.mjs',
    nextConfigSource: 'export default {}',
    nextLayout: { path: 'app/layout.tsx', source: 'export default function L(){return null}' },
    nextReticleDevExists: false,
    options: { port: undefined, mcp: true, install: false },
    ...partial,
  };
}

const notices = (p: ReturnType<typeof buildPlan>) =>
  p.steps.filter((s) => CAPS_TODO.test(s.title) && s.status === StepStatus.NOTICE);

describe('a Next app whose dev module registers nothing is told so', () => {
  /** The measured next14-mobx case: a library detected, only a commented hint possible. */
  it('fires when only a commented suggestion was produced', () => {
    expect(notices(buildPlan(input({ storeHints: ['mobx'], nextFoundStores: [] })))).toHaveLength(
      1,
    );
  });

  /** Same rule as the Vite path: with nothing specific to ask for, the notice is not asked for. */
  it('stays quiet when no library it could name was detected', () => {
    expect(notices(buildPlan(input({ storeHints: [], nextFoundStores: [] })))).toHaveLength(0);
  });
});

describe('it stays quiet when the Next dev module really registers something', () => {
  it('does not fire for a store init resolved and wrote a live call for', () => {
    const plan = buildPlan(
      input({
        storeHints: ['zustand'],
        nextFoundStores: [{ key: 'app', ident: 'useStore', importPath: './store' }],
      }),
    );
    expect(notices(plan)).toHaveLength(0);
  });

  it('does not fire when testids were found', () => {
    const plan = buildPlan(input({ testids: ['pay'], storeHints: [], nextFoundStores: [] }));
    expect(notices(plan)).toHaveLength(0);
  });

  /** An already-wired app is not re-nagged: the file exists and its contents are the user's. */
  it('does not fire when the dev module already exists', () => {
    const plan = buildPlan(
      input({ nextReticleDevExists: true, storeHints: ['mobx'], nextFoundStores: [] }),
    );
    expect(notices(plan)).toHaveLength(0);
  });
});
