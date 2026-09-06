import { describe, expect, it } from 'vitest';
import {
  announcedUrl,
  judgeWait,
  QUIET_MEANS_HUNG_MS,
  urlToWatch,
  WAIT_CEILING_MS,
  WaitVerdict,
  type WaitFacts,
} from './dev-server-wait.js';

const facts = (p: Partial<WaitFacts> = {}): WaitFacts => ({
  output: '',
  launcherExited: false,
  serving: false,
  quietForMs: 0,
  elapsedMs: 0,
  ...p,
});

describe('is the dev server up', () => {
  it('is ready as soon as the url answers', () => {
    expect(judgeWait(facts({ serving: true }))).toBe(WaitVerdict.READY);
  });

  // `astro dev` forks the real server, prints the url and returns. Reading that exit as death
  // failed Astro on every single run.
  it('treats a launcher that exited while the port serves as alive, not dead', () => {
    expect(judgeWait(facts({ serving: true, launcherExited: true }))).toBe(WaitVerdict.READY);
  });

  it('is dead when the launcher exited and nothing answers', () => {
    expect(judgeWait(facts({ launcherExited: true }))).toBe(WaitVerdict.DEAD);
  });

  // The heaviest real monorepo builds two shared packages before serving and took twenty minutes,
  // while a wedged server writes nothing and would get exactly the same fixed budget.
  it('keeps waiting on a server that is still talking', () => {
    expect(judgeWait(facts({ quietForMs: 5_000, elapsedMs: 10 * 60_000 }))).toBe(
      WaitVerdict.WAITING,
    );
  });

  it('calls it hung once it goes silent without serving', () => {
    expect(judgeWait(facts({ quietForMs: QUIET_MEANS_HUNG_MS }))).toBe(WaitVerdict.HUNG);
  });

  it('stops even a talkative server at the ceiling', () => {
    expect(judgeWait(facts({ quietForMs: 0, elapsedMs: WAIT_CEILING_MS }))).toBe(WaitVerdict.HUNG);
  });
});

describe('which url to watch', () => {
  it('reads the url the tool announced rather than composing one', () => {
    expect(announcedUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('finds an announcement among noise', () => {
    expect(urlToWatch('warn: something\n- Local: http://127.0.0.1:3000\nready', [])).toBe(
      'http://127.0.0.1:3000',
    );
  });

  // react-scripts prints nothing parseable outside a tty. The app compiled and served happily while
  // setup timed out insisting no url appeared, so an OBSERVED port is evidence, not a guess.
  it('falls back to a port our own process group was seen binding', () => {
    expect(urlToWatch('Compiled successfully.', [3200])).toBe('http://localhost:3200');
  });

  it('prefers what the tool said over what we observed', () => {
    expect(urlToWatch('- Local: http://localhost:5173', [3200])).toBe('http://localhost:5173');
  });

  it('has no url when the tool said nothing and nothing was bound', () => {
    expect(urlToWatch('starting...', [])).toBeUndefined();
  });
});

/**
 * How long silence is allowed to mean "still starting" is a property of the MACHINE, not the code.
 *
 * 45s of quiet is generous on a developer's laptop and tight on a cold Windows CI runner, where a
 * first `npm run dev` optimises dependencies before Vite prints anything. Measured on the install
 * gate: the Vue scaffold was declared hung, `init` exited 1, and the gate then started the same app
 * and connected to it immediately. The app was fine; the patience was not.
 *
 * The budget is passed IN rather than read from the platform here, so this stays a pure decision and
 * the caller owns the one platform check.
 */
describe('the quiet budget is the callers to set', () => {
  const facts = (over: Partial<Parameters<typeof judgeWait>[0]> = {}) => ({
    output: 'vite v5 starting...',
    launcherExited: false,
    serving: false,
    quietForMs: 50_000,
    elapsedMs: 60_000,
    ...over,
  });

  it('still calls a long silence hung on the default budget', () => {
    expect(judgeWait(facts())).toBe(WaitVerdict.HUNG);
  });

  it('keeps waiting when the caller allows a longer silence', () => {
    expect(judgeWait(facts({ quietMeansHungMs: 180_000 }))).toBe(WaitVerdict.WAITING);
  });

  // The other verdicts must not soften: a launcher that exited is dead however patient we are.
  it('does not let a longer budget hide a dead launcher', () => {
    expect(judgeWait(facts({ quietMeansHungMs: 180_000, launcherExited: true }))).toBe(
      WaitVerdict.DEAD,
    );
  });

  it('does not let a longer budget outlast the ceiling', () => {
    expect(judgeWait(facts({ quietMeansHungMs: 180_000, elapsedMs: WAIT_CEILING_MS }))).toBe(
      WaitVerdict.HUNG,
    );
  });
});
