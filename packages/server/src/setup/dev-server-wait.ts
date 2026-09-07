/**
 * Deciding when a dev server we started is up, hung, or gone.
 *
 * Nothing else in the package owns a spawned dev server, so this is the one genuinely new decision
 * setup contributes. All three cases below were failures in the field:
 *
 * - a url in the output is an ANNOUNCEMENT, not readiness. Next prints `- Local: …` before it can
 *   serve, so a tab opened on that line lands on a 404 and the whole connect budget is then spent
 *   blaming the SDK for a server that had not finished starting.
 * - a launcher that EXITS is not necessarily a dead server. `astro dev` forks the real one, prints
 *   the url and returns, which was read as death and failed Astro every time.
 * - a fixed budget is the wrong instrument for "is this hung?". The heaviest real monorepo builds
 *   two shared packages before its app serves and was measured taking twenty minutes, while a
 *   genuinely wedged server writes nothing at all and gets exactly the same budget.
 */

/** Everything the decision needs, gathered by the caller. */
export interface WaitFacts {
  /** The dev server's own output so far. */
  readonly output: string;
  /** Whether the process we spawned has exited. */
  readonly launcherExited: boolean;
  /** Whether the url we are watching answers. */
  readonly serving: boolean;
  /** Milliseconds since the dev server last wrote anything. */
  readonly quietForMs: number;
  /** Milliseconds since the wait began. */
  readonly elapsedMs: number;
  /**
   * How long silence may mean "still starting" on THIS machine. Defaults to QUIET_MEANS_HUNG_MS.
   *
   * Passed in rather than read from the platform here, so this stays a pure decision and exactly one
   * caller owns the platform check. 45s is generous on a laptop and tight on a cold Windows runner,
   * where a first `npm run dev` optimises dependencies before Vite prints a line.
   */
  readonly quietMeansHungMs?: number;
}

export const WaitVerdict = {
  /** It is up. Carry on. */
  READY: 'ready',
  /** Still building or still starting; keep waiting. */
  WAITING: 'waiting',
  /** The launcher exited and nothing it started is answering. */
  DEAD: 'dead',
  /** It has gone silent without ever serving. */
  HUNG: 'hung',
} as const;
export type WaitVerdict = (typeof WaitVerdict)[keyof typeof WaitVerdict];

/** Silence for this long, with nothing served, means hung rather than busy. */
export const QUIET_MEANS_HUNG_MS = 45_000;
/** Even a talkative dev server has had enough rope by here. */
export const WAIT_CEILING_MS = 25 * 60_000;

/**
 * Whether to keep waiting.
 *
 * `serving` outranks everything: a launcher that exited while the port answers has DAEMONIZED, and
 * that is a live server whatever its parent did.
 */
export function judgeWait(facts: WaitFacts): WaitVerdict {
  if (facts.serving) return WaitVerdict.READY;
  if (facts.launcherExited) return WaitVerdict.DEAD;
  if (facts.elapsedMs >= WAIT_CEILING_MS) return WaitVerdict.HUNG;
  // Output IS progress. Silence is what distinguishes a build from a wedge.
  return facts.quietForMs >= (facts.quietMeansHungMs ?? QUIET_MEANS_HUNG_MS)
    ? WaitVerdict.HUNG
    : WaitVerdict.WAITING;
}

/** A url the dev server announced, if it has announced one. Never composed, only read. */
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/;

export function announcedUrl(output: string): string | undefined {
  return URL_IN_OUTPUT.exec(output)?.[0];
}

/**
 * The url to watch: whatever the tool announced, else one composed from a port we OBSERVED our own
 * process group binding.
 *
 * The second is not a guess. `react-scripts` prints no parseable url outside a tty, so a CRA app
 * compiled successfully, served happily, and setup timed out insisting no url appeared — the
 * evidence there is the process we spawned, not a convention.
 */
export function urlToWatch(output: string, observedPorts: readonly number[]): string | undefined {
  const announced = announcedUrl(output);
  if (undefined !== announced) return announced;
  const port = observedPorts[0];
  return undefined === port ? undefined : `http://localhost:${port}`;
}
