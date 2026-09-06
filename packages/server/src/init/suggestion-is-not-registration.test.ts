/**
 * A commented-out suggestion is not a registration, and must not suppress the notice that exists to
 * say so.
 *
 * `capabilitiesStep` writes `src/reticle-dev.ts` and, when that file would register nothing, adds an
 * `ℹ AGENT: finish the capabilities file` notice beside the `✓`. The condition reads
 *
 *     nothingToRegister = 0 === testids.length && 0 === stores.length && 0 === wired.length
 *
 * `wired` (`foundStores`) are stores init RESOLVED and wrote a live `registerStore` call for — those
 * correctly suppress the notice. `stores` (`storeHints`) are only SUGGESTIONS: a commented line of
 * the form `// import your store, then: registerStore('app', jotaiStore(...))`. Counting a
 * suggestion as a registration means the hint silences the notice whose whole job is to say "act on
 * the hint".
 *
 * Measured 2026-08-23 against the `vite-react` fixture (rowy — a real product UI, 70+ deps, jotai
 * with a whole `src/atoms/` tree). `init` detected jotai, offered one commented line, emitted NO
 * notice, and printed:
 *
 *     [✓] Capabilities + store → src/reticle-dev.ts
 *         no data-testid values yet; store: uncomment the 1 suggested line(s)
 *
 * The written file was `registerCapabilities({ testids: [], signals: [], stores: [] })` — nothing.
 * So `hasCapabilities` stays false, `reticle_state` returns empty forever, and the install gate
 * reported `connected: 1, manual ⚠: none`. Every check green, state observability zero.
 *
 * This is the COMMON case, not an edge one: a state library whose registration needs an argument
 * only reading the source supplies (jotai atoms, an XState actor, a TanStack queryClient) is
 * exactly the case init leaves commented.
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';

const CAPS_TODO = /finish the capabilities file/i;

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    detection: {
      framework: Framework.VITE,
      uiLibrary: UiLibrary.REACT,
      typescript: true,
      reactMajor: 18,
      needsSourceMapping: true,
      packageManager: PackageManager.NPM,
    } satisfies Detection,
    claudeCli: true,
    mcpExists: false,
    viteConfig: {
      path: 'vite.config.ts',
      source: 'export default defineConfig({ plugins: [react()] })',
    },
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: undefined, mcp: true, install: false },
    ...partial,
  };
}

const notices = (p: ReturnType<typeof buildPlan>) =>
  p.steps.filter((s) => CAPS_TODO.test(s.title) && s.status === StepStatus.NOTICE);

describe('the capabilities notice tracks what the file REGISTERS', () => {
  /** The measured rowy case: a library detected, one commented suggestion, nothing registered. */
  it('fires when only a commented suggestion was produced', () => {
    const plan = buildPlan(input({ storeHints: ['jotai'], foundStores: [] }));
    expect(notices(plan)).toHaveLength(1);
  });

  /**
   * No state library detected is no longer a reason to nag. Testids are read from the live DOM and
   * a context-provided store registers itself, so there is nothing specific to ask for — and a
   * notice that names no library and no file to open is turns spent on generic advice.
   */
  it('stays quiet when no library it could name was detected', () => {
    const plan = buildPlan(input({ storeHints: [], foundStores: [] }));
    expect(notices(plan)).toHaveLength(0);
  });
});

describe('it stays quiet when the file really does register something', () => {
  /** A store init resolved and wrote a live call for IS a registration. */
  it('does not fire for a wired store', () => {
    const plan = buildPlan(
      input({
        storeHints: ['zustand'],
        foundStores: [{ key: 'app', ident: 'useStore', importPath: './store' }],
      }),
    );
    expect(notices(plan)).toHaveLength(0);
  });

  /** Testids are observed at runtime, so they neither cause the notice nor suppress a real one. */
  it('does not fire when testids were found', () => {
    const plan = buildPlan(input({ testids: ['pay', 'cart'], storeHints: [], foundStores: [] }));
    expect(notices(plan)).toHaveLength(0);
  });

  it('still fires for an unreachable store even when testids were found', () => {
    const plan = buildPlan(input({ testids: ['pay'], storeHints: ['jotai'], foundStores: [] }));
    expect(notices(plan)).toHaveLength(1);
  });
});
