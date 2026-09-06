/**
 * The half of setup that happens after the files are written.
 *
 * `init` wires a project; this gets the app running with the SDK inside it, proves a session
 * connected, and drives one flow to a verdict. Measured against an agent doing the same steps by
 * hand from SKILL.md across five real applications: 176 model turns, $9.92, forty minutes, and a
 * verdict in two runs out of five — three ended by asking a human to restart their client, having
 * shown them nothing.
 *
 * Every effect is injected. That is not ceremony: the sequence has five phases, each with its own
 * way of going wrong, and the alternative to injecting them is a test that boots a real dev server
 * and a real browser to find out what happens when neither works.
 */

import { judgeWait, QUIET_MEANS_HUNG_MS, urlToWatch, WaitVerdict } from './dev-server-wait.js';

/**
 * Windows gets longer to say something before silence counts as a wedge.
 *
 * A first `npm run dev` on a cold Windows runner optimises dependencies before the bundler prints a
 * line, and 45s of quiet is inside that window. Measured on the install gate: the Vue scaffold was
 * declared hung, `init` exited 1, and the gate then started the very same app and connected to it
 * on the next line. Nothing was wrong with the app; the wait was too impatient for the platform.
 *
 * Only the QUIET budget moves. The ceiling is unchanged, and a launcher that exits is still dead
 * immediately, so this buys patience for a starting server and never for a broken one.
 */
const WINDOWS_QUIET_MEANS_HUNG_MS = 3 * 60_000;
const WINDOWS_QUIET_MEANS_HUNG_MS_APPLIES = 'win32' === process.platform;
import { pickSession, type CandidateSession } from './session-pick.js';
import { readPage, describePage, type PageProbe } from './page-probe.js';
import { remainingSteps, type Progress } from './remaining-steps.js';
import { AppShape, isDesktop, policyFor } from './desktop-shape.js';

/** Where a run got to, and why it stopped if it did. */
export const SetupPhase = {
  DEV_SERVER: 'dev-server',
  CONNECT: 'connect',
  DRIVE: 'drive',
  DONE: 'done',
} as const;
export type SetupPhase = (typeof SetupPhase)[keyof typeof SetupPhase];

export interface SetupOutcome {
  /** True only when a flow was driven AND saved. Writing files is not an install. */
  readonly ok: boolean;
  readonly reachedPhase: SetupPhase;
  readonly url?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The drive's own report, kept verbatim and never trusted as a pass on its own. */
  readonly verdict?: string | undefined;
  readonly flowSaved: boolean;
  /** What the caller should do next, when this did not finish. */
  readonly fallback: string[];
  readonly notes: string[];
}

/** Everything the sequence needs from the world, so none of it is reached for directly. */
export interface SetupEffects {
  /** Start the dev server. Resolves once started; the caller owns stopping it. */
  readonly startDevServer: (command: string, cwd: string) => Promise<void>;
  /** Everything the dev server has printed so far. */
  readonly devServerOutput: () => string;
  readonly devServerExited: () => boolean;
  /** Milliseconds since it last printed anything. */
  readonly devServerQuietForMs: () => number;
  /** Ports our own process group is listening on. */
  readonly observedPorts: () => number[];
  /** Fetch the url and report what came back. */
  readonly probePage: (url: string) => Promise<PageProbe>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly listSessions: () => Promise<CandidateSession[]>;
  /** Drive one flow. Returns the agent's report, or null when nobody could. */
  readonly drive: (url: string, session: CandidateSession) => Promise<string | null>;
  /**
   * Whether this machine has an agent CLI at all.
   *
   * Separate from `drive` returning null, because those are different facts and only one of them is
   * a failure. A drive that RAN and proved nothing is a result worth a non-zero exit. A drive that
   * could not run is the absence of a tool on the machine, and reporting the install as failed for
   * it told CI runners — where no agent CLI is ever installed — that a perfectly good install had
   * not worked.
   */
  readonly driverAvailable: () => boolean;
  readonly flowsSaved: () => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly note: (line: string) => void;
}

