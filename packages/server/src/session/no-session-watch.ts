/**
 * Keeps the "why is nothing connected" diagnosis fresh, without putting a probe on the hot path.
 *
 * `SessionManager.resolve` is synchronous and runs on every tool call, so it cannot await a port
 * scan. This refreshes the answer in the background and hands the manager a closure that reads the
 * cached result — a hint in an error message is exactly the sort of thing that may be a few seconds
 * stale.
 *
 * It only probes while NOTHING is connected. Once a session is live the question is moot, and a
 * daemon that outlives the agent by hours has no business scanning ports it does not need.
 */

import { probeDevServers, probeDevServerStates } from './dev-server-probe.js';
import type { NoSessionReason } from '@reticlehq/core';
import { explainNoSession } from './no-session-diagnosis.js';
import type { NoSessionFacts } from './no-session-diagnosis.js';
import { detectDevCommand } from './dev-command.js';
import { nextActionFor, renderNextAction } from './no-session-next-action.js';
import type { NoSessionNextAction } from './no-session-next-action.js';
import { readProjectFramework, readProjectId, readProjectPort } from '../cli/cli-port.js';
import { discoverProjectConfigs } from '../cli/config-discovery.js';
import { hasProjectConnectedBefore, rememberConnected } from './connection-memory.js';
import { isAlive, reticleStateHome } from '../daemon/daemon.js';
import { daemonsServingProjectElsewhere, splitBrainNote } from '../daemon/daemon-resolve.js';
import { stallUptime } from './stall-clock.js';
import type { SessionManager } from './session-manager.js';
import { probeDaemon } from '../mcp/mcp-proxy.js';
import { findOccupiedSiblings } from '../cli/sibling-ports.js';
import { WS_CLOSE_REASON } from '../bridge/bridge.js';

/** Slow enough to be free, fast enough that a dev server started 15s ago is already reflected. */
const REFRESH_MS = 15_000;

/** The URL an auto-attach opens. `localhost` for the same reason the probe uses it: both stacks. */
const LOCALHOST = 'http://localhost';

/**
 * What the failure path says, always naming the reason rather than swallowing it.
 *
 * An auto-attach that fails silently is the same class of defect as the message it replaces: the
 * agent is told absence and never learns that Reticle tried and could not.
 */
function attachFailureClause(port: number, reason: string): string {
  const collision = /EADDRINUSE|address already in use/i.test(reason);
  return (
    ` Reticle also tried to open ${LOCALHOST}:${String(port)} in a browser it owns and could not: ` +
    `${reason}.` +
    (collision
      ? ' That is a port collision — something already holds the port this daemon needs, so the ' +
        'browser Reticle drives could not be started. Stop the other Reticle process and retry, ' +
        'rather than treating this as a problem with the app.'
      : '')
  );
}

interface NoSessionWatchOptions {
  sessions: SessionManager;
  port: number;
  /** Whether this project has been through `reticle init` (a projectId is stamped in .reticle.json). */
  initialized: boolean;
  /** Where that was decided — this daemon's working directory unless a caller says otherwise. */
  directory?: string;
  probe?: () => Promise<number[]>;
  /**
   * Well-known Reticle ports other than ours that currently accept a connection.
   *
   * Remaining half of #261. Injected so tests can pin the observation without opening a socket.
   * Production (no `probe` override) probes those ports itself. A test that injects `probe` and
   * omits this is opting out: it owns the scan.
   */
  occupiedSiblings?: () => Promise<readonly number[]>;
  /**
   * Whether a given session id belonged to a pooled lease that aged out, if a pool exists.
   * Injected as a predicate rather than the pool itself: the diagnosis needs one answer, and
   * taking the whole pool would tie the session layer to the browser layer for it.
   *
   * Was a lifetime `reapedLeases: () => number` count, asked as `> 0`. That latched: after the
   * first reap, every closed human tab was reported as an expired lease for the rest of the
   * daemon's life, and the recovery it named would have thrown away the app session (#611).
   */
  wasReapedLease?: (sessionId: string) => boolean;
  /**
   * Opens a URL in a browser Reticle owns, and resolves once it is open.
   *
   * The daemon passes the POOL's acquire — the same path `reticle_lease` takes — rather than
   * `reticle drive`. Deliberate: the pool runs inside this process and binds nothing, so it needs no
   * port arbitration, while `reticle drive` starts a second daemon that fights this one for the port.
   * Omitted on a daemon with no pool, and auto-attach is then simply off.
   */
  attach?: (url: string) => Promise<unknown>;
  /**
   * Where the durable "an app has connected here before" bit lives. The daemon's state home unless
   * a test says otherwise.
   */
  stateDir?: string;
}

