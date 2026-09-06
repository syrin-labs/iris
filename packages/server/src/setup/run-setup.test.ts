import { describe, expect, it } from 'vitest';
import { runSetupPhases, SetupPhase, type SetupEffects, type SetupInput } from './run-setup.js';
import { AppShape } from './desktop-shape.js';
import type { CandidateSession } from './session-pick.js';
import type { PageProbe } from './page-probe.js';

const INPUT: SetupInput = {
  appDir: '/app',
  devCommand: 'npm run dev',
  openBrowser: true,
  drive: true,
  shape: AppShape.WEB,
  phaseTimeoutMs: 1_000,
  pollMs: 1,
};

/** A world that behaves, with each part overridable to make exactly one thing go wrong. */
function world(
  over: Partial<SetupEffects> = {},
  opts: { url?: string } = {},
): SetupEffects & { opened: string[]; driven: number } {
  let clock = 0;
  const opened: string[] = [];
  const state = { driven: 0 };
  const url = opts.url ?? 'http://localhost:5173';
  const base: SetupEffects = {
    startDevServer: () => Promise.resolve(),
    devServerOutput: () => `  Local: ${url}`,
    devServerExited: () => false,
    devServerQuietForMs: () => 0,
    observedPorts: () => [],
    probePage: (): Promise<PageProbe> => Promise.resolve({ served: true, sdkInPage: true }),
    openBrowser: (u: string) => {
      opened.push(u);
      return Promise.resolve();
    },
    listSessions: (): Promise<CandidateSession[]> => Promise.resolve([{ sessionId: 'new', url }]),
    // The default world has an agent CLI: that is the ordinary developer machine, and the case
    // where its absence matters says so explicitly.
    driverAvailable: () => true,
    drive: () => {
      state.driven += 1;
      return Promise.resolve('Flow: checkout. verified: yes. assertions.grade: asserted');
    },
    flowsSaved: () => true,
    now: () => (clock += 10),
    sleep: () => Promise.resolve(),
    note: () => undefined,
    ...over,
  };
  return Object.assign(base, {
    opened,
    get driven() {
      return state.driven;
    },
  });
}

describe('the whole sequence, when everything works', () => {
  it('ends with a verdict and a saved flow', async () => {
    const r = await runSetupPhases(INPUT, world());
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.DONE);
    expect(r.flowSaved).toBe(true);
    expect(r.verdict).toContain('asserted');
    expect(r.fallback).toEqual([]);
  });

  it('opens the url the dev server announced, never one it composed', async () => {
    const fx = world({ devServerOutput: () => '  ➜  Local: http://127.0.0.1:4321/' });
    const r = await runSetupPhases(INPUT, fx);
    expect(fx.opened).toEqual(['http://127.0.0.1:4321']);
    expect(r.url).toBe('http://127.0.0.1:4321');
  });

  it('starts nothing when the caller says the app is already served', async () => {
    let started = false;
    const fx = world({
      startDevServer: () => {
        started = true;
        return Promise.resolve();
      },
    });
    await runSetupPhases({ ...INPUT, suppliedUrl: 'http://localhost:3000' }, fx);
    expect(started).toBe(false);
  });
});

