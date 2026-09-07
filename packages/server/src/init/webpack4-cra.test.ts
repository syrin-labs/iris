/**
 * #680: `@reticlehq/browser` ships untranspiled optional chaining and logical assignment.
 *
 * react-scripts 4 runs webpack 4, whose parser predates both, AND excludes `node_modules` from
 * Babel. So `npm start` dies with a syntax error inside `@reticlehq/browser/dist/index.js` — a file
 * the user did not write, naming nothing about Reticle — before any session can exist.
 *
 * Nothing else in `init` can see it. Every check passes: the package installs, the entry import is
 * written, the token is inlined. A green report over a build that cannot compile is the same class
 * of lie as a green report over an app that cannot connect.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, type DetectInput } from './detect.js';
import { craSteps } from './plan-framework.js';
import { StepStatus, type PlanInput } from './plan.js';
import { WEBPACK4_REACT_SCRIPTS_MAJOR } from './snippets.js';

const detectInput = (reactScripts: string | undefined): DetectInput => ({
  pkg: {
    dependencies: {
      react: '^17.0.2',
      ...(reactScripts === undefined ? {} : { 'react-scripts': reactScripts }),
    },
  },
  configFiles: new Set<string>(),
  lockfiles: new Set(['package-lock.json']),
});

const planFor = (reactScripts: string | undefined): PlanInput =>
  ({
    detection: detect(detectInput(reactScripts)),
    claudeCli: false,
    mcpExists: false,
    options: { port: 4400, projectId: 'demo' },
    craEntry: { path: 'src/index.js', source: "import './App';\n" },
    craEnv: null,
    pairingToken: 'tok',
  }) as unknown as PlanInput;

const webpackSteps = (reactScripts: string | undefined) =>
  craSteps(planFor(reactScripts)).filter((step) => step.title.includes('cannot parse the SDK'));

describe('detecting the react-scripts major', () => {
  it('reads it off the dependency', () => {
    expect(detect(detectInput('4.0.3')).reactScriptsMajor).toBe(4);
    expect(detect(detectInput('^5.0.1')).reactScriptsMajor).toBe(5);
  });

  it('is undefined on every other stack', () => {
    expect(detect(detectInput(undefined)).reactScriptsMajor).toBeUndefined();
  });

  it('still detects CRA itself, which is unchanged', () => {
    expect(detect(detectInput('4.0.3')).framework).toBe(Framework.CRA);
  });
});

describe('the webpack 4 notice', () => {
  it('fires on react-scripts 4', () => {
    const [step] = webpackSteps('4.0.3');
    expect(step?.status).toBe(StepStatus.NOTICE);
    expect(step?.title).toContain('react-scripts 4');
  });

  it('stays quiet on react-scripts 5, where webpack 5 parses both natively', () => {
    expect(webpackSteps('^5.0.1')).toEqual([]);
  });

  it('is keyed on the major that actually changed bundler', () => {
    // A guard against the threshold drifting away from the reason for it.
    expect(WEBPACK4_REACT_SCRIPTS_MAJOR).toBe(5);
  });

  it('comes FIRST, because it decides whether the steps below it can run', () => {
    const [first] = craSteps(planFor('4.0.3'));
    expect(first?.title).toContain('cannot parse the SDK');
  });

  it('names the file the error will actually point at', () => {
    // The user sees a syntax error in a package they did not write. Naming it here is what connects
    // that error back to this report.
    const detail = webpackSteps('4.0.3')[0]?.detail ?? '';
    expect(detail).toContain('@reticlehq/browser/dist/index.js');
    expect(detail).toContain('optional');
    expect(detail).toContain('node_modules from Babel');
  });

  it('says the rest of the report cannot see this', () => {
    const detail = webpackSteps('4.0.3')[0]?.detail ?? '';
    expect(detail).toContain('Nothing else in this report can');
  });

  it('offers the upgrade before the bundler edit', () => {
    // Editing a bundler config to run a dev-only tool is the path most people abandon, so it is not
    // the one offered first.
    const detail = webpackSteps('4.0.3')[0]?.detail ?? '';
    expect(detail.indexOf('upgrade to react-scripts 5')).toBeLessThan(
      detail.indexOf('config-overrides.js'),
    );
  });

  it('scopes the Babel include to one package', () => {
    const detail = webpackSteps('4.0.3')[0]?.detail ?? '';
    expect(detail).toContain('node_modules/@reticlehq/browser');
    expect(detail).toContain('and nothing else');
  });

  it('is a NOTICE, not a manual connect step', () => {
    // It is a real blocker, but it is not one of the steps whose absence means "no session ever" —
    // those make init exit non-zero, and this app's problem is that it will not build at all.
    const [step] = webpackSteps('4.0.3');
    expect(step?.status).not.toBe(StepStatus.MANUAL);
  });

  it('leaves the rest of the CRA plan untouched', () => {
    const withNotice = craSteps(planFor('4.0.3')).map((s) => s.title);
    const without = craSteps(planFor('^5.0.1')).map((s) => s.title);
    expect(withNotice.slice(1)).toEqual(without);
  });
});