export interface SetupInput {
  readonly appDir: string;
  readonly devCommand?: string | undefined;
  /** The app is already served here, so nothing is started. */
  readonly suppliedUrl?: string | undefined;
  /**
   * The caller's own budget for the connect wait, when they named one.
   *
   * Absent, the shape's policy decides — a desktop shell genuinely needs longer than a browser tab.
   * Present, it WINS, including when it is shorter: the deadline used to be
   * `max(phaseTimeoutMs, policy)`, so `--timeout 3` could only ever lengthen the wait. A timeout the
   * tool ignores is a lie, and it left every hostile-environment check killed by its own harness
   * before setup could say what was wrong.
   */
  readonly connectBudgetMs?: number | undefined;
  readonly openBrowser: boolean;
  readonly drive: boolean;
  /** Web, Electron or Tauri. Desktop changes three things; see desktop-shape.ts. */
  readonly shape: AppShape;
  readonly phaseTimeoutMs: number;
  readonly pollMs: number;
}

const asProgress = (input: SetupInput, o: Partial<SetupOutcome>): Progress => ({
  initDone: true,
  devServerUp: undefined !== o.url,
  sessionConnected: undefined !== o.sessionId,
  flowSaved: true === o.flowSaved,
  urlSuppliedByCaller: undefined !== input.suppliedUrl,
  ...(undefined === o.url ? {} : { url: o.url }),
  ...(undefined === input.devCommand ? {} : { devCommand: input.devCommand }),
});

const stop = (
  input: SetupInput,
  phase: SetupPhase,
  partial: Partial<SetupOutcome>,
  notes: string[],
): SetupOutcome => ({
  ok: false,
  reachedPhase: phase,
  flowSaved: false,
  ...partial,
  notes,
  fallback: remainingSteps(asProgress(input, partial)),
});

/**
 * Run the phases. Stops at the first one that cannot continue, and always says what is left.
 *
 * A phase that fails is not an error to throw: the caller is usually an agent, and a thrown
 * exception loses the four things it needs — how far this got, the url, the session, and what to do
 * about it.
 */