describe('when it cannot continue, it says what is left', () => {
  // Writing files is not an install, so none of these may report ok.
  it('stops rather than inventing a dev command', async () => {
    const r = await runSetupPhases({ ...INPUT, devCommand: undefined }, world());
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.fallback.join(' ')).toContain('dev script');
  });

  it('reports a dev server that exited without serving', async () => {
    const fx = world({
      devServerExited: () => true,
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.notes.join(' ')).toContain('exited');
  });

  // astro dev forks the real server and returns. serving outranks the launcher having exited.
  it('carries on when the launcher exited but the port answers', async () => {
    const fx = world({ devServerExited: () => true });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(true);
  });

  it('explains what the page looked like when nothing connected', async () => {
    const fx = world({
      listSessions: () => Promise.resolve([]),
      probePage: () => Promise.resolve({ served: true, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(r.notes.join(' ')).toContain('before the build config was edited');
    expect(r.fallback.join(' ')).toContain('reticle_sessions');
  });

  // The false green this guards: another tab on the same daemon is not this install.
  it("never accepts somebody else's session", async () => {
    const fx = world({
      listSessions: () => Promise.resolve([{ sessionId: 'other', url: 'http://localhost:9999/' }]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBeUndefined();
  });

  it('does not report success when the drive saved nothing', async () => {
    const fx = world({ flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.DRIVE);
    expect(r.fallback.join(' ')).toContain('asserted');
  });

  it('says plainly when no agent could drive', async () => {
    const fx = world({ drive: () => Promise.resolve(null), flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.notes.join(' ')).toContain('nothing was proved');
  });

  /**
   * An install with nothing to drive it is still an install.
   *
   * On a CI runner there is no `claude`, `codex`, `opencode`, `cursor-agent` or `gemini`, so the
   * drive cannot happen — and `init` reported that as `⚠ setup did not finish` and exited 1, with
   * every step ✓, the app booted and the daemon up. The install gate caught it on Linux, where
   * nothing is installed; on a developer machine an agent CLI is always present, so nothing local
   * could see it.
   *
   * The distinction is whether anything went WRONG. A drive that ran and proved nothing is a
   * result. A drive that could not run is the absence of a tool, which is not a defect in the
   * install and must not be reported as one — a non-zero exit says "this did not work", and it did.
   */
  it('succeeds when the machine has no agent CLI to drive with', async () => {
    const fx = world({ driverAvailable: () => false, flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toContain('no agent CLI');
  });

  it('still says how to finish the job by hand', async () => {
    const fx = world({ driverAvailable: () => false, flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.fallback.length).toBeGreaterThan(0);
  });

  it('still FAILS when a driver existed and the drive proved nothing', async () => {
    // The negative control. Silencing the no-driver case must not silence a real miss.
    const fx = world({
      driverAvailable: () => true,
      drive: () => Promise.resolve(null),
      flowsSaved: () => false,
    });
    expect((await runSetupPhases(INPUT, fx)).ok).toBe(false);
  });
});

describe('a desktop app', () => {
  // The harmful one: the app's own window is the client, so a browser tab would be a SECOND session
  // that is not the app — the stale-tab false green, arranged deliberately.
  it('never opens a browser, even with openBrowser on', async () => {
    const fx = world();
    await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, openBrowser: true }, fx);
    expect(fx.opened).toEqual([]);
  });

  // Tauri serves its webview from tauri://localhost. Nothing outside can fetch it, so waiting for an
  // HTTP response would fail an app that is running perfectly.
  it('does not require the url to answer before looking for a session', async () => {
    const fx = world({ probePage: () => Promise.resolve({ served: false, sdkInPage: false }) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI }, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.DONE);
  });

  it('says why there is no browser and why the wait is long', async () => {
    const fx = world();
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.ELECTRON }, fx);
    expect(r.notes.join(' ')).toContain('own window is the client');
  });

  // There is no page to describe when nothing outside the app can fetch it, so the advice has to be
  // desktop-shaped rather than "restart your dev server".
  it('gives desktop advice when nothing connects, not page advice', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, phaseTimeoutMs: 1 }, fx);
    expect(r.notes.join(' ')).toContain('preload');
    expect(r.notes.join(' ')).not.toContain('build config was edited');
  });
});

describe('opting out', () => {
  it('--no-drive stops at a connected session and calls that success', async () => {
    const fx = world();
    const r = await runSetupPhases({ ...INPUT, drive: false }, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(fx.driven).toBe(0);
  });

  it('--no-open still requires something to connect', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, openBrowser: false }, fx);
    expect(fx.opened).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

/**
 * The words the break-matrix asserts.
 *
 * It is a negative control: it builds environments designed to break setup and judges each one on
 * whether the output NAMES the cause. The sentences were written in setup/reticle.mjs; porting the
 * runtime phase into `init` carried the behaviour but not the wording, so scenarios reported
 * `never said "..."` against runs that had diagnosed the problem correctly.
 *
 * Pinned here because prose is the deliverable on this path — a user reads it after waiting out a
 * timeout, and an agent greps it.
 */
describe('the dev-server diagnoses name their cause', () => {
  const notesFrom = async (
    over: Partial<SetupEffects>,
    input: Partial<SetupInput> = {},
  ): Promise<string> => {
    const lines: string[] = [];
    await runSetupPhases({ ...INPUT, ...input }, world({ ...over, note: (l) => lines.push(l) }));
    return lines.join('\n');
  };

  // "stop here rather than invent one" — the SKILL.md rule. Inventing a dev command is how a setup
  // script runs the wrong thing and reports success.
  it('refuses to invent a dev command, in those words', async () => {
    const out = await notesFrom({}, { devCommand: undefined });
    expect(out).toContain('rather than invent');
  });

  it('says the dev server exited', async () => {
    const out = await notesFrom({ devServerExited: () => true, devServerOutput: () => '' });
    expect(out).toContain('dev server exited');
  });

  // Both halves matter: a server that prints nothing but IS listening is the CRA case and must not
  // be failed, so the sentence has to say that both were checked.
  it('says it checked BOTH the output and the ports', async () => {
    const out = await notesFrom({
      devServerOutput: () => 'starting...',
      observedPorts: () => [],
      devServerQuietForMs: () => 60_000,
    });
    expect(out).toContain('neither printed a URL nor bound a port');
  });
});

/**
 * An explicit `--timeout` is the caller's budget, including for the connect wait.
 *
 * The deadline was `max(phaseTimeoutMs, policy.connectBudgetMs)`, so a caller asking for 3 seconds
 * got the policy's 120 — the flag could only ever LENGTHEN the wait, never shorten it. A timeout the
 * tool ignores is a lie, and it is the reason every hostile-environment scenario that reaches this
 * phase was killed by its own harness before setup could say what was wrong.
 *
 * The policy budget stays the DEFAULT — a desktop shell genuinely needs longer, and nobody who said
 * nothing should get a shorter wait than before.
 */
describe('the connect wait honours an explicit budget', () => {
  const ranFor = async (over: Partial<SetupInput>): Promise<number> => {
    let last = 0;
    const fx = world({
      listSessions: () => Promise.resolve([]),
      now: () => (last += 1000),
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
    });
    // A supplied url skips the dev-server phase, so what this measures is the CONNECT wait and
    // nothing else. Without it the numbers came from the dev-server loop and said nothing about the
    // budget under test.
    await runSetupPhases({ ...INPUT, suppliedUrl: 'http://localhost:5173', ...over }, fx);
    return last;
  };

  it('gives up at the budget the caller named', async () => {
    const elapsed = await ranFor({ connectBudgetMs: 3_000, phaseTimeoutMs: 3_000 });
    expect(elapsed).toBeLessThan(30_000);
  });

  it('falls back to the policy budget when the caller said nothing', async () => {
    const elapsed = await ranFor({ phaseTimeoutMs: 1_000 });
    expect(elapsed).toBeGreaterThan(100_000);
  });
});

/**
 * The requirement has to REACH pickSession, which is the half a unit test of pickSession cannot see.
 *
 * A desktop shell serves its renderer from an ordinary dev server, so a browser tab left open on the
 * same origin looks like the app here — live, on the url, SDK present — while having none of its IPC.
 */
describe('a desktop setup is only satisfied by the desktop window', () => {
  const onUrl = (sessionId: string, runtime?: string): CandidateSession => ({
    sessionId,
    url: 'http://localhost:5173',
    ...(runtime === undefined ? {} : { runtime }),
  });

  it('does not accept a browser tab as an electron app', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.ELECTRON, drive: false },
      world({ listSessions: () => Promise.resolve([onUrl('tab', 'web')]) }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reachedPhase).toBe(SetupPhase.CONNECT);
  });

  it('accepts the electron window', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.ELECTRON, drive: false },
      world({ listSessions: () => Promise.resolve([onUrl('shell', 'electron')]) }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe('shell');
  });

  // Web is unchanged: the runtime is not a distinction there.
  it('still accepts a browser tab for a web app', async () => {
    const outcome = await runSetupPhases(
      { ...INPUT, shape: AppShape.WEB, drive: false },
      world({ listSessions: () => Promise.resolve([onUrl('tab', 'web')]) }),
    );
    expect(outcome.ok).toBe(true);
  });
});
