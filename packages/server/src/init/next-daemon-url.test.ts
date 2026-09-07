import { describe, expect, it } from 'vitest';
import { nextReticleDevFile } from './snippets.js';
import { nextSteps } from './plan-framework.js';
import { StepStatus } from './plan.js';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';

/**
 * The generated Next component must take its daemon URL from the environment, not from the port that
 * happened to be live when `reticle init` ran.
 *
 * `withReticle` discovers the daemon serving this project on every dev-server start and forwards it
 * as NEXT_PUBLIC_RETICLE_URL. That is only half a fix: if this file does not READ it, discovery is
 * computed and thrown away, and the failure is silent in both directions — the app keeps dialling the
 * frozen port and nothing errors anywhere a user looks.
 *
 * This is also the only thing keeping the two halves in agreement. They live in different packages,
 * one TypeScript and one plain CJS, connected by nothing but the name of an environment variable.
 */
describe('the generated ReticleDev component', () => {
  it('reads the URL withReticle discovers', () => {
    expect(nextReticleDevFile(undefined, 'shop-abc123')).toContain(
      'process.env.NEXT_PUBLIC_RETICLE_URL',
    );
  });

  it('passes it to connect, so discovering it is not merely decorative', () => {
    expect(nextReticleDevFile(undefined, 'shop-abc123')).toContain('...(url ? { url } : {})');
  });

  /**
   * The whole point. A port baked in at install time is a fact about the day someone ran `init`; the
   * discovered one is a fact about now. Spread order decides which wins, so it is asserted rather
   * than left to reading.
   */
  it('lets the discovered URL override a port baked in at install time', () => {
    const file = nextReticleDevFile(4460, 'shop-abc123');
    expect(file).toContain("url: 'ws://localhost:4460/reticle'"); // still written, as a fallback
    const baked = file.indexOf("url: 'ws://localhost:4460/reticle'");
    const discovered = file.indexOf('...(url ? { url } : {})');
    expect(discovered).toBeGreaterThan(baked); // later key wins in an object literal
  });

  it('still names the project, so the daemon can be matched across port changes', () => {
    expect(nextReticleDevFile(RETICLE_DEFAULT_PORT, 'shop-abc123')).toContain(
      "projectId: 'shop-abc123'",
    );
  });
});

/**
 * The upgrade path. A fix that only reaches new installs leaves every existing Next user on the
 * frozen port, and `init` is the one command they will re-run.
 */
describe('re-running init on an existing Next install', () => {
  const base = {
    options: {},
    nextConfigSource: 'export default {};',
    nextReticleDevExists: true,
  } as unknown as Parameters<typeof nextSteps>[0];

  function devStep(source: string | null | undefined) {
    return nextSteps({ ...base, nextReticleDevSource: source }).find(
      (s) => 'ReticleDev component' === s.title,
    );
  }

  it('names the stale component as work instead of calling it already wired', () => {
    const step = devStep("reticle.connect({ projectId: 'x' });");
    expect(step?.status).toBe(StepStatus.MANUAL);
  });

  it('gives the edit, not just the diagnosis', () => {
    expect(devStep("reticle.connect({ projectId: 'x' });")?.detail).toContain(
      'NEXT_PUBLIC_RETICLE_URL',
    );
  });

  it('leaves an already-current component alone', () => {
    const step = devStep('const url = process.env.NEXT_PUBLIC_RETICLE_URL;');
    expect(step?.status).toBe(StepStatus.ALREADY);
  });

  /** Absent means NOT READ. Inventing work from missing information is how a plan grows dead steps. */
  it('does not manufacture work when the file was not read', () => {
    expect(devStep(undefined)?.status).toBe(StepStatus.ALREADY);
    expect(devStep(null)?.status).toBe(StepStatus.ALREADY);
  });

  /** A pristine app has no file at all: that is a write, and must not become a manual step. */
  it('still writes the component when there is none', () => {
    const step = nextSteps({ ...base, nextReticleDevExists: false }).find(
      (s) => 'ReticleDev component' === s.title,
    );
    expect(step?.status).toBe(StepStatus.APPLY);
  });
});