export async function runSetupPhases(input: SetupInput, fx: SetupEffects): Promise<SetupOutcome> {
  const notes: string[] = [];
  const note = (line: string): void => {
    notes.push(line);
    fx.note(line);
  };

  // ── the app has to be running ────────────────────────────────────────────────────────────────
  let url = input.suppliedUrl;
  if (undefined === url) {
    if (undefined === input.devCommand) {
      note(
        // "stop here rather than invent one" is the SKILL.md rule, and the words are the contract —
        // inventing a dev command is how a setup script runs the wrong thing and reports success.
        'No dev command: the project names no dev, start or serve script, and there is no --url. ' +
          'Stopping here rather than invent one — pass --dev-cmd or --url to say what serves this app.',
      );
      return stop(input, SetupPhase.DEV_SERVER, {}, notes);
    }
    await fx.startDevServer(input.devCommand, input.appDir);
    const startedAt = fx.now();
    for (;;) {
      const watching = urlToWatch(fx.devServerOutput(), fx.observedPorts());
      const serving = undefined === watching ? false : (await fx.probePage(watching)).served;
      const verdict = judgeWait({
        output: fx.devServerOutput(),
        launcherExited: fx.devServerExited(),
        serving,
        quietForMs: fx.devServerQuietForMs(),
        elapsedMs: fx.now() - startedAt,
        quietMeansHungMs: WINDOWS_QUIET_MEANS_HUNG_MS_APPLIES
          ? WINDOWS_QUIET_MEANS_HUNG_MS
          : QUIET_MEANS_HUNG_MS,
      });
      if (WaitVerdict.READY === verdict && undefined !== watching) {
        url = watching;
        break;
      }
      // A desktop shell serves its webview from inside the app, so there is no port to answer and
      // nothing to be READY. Once it has announced a url, or bound one we can see, that is as far
      // as this phase can get: the session it dials from its own window is the real signal.
      if (isDesktop(input.shape) && undefined !== watching) {
        url = watching;
        break;
      }
      if (WaitVerdict.DEAD === verdict) {
        note('The dev server exited without serving anything.');
        return stop(input, SetupPhase.DEV_SERVER, {}, notes);
      }
      if (WaitVerdict.HUNG === verdict) {
        // Says BOTH were checked. A server that prints nothing but IS listening is the CRA case and
        // must not be failed, so a reader has to be able to tell "we looked at the log" from "we
        // looked at the log AND the ports".
        note(
          'The dev server neither printed a URL nor bound a port, so setup has nothing to open. ' +
            'Check its log, or pass --url with the address it serves.',
        );
        return stop(input, SetupPhase.DEV_SERVER, {}, notes);
      }
      await fx.sleep(input.pollMs);
    }
  }

  // ── and something has to connect from inside it ──────────────────────────────────────────────
  const policy = policyFor(input.shape);
  // Through `note`, not `fx.note`: a caller reading the result should see it too.
  if (undefined !== policy.note) note(policy.note);
  const before = new Set((await fx.listSessions()).map((s) => s.sessionId));
  // Never for a desktop app: its own window is the client, and a browser tab would be a SECOND
  // session that is not the app.
  if (input.openBrowser && policy.openBrowser) await fx.openBrowser(url);
  const deadline =
    fx.now() + (input.connectBudgetMs ?? Math.max(input.phaseTimeoutMs, policy.connectBudgetMs));
  let session: CandidateSession | null = null;
  for (;;) {
    // On a desktop app, only the desktop window counts. AppShape and the runtime a page reports use
    // the same three names, so the shape IS the requirement — see session-pick.
    session = pickSession(
      await fx.listSessions(),
      url,
      before,
      isDesktop(input.shape) ? input.shape : undefined,
    );
    if (null !== session) break;
    if (deadline <= fx.now()) break;
    await fx.sleep(input.pollMs);
  }
  if (null === session) {
    if (isDesktop(input.shape)) {
      // Nothing outside the app can fetch its webview, so there is no page to describe. What is
      // wrong here is desktop-shaped: the preload, the capture helper, or a CSP that blocks the
      // bridge — all of which `reticle doctor` checks.
      note(
        'The app never dialled in. For a desktop shell that is usually the preload not being required, ' +
          'the capture helper not installed, or a CSP that blocks the bridge: run `npx @reticlehq/server doctor`.',
      );
    } else {
      // What the page contains is the one thing the daemon cannot know, so it is worth one fetch.
      note(describePage(readPage(await fx.probePage(url)), url));
    }
    return stop(input, SetupPhase.CONNECT, { url }, notes);
  }

  // ── and it has to be driven, or nothing has been proved ──────────────────────────────────────
  if (!input.drive) {
    return {
      ok: true,
      reachedPhase: SetupPhase.CONNECT,
      url,
      sessionId: session.sessionId,
      flowSaved: false,
      notes,
      fallback: [],
    };
  }
  // Nothing to drive WITH is not the same as driving and proving nothing, and only the second is a
  // failure of this command. The app is installed, instrumented, booted and connected; the one step
  // left needs a tool this machine does not have, so it is reported and handed to the caller.
  if (!fx.driverAvailable()) {
    note(
      'Installed and connected, but no agent CLI is on this machine (claude, codex, opencode, ' +
        'cursor-agent or gemini), so nothing drove the app and no verdict was produced.',
    );
    return {
      ok: true,
      reachedPhase: SetupPhase.CONNECT,
      url,
      sessionId: session.sessionId,
      flowSaved: false,
      notes,
      fallback: remainingSteps(
        asProgress(input, { url, sessionId: session.sessionId, flowSaved: false }),
      ),
    };
  }
  const verdict = await fx.drive(url, session);
  const flowSaved = fx.flowsSaved();
  if (null === verdict) {
    note('No agent CLI could drive the app, so nothing was proved.');
  }
  if (!flowSaved) {
    return stop(
      input,
      SetupPhase.DRIVE,
      { url, sessionId: session.sessionId, ...(null === verdict ? {} : { verdict }) },
      notes,
    );
  }
  return {
    ok: true,
    reachedPhase: SetupPhase.DONE,
    url,
    sessionId: session.sessionId,
    ...(null === verdict ? {} : { verdict }),
    flowSaved: true,
    notes,
    fallback: [],
  };
}
