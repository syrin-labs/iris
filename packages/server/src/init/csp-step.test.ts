/**
 * The CSP finding has to reach the plan, or it is a function nobody calls.
 *
 * Both reports were Next apps where every printed step said success. The user reads the plan, not
 * our source, so the check is worth exactly as much as its presence in that output.
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect.js';

function detection(framework: Framework): Detection {
  return {
    framework,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    packageManager: PackageManager.PNPM,
  };
}

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    detection: partial.detection ?? detection(Framework.NEXT),
    claudeCli: true,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: partial.nextConfigFile ?? 'next.config.mjs',
    nextConfigSource: partial.nextConfigSource,
    nextLayout: partial.nextLayout,
    nextReticleDevExists: false,
    cspSources: partial.cspSources,
    options: { port: undefined, mcp: true, install: false },
  };
}

function cspSteps(plan: ReturnType<typeof buildPlan>) {
  return plan.steps.filter((step) => /Content-Security-Policy|CSP/i.test(step.title));
}

describe('a CSP that blocks the bridge is reported by init', () => {
  it('warns when the Next config declares a connect-src that excludes the bridge', () => {
    const plan = buildPlan(
      input({
        nextConfigSource: `const csp = "default-src 'self'; connect-src 'self' https://api.example.com";`,
      }),
    );
    expect(cspSteps(plan)).toHaveLength(1);
  });

  it('hands over the exact dev-only text to paste, not a generic warning', () => {
    const plan = buildPlan(input({ nextConfigSource: `headers: "connect-src 'self'"` }));
    const [step] = cspSteps(plan);
    expect(step?.detail ?? '').toContain('ws://localhost:4400');
    expect(step?.detail ?? '').toContain('ws://127.0.0.1:4400');
  });

  it('is a NOTICE — something to know, not a step init can perform', () => {
    const plan = buildPlan(input({ nextConfigSource: `headers: "connect-src 'self'"` }));
    expect(cspSteps(plan)[0]?.status).toBe(StepStatus.NOTICE);
  });

  it('reads a CSP meta tag in the root layout too', () => {
    const plan = buildPlan(
      input({
        nextConfigSource: null,
        nextLayout: {
          path: 'app/layout.tsx',
          source: `<meta httpEquiv="Content-Security-Policy" content="connect-src 'self'" />`,
        },
      }),
    );
    expect(cspSteps(plan)).toHaveLength(1);
  });

  it('says nothing about an app with no CSP — this must never fire on a working setup', () => {
    const plan = buildPlan(input({ nextConfigSource: `module.exports = {};` }));
    expect(cspSteps(plan)).toHaveLength(0);
  });

  it('says nothing when the policy already admits the bridge', () => {
    const plan = buildPlan(
      input({
        nextConfigSource: `"connect-src 'self' ws://localhost:4400 ws://127.0.0.1:4400"`,
      }),
    );
    expect(cspSteps(plan)).toHaveLength(0);
  });

  it('reports at most one, however many files carry the same policy', () => {
    const csp = `"connect-src 'self'"`;
    const plan = buildPlan(
      input({
        nextConfigSource: csp,
        nextLayout: { path: 'app/layout.tsx', source: csp },
      }),
    );
    expect(cspSteps(plan)).toHaveLength(1);
  });
});

// The regression this whole path was rewritten for. MarkText — a production Electron editor —
// declares `default-src 'self'` with no `connect-src` in `src/renderer/index.html`. The browser
// blocked the bridge WebSocket, the daemon never saw a dial to refuse, and `init` printed a clean
// plan: the step read a hand-written pair of Next sources while csp-doctor.ts already carried the
// full list, `index.html` included. The check you run BEFORE anything works looked at less than the
// one you run after it has failed.
describe('the policy is read wherever an app actually declares one', () => {
  it('warns on a meta CSP in an Electron renderer index.html', () => {
    const plan = buildPlan(
      input({
        cspSources: {
          'src/renderer/index.html': `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';">`,
        },
      }),
    );
    const [step] = cspSteps(plan);
    expect(step?.target).toBe('src/renderer/index.html');
    expect(step?.detail ?? '').toContain('ws://localhost:4400');
  });

  it('warns on a plain Vite index.html too', () => {
    const plan = buildPlan(
      input({
        cspSources: {
          'index.html': `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
        },
      }),
    );
    expect(cspSteps(plan)).toHaveLength(1);
  });

  it('stays silent when connect-src already admits the bridge', () => {
    const plan = buildPlan(
      input({
        cspSources: {
          'index.html': `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' ws://localhost:4400 ws://127.0.0.1:4400">`,
        },
      }),
    );
    expect(cspSteps(plan)).toEqual([]);
  });
});
