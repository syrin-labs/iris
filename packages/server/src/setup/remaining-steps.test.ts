import { describe, expect, it } from 'vitest';
import { remainingSteps, type Progress } from './remaining-steps.js';

const at = (p: Partial<Progress>): Progress => ({
  initDone: false,
  devServerUp: false,
  sessionConnected: false,
  flowSaved: false,
  urlSuppliedByCaller: false,
  ...p,
});

describe('picking up where setup stopped', () => {
  it('starts at init when nothing has happened', () => {
    expect(remainingSteps(at({}))[0]).toContain('init');
  });

  // The point of the whole module: a run that got past init must not be told to re-run it.
  it('never tells you to redo a step that already worked', () => {
    const steps = remainingSteps(
      at({ initDone: true, devServerUp: true, devCommand: 'npm run dev' }),
    );
    expect(steps.join(' ')).not.toContain('npx @reticlehq/server@latest init');
    expect(steps[0]).toContain('reticle_sessions');
  });

  it('names the dev command when the server is the missing piece', () => {
    expect(remainingSteps(at({ initDone: true, devCommand: 'pnpm dev -p 3100' }))[0]).toContain(
      'pnpm dev -p 3100',
    );
  });

  // Someone who passed --url is already running their server; telling them to start it is noise.
  it('does not tell a caller who supplied a url to start a server', () => {
    const steps = remainingSteps(
      at({ initDone: true, urlSuppliedByCaller: true, url: 'http://localhost:3000/' }),
    );
    expect(steps.join(' ')).not.toContain('Start the dev server');
  });

  it('names the url in the session step when there is one', () => {
    expect(
      remainingSteps(at({ initDone: true, devServerUp: true, url: 'http://localhost:5173/' })).join(
        ' ',
      ),
    ).toContain('http://localhost:5173/');
  });

  // A saved flow that only ACTS passes even when the feature is broken, and setup replays it on
  // every later run — so the grade has to be part of the instruction, not a footnote.
  it('tells you to check the grade, not just to save a flow', () => {
    const drive = remainingSteps(
      at({ initDone: true, devServerUp: true, sessionConnected: true }),
    ).join(' ');
    expect(drive).toContain('asserted');
  });

  it('leaves only the docs pointer when everything succeeded', () => {
    const steps = remainingSteps(
      at({ initDone: true, devServerUp: true, sessionConnected: true, flowSaved: true }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('docs.reticle.sh');
  });
});