/**
 * Start the watch. Returns a stop function; the timer is unref'd so it never holds the daemon up.
 *
 * Exported for the test that pins the after-boot config read below — the daemon itself starts this
 * through `wireSessionScope`.
 */
export function startNoSessionWatch(options: NoSessionWatchOptions): () => void {
  const probe = options.probe ?? (() => probeDevServers());
  let listening: readonly number[] = [];
  /**
   * Ports that accepted a connection and then answered nothing in time.
   *
   * Tracked beside `listening` rather than folded into it: they are not dev servers as far as the
   * probe knows, so they must not be spent as proof the app is up, and they are not absent either,
   * so the diagnosis must stop telling people to start a server that is already running. A custom
   * `options.probe` returns only the serving set, so this stays empty for injected probes.
   */
  let slowListeners: readonly number[] = [];
  let siblingListeners: readonly number[] = [];
  let running = false;
  /** Ports auto-attach has already spent its one attempt on. Bounded: never a loop, never a retry. */
  const attempted = new Set<number>();
  /** Set only when an attempt actually failed, so the diagnosis can say so instead of hiding it. */
  let attachFailure: string | undefined;

  const directory = options.directory ?? process.cwd();
  // The boot answer still counts (it is what the daemon scoped its sessions with), but `.reticle.json`
  // is routinely written by `init` AFTER this daemon started, so re-read rather than cache. See the
  // `initialized` comment below, which this shares.
  const isWired = (): boolean => options.initialized || readProjectId(directory) !== undefined;

  type ProjectScopeFacts = Pick<
    NoSessionFacts,
    'initialized' | 'configsElsewhere' | 'searchedDirectories'
  >;

  /**
   * Resolve the daemon's current project scope once for both halves of a sessions response.
   *
   * This remains a live read because `init` commonly writes the config after the daemon starts.
   */
  const projectScopeFacts = (): ProjectScopeFacts => {
    const initialized = isWired();
    if (initialized) return { initialized };
    const discovery = discoverProjectConfigs(directory);
    const elsewhere = discovery.found.filter((config) => config.directory !== directory);
    return 0 === elsewhere.length
      ? { initialized, searchedDirectories: discovery.searched }
      : {
          initialized,
          configsElsewhere: elsewhere.map((config) => ({
            directory: config.directory,
            ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
          })),
        };
  };

  // Read at boot: the daemon's own identity does not change under it, and this is the key the
  // durable bit is stored under.
  const stateDir = options.stateDir ?? reticleStateHome();
  /**
   * Only ever asked ABOUT A NAMED PROJECT.
   *
   * With no projectId the memory can still answer the weaker "has anything connected on this port",
   * and that answer must not be spent here: a shared 4400 on a machine with several repos would
   * then soften a genuinely-unwired directory's diagnosis on the strength of an unrelated app. That
   * is the same over-confident claim this whole file exists to remove, pointing the other way.
   */
  const connectedBefore = (): boolean =>
    hasProjectConnectedBefore(stateDir, options.port, readProjectId(directory));

  /**
   * The split brain, asked fresh every time like everything else here.
   *
   * Cheap — a directory listing of `~/.reticle` and a few small JSON reads — and only ever reached
   * on a daemon with no session, which is the state this whole file exists for. Reading it once at
   * boot would miss the ordinary case entirely: the app connects to the other daemon SECONDS after
   * this one starts, which is precisely the window the agent then spends being told to start a dev
   * server that is already running.
   */
  const splitBrain = (): string | undefined => {
    const projectId = readProjectId(directory);
    return splitBrainNote(
      options.port,
      daemonsServingProjectElsewhere(projectId, options.port, stateDir, isAlive, (port) =>
        hasProjectConnectedBefore(stateDir, port, projectId),
      ),
    );
  };

  // Every path that registers a session goes through SessionManager.add, so this is the one hook
  // that makes the bit durable. Recorded per port + projectId so a shared 4400 cannot make one
  // project's success into evidence about another's.
  options.sessions.setConnectionRecorder((projectId) => {
    rememberConnected(stateDir, options.port, projectId);
  });

  /**
   * Open the app ourselves when there is exactly one unambiguous candidate.
   *
   * AUTOMATIC, not offered — the deliberate call. Offering means a round trip and a decision by an
   * agent that has strictly less evidence than this daemon does, on the one case where there is
   * nothing left to decide: the project is wired, so a page WILL connect, and exactly one dev server
   * is listening, so there is no ambiguity about which. That case is the bulk of the loss. Every
   * other shape (several listeners, an unwired project, no listener) still returns prose, because
   * there the daemon would be guessing and a guess that opens a browser is worse than a sentence.
   *
   * Bounded by construction: one attempt per port per daemon. A failure is recorded, never retried —
   * a retry loop against a broken Chromium install would spin for the daemon's whole life.
   */
  const autoAttach = async (ports: readonly number[]): Promise<void> => {
    const attach = options.attach;
    if (attach === undefined) return;
    if (1 !== ports.length) return;
    const [only] = ports;
    if (only === undefined || attempted.has(only)) return;
    if (!isWired()) return;
    attempted.add(only);
    try {
      await attach(`${LOCALHOST}:${String(only)}`);
    } catch (error) {
      attachFailure = attachFailureClause(
        only,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const refresh = (): void => {
    // Nothing to diagnose while a session is live, and no reason to scan.
    if (running || options.sessions.count() > 0) return;
    running = true;
    void (
      options.probe === undefined
        ? probeDevServerStates().then((states) => {
            slowListeners = states.slow;
            return states.serving;
          })
        : probe()
    )
      .then(async (ports) => {
        listening = ports;
        siblingListeners =
          options.occupiedSiblings !== undefined
            ? await options.occupiedSiblings()
            : options.probe === undefined
              ? await findOccupiedSiblings(options.port, probeDaemon)
              : [];
        await autoAttach(ports);
      })
      .catch(() => {
        /* a diagnostic hint must never take the daemon down */
      })
      .finally(() => {
        running = false;
      });
  };

  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();

  /**
   * Did the most recent bridge-initiated close refuse a page on its token?
   *
   * The bridge records it (`noteClosure(WS_CLOSE_REASON.AUTH_FAILED)`) and nothing read it as a
   * DIAGNOSIS. It is the one fact that proves an app is running and instrumented: only an SDK dials
   * the bridge, so a refused hello means the wiring works and this daemon would not serve it.
   *
   * Called optionally because this watch is constructed against a structural slice of the manager,
   * and several callers pass a double that predates `lastClosure`. A manager that cannot answer has
   * recorded no refusal, which falls through to the behaviour that was there before -- the safe
   * direction for a fact whose only job is to SUPPRESS an `init` suggestion.
   */
  const lastCloseWasAuthFailure = (): boolean =>
    options.sessions.lastClosure?.()?.reason === WS_CLOSE_REASON.AUTH_FAILED;

  const nextAction = (scope: ProjectScopeFacts): NoSessionNextAction => {
    const split = splitBrain();
    return nextActionFor({
      everConnected: options.sessions.everConnected(),
      initialized: scope.initialized,
      ...(scope.configsElsewhere === undefined ? {} : { configsElsewhere: scope.configsElsewhere }),
      previouslyConnected: connectedBefore(),
      // Read when asked, like every other fact here: a page can dial at any moment, and a daemon
      // that cached "nothing has been refused" at boot would keep saying so.
      authRefused: lastCloseWasAuthFailure(),
      ...(split === undefined ? {} : { splitBrain: split }),
      listening,
      // Read when asked, like everything else here: a `package.json` can gain a dev script, and a
      // daemon that cached "there is none" at boot would keep saying so for the rest of the day.
      dev: detectDevCommand(directory),
    });
  };

  options.sessions.setNoSessionNextAction(() => nextAction(projectScopeFacts()));

  // ONE call for both registrations below. The prose and the branch code have to come from the
  // same evaluation or they can describe different branches - the facts are read when asked, so two
  // calls a moment apart can genuinely disagree (#615).
  const explain = (): { reason: NoSessionReason; message: string } => {
    const scope = projectScopeFacts();
    return explainNoSession({
      everConnected: options.sessions.everConnected(),
      // Read WHEN ASKED, for the same reason `projectPort` below is: `.reticle.json` is routinely
      // written by `init` after this daemon started — that is the ordinary first-install order — and
      // the boot-time answer is then permanently stale. Reported from the field as `reticle status`
      // saying the project had never been through `init` about a project whose config named its
      // framework and its projectId, and whose real problem was a dev server older than the plugin.
      // The boot value still counts: it is the one the daemon scoped its sessions with.
      ...scope,
      listening,
      slowListeners,
      port: options.port,
      // The directory `initialized` was decided in. Named in the message because "there is no
      // `.reticle.json`" is a claim about ONE directory, and a reader standing somewhere else
      // cannot tell whether it is a claim about their app at all.
      directory,
      // The one fact that outranks every absence below it, and the reason a fresh daemon stopped
      // claiming that an install which has demonstrably worked has never worked.
      previouslyConnected: connectedBefore(),
      // Ranks the causes. Read when asked, like the rest: `init` writes this file after the daemon
      // starts on an ordinary first install.
      ...(() => {
        const framework = readProjectFramework(directory);
        return framework === undefined ? {} : { framework };
      })(),
      // Decided from the session that actually went away, not from a lifetime tally: the lease
      // sentence is only right when the thing that vanished WAS a lease.
      leaseExpired: (() => {
        const departed = options.sessions.lastDeparted();
        return departed === undefined ? false : (options.wasReapedLease?.(departed) ?? false);
      })(),
      // How long this daemon has been waiting with no app. The diagnosis uses it to surface
      // "install never finished" — the same condition telemetry already knows about.
      ...(() => {
        const upMs = stallUptime(Date.now());
        return upMs === undefined ? {} : { daemonUpMs: upMs };
      })(),
      // Read here rather than at boot: `.reticle.json` can be written by `init` after this daemon
      // started, which is the ordinary first-install order, and a port cached from before it existed
      // would make the daemon confidently report no mismatch on the one run where there is one.
      ...(() => {
        const configured = readProjectPort(directory);
        return configured === undefined ? {} : { projectPort: configured };
      })(),
      ...(0 === siblingListeners.length ? {} : { siblingListeners }),
    });
  };

  options.sessions.setNoSessionHint(() => {
    const scope = projectScopeFacts();
    return (
      explain().message +
      // Prose for the human, then the literal command for the agent. Both consume the same scope
      // facts so a discovered workspace config cannot become an `init` recommendation below it.
      ` ${renderNextAction(nextAction(scope))}` +
      (attachFailure ?? '')
    );
  });

  options.sessions.setNoSessionReason(() => explain().reason);

  return () => {
    clearInterval(timer);
    options.sessions.setConnectionRecorder(undefined);
    options.sessions.setNoSessionHint(undefined);
    options.sessions.setNoSessionReason(undefined);
    options.sessions.setNoSessionNextAction(undefined);
  };
}

/**
 * The daemon's whole session-scoping decision in one call: scope auto-selection to the active
 * project, and keep the no-session diagnosis fresh. Both derive from the same one fact — whether
 * this directory has been through `reticle init` — so they belong together rather than as two
 * adjacent blocks in the bootstrap.
 */
export function wireSessionScope(
  sessions: SessionManager,
  activeProjectId: string | undefined,
  port: number,
  /** Asks the pool whether a session id was a lease it aged out; omitted when there is no pool. */
  wasReapedLease?: (sessionId: string) => boolean,
  /** Opens a URL in a Reticle-owned browser (the pool). Omitted ⇒ auto-attach is off. */
  attach?: (url: string) => Promise<unknown>,
): () => void {
  if (activeProjectId !== undefined) sessions.setDefaultScope({ projectId: activeProjectId });
  return startNoSessionWatch({
    sessions,
    port,
    initialized: activeProjectId !== undefined,
    ...(wasReapedLease === undefined ? {} : { wasReapedLease }),
    ...(attach === undefined ? {} : { attach }),
  });
}
