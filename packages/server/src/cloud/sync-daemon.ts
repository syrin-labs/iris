/**
 * Automatic sync, for the session nobody thinks about.
 *
 * Somebody runs Reticle all morning. Every tool call rewrites the impact record; every verification
 * writes a run. If sync is a command a human types, the dashboard is stale for exactly as long as
 * they are busy — which is precisely when the numbers on it would have been worth looking at.
 *
 * So the daemon does it. Not a new process, not a thing to remember: the daemon is already running
 * for the whole session (it is what the agent talks to), so it is the only place where "sync while
 * work is happening" costs nobody anything.
 *
 * ── THE THREE RULES THAT KEEP IT INVISIBLE ────────────────────────────────────────────────────
 * QUIET WHEN IDLE. A cycle on an unchanged session is one small GET and nothing else. That is what
 * makes a one-minute timer affordable; it is also why the timer is not adaptive — a scheme that
 * "backs off when idle" is complexity paid for a cost that is already near zero.
 *
 * NEVER IN THE WAY. Nothing here is awaited by a tool call. A sync that can slow down or fail a
 * verification would be a sync worth switching off, and the local record is authoritative anyway.
 *
 * SILENT UNLESS IT MATTERS. A failed cycle is logged once per NEW error, not once per minute: a
 * laptop on a train would otherwise fill the log with the same line four hundred times and teach
 * everyone to ignore it.
 */
import { log } from '../log.js';
import { describeSync, runSyncCycle, type SyncReport } from './sync-cycle.js';
import { diskSink, diskSource, readCloudState } from './sync-disk.js';
import type { ProjectCloud } from './cloud-config.js';

/** How often the daemon cycles. See the note above on why this is a constant and not a curve. */
const DAEMON_SYNC_INTERVAL_MS = 60_000;

/**
 * The cadence while something is actually happening.
 *
 * A fixed minute is the wrong shape for both states it has to cover. During a drive the ledger
 * changes on every tool call and a minute of lag is what makes a dashboard feel dead; idle, a minute
 * is already more often than nothing has changed deserves.
 *
 * So the interval follows the work: a cycle that MOVED something earns the fast rate, a cycle that
 * moved nothing backs off to the slow one. No session plumbing and no new configuration — activity
 * is inferred from what the last cycle actually sent, which is the only honest evidence available.
 *
 * Deliberately not per-tool-call. A push in the tool path would put the network in the agent's inner
 * loop, and verification working with the network down is a promise this product makes.
 */
const DAEMON_SYNC_ACTIVE_INTERVAL_MS = 5_000;

/** Given to the first cycle so a freshly-started daemon does not race the session that woke it. */
const FIRST_CYCLE_DELAY_MS = 5_000;

/**
 * How long a nudge waits before cycling.
 *
 * Long enough to COALESCE — a battery that writes six runs in a second must cause one cycle, not
 * six — and short enough that finishing a verification and looking at the dashboard feels like one
 * action. Not zero: a run artifact is renamed into place and the sibling records it implies are
 * written just after, so cycling on the very first byte would ship a bundle that is missing them.
 */
const NUDGE_DELAY_MS = 1_500;

interface SyncDaemonDeps {
  reticleRoot: string;
  /** Resolved per tick, not once: a repo linked while the daemon is alive starts syncing itself. */
  cloud: () => Promise<ProjectCloud>;
  /**
   * Every OTHER `.reticle` root on this machine that might be linked.
   *
   * One daemon serves many projects — that is what `artifactRootFor` exists for — and this loop
   * pushed exactly one of them: whichever directory the daemon happened to be started in. Every
   * other linked repo went silent, and silent is indistinguishable from "nobody verified anything",
   * which is the worst possible failure for a dashboard somebody is deciding budget on.
   *
   * Optional: a caller that does not supply it gets exactly the old single-root behaviour.
   */
  otherRoots?: () => Promise<readonly string[]>;
  /** Resolve the link for a root that is not this daemon's own. Required to use `otherRoots`. */
  cloudFor?: (root: string) => Promise<ProjectCloud>;
  now?: () => number;
  intervalMs?: number;
  /** Injected for the test; the real one is `fetch`. */
  request?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ status: number; text: string }>;
}

interface SyncDaemon {
  /** Run one cycle now, whatever the timer is doing. Returns undefined when not linked. */
  syncNow: () => Promise<SyncReport | undefined>;
  /**
   * Something worth shipping just landed — cycle soon rather than at the next tick.
   *
   * A verification RUN is the artifact people wait on, and making them wait up to a full interval
   * for it is the difference between a dashboard that reflects the work and one that lags it. The
   * counters keep the timer: they are a rolling aggregate, and a write per tool call to move a
   * number nobody is watching that second is exactly the cost the interval exists to avoid.
   *
   * Coalescing, never additive: many nudges in a burst collapse into one cycle.
   */
  nudge: () => void;
  stop: () => void;
}

const defaultRequest = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> => {
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text() };
};

/**
 * Start the loop. Safe to call for an UNLINKED project: it resolves the link on every tick and does
 * nothing until one appears, which is what lets `reticle link` take effect without a restart.
 */
export function startSyncDaemon(deps: SyncDaemonDeps): SyncDaemon {
  const intervalMs = deps.intervalMs ?? DAEMON_SYNC_INTERVAL_MS;
  // Never slower than the idle rate: a deployment that lengthens the interval means "sync less", and
  // an active burst must not quietly re-introduce the cost it was lowering.
  const activeIntervalMs = Math.min(DAEMON_SYNC_ACTIVE_INTERVAL_MS, intervalMs);
  const now = deps.now ?? ((): number => Date.now());
  const request = deps.request ?? defaultRequest;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  /** The last error already reported. Repeats are swallowed so an offline laptop stays quiet. */
  let reportedError: string | undefined;
  /**
   * Whether the last cycle found a link — undefined until the first one has looked.
   *
   * An unlinked project used to sync nothing and say nothing, which is indistinguishable from a
   * working sync until somebody notices the dashboard is hours behind. Observed for real: the
   * daemon was started from a sibling repo that had never been linked, so every call for an entire
   * session was recorded into THAT repo's ledger and pushed nowhere, and the first evidence was a
   * stale number on a dashboard nobody had reason to distrust.
   *
   * Announced on the FIRST cycle and on every change after it, so `reticle link` mid-session says
   * so too. Once per transition, never per tick — a line every minute is a line people stop reading.
   */
  let wasLinked: boolean | undefined;

  /** One root's bundle. The state, source and sink are already per-root; only the caller was not. */
  const pushRoot = async (root: string, cloud: ProjectCloud): Promise<SyncReport | undefined> => {
    if (null === cloud.config) return undefined;
    const full = diskSource(root);
    return runSyncCycle({
      config: cloud.config,
      source: {
        runs: () => (cloud.policy.runs ? full.runs() : []),
        flows: () => (cloud.policy.flows ? full.flows() : []),
        derived: (kind) => (cloud.policy.memory ? full.derived(kind) : undefined),
      },
      sink: diskSink(root),
      state: readCloudState(root),
      now,
      request,
    });
  };

  /**
   * Push every other linked root this machine knows about.
   *
   * Isolated per root on purpose. A revoked credential, a deleted directory or an unreachable
   * self-hosted server in ONE repo is a fact about that repo; letting it throw would take the
   * daemon's own push down with it and turn one broken link into a machine-wide outage.
   */
  const syncOtherRoots = async (): Promise<void> => {
    const roots = deps.otherRoots;
    const cloudFor = deps.cloudFor;
    if (roots === undefined || cloudFor === undefined) return;
    let list: readonly string[] = [];
    try {
      list = await roots();
    } catch {
      // Enumeration is best-effort: a registry that cannot be read must not stop this daemon
      // syncing the root it is standing in.
      return;
    }
    for (const root of list) {
      if (root === deps.reticleRoot) continue;
      try {
        const cloud = await cloudFor(root);
        if (null === cloud.config) continue;
        const report = await pushRoot(root, cloud);
        if (report === undefined) continue;
        if (report.error !== undefined) {
          log('reticle_cloud_sync_failed', { root, error: report.error });
          continue;
        }
        const moved =
          report.runsSent > 0 ||
          report.flowsSent > 0 ||
          report.derivedSent.length > 0 ||
          report.pulled > 0;
        // The root is NAMED here and not in the single-root log below, because with several repos
        // reporting, "synced 3 runs" without a directory is not an answer to "synced from where".
        if (moved) log('reticle_cloud_synced', { root, summary: describeSync(report) });
      } catch (error: unknown) {
        log('reticle_cloud_sync_failed', {
          root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const cycle = async (): Promise<SyncReport | undefined> => {
    // Overlap guard: a slow cycle must not have a second one started on top of it, or two bundles
    // race and the cursor written by the loser silently rewinds the winner's progress.
    if (running) return undefined;
    running = true;
    try {
      const cloud = await deps.cloud();
      const linked = null !== cloud.config;
      if (linked !== wasLinked) {
        wasLinked = linked;
        if (linked)
          log('reticle_cloud_linked', {
            projectId: cloud.projectId,
            root: deps.reticleRoot,
          });
        // Names the ROOT, because the answer is almost always "the daemon is not where you think it
        // is" — and a message that omits the directory sends people to check their key instead.
        else
          log('reticle_cloud_unlinked', {
            root: deps.reticleRoot,
            fix: 'run `reticle link` in this directory, or start the daemon in the linked one — nothing is being synced from here',
          });
      }
      // Every OTHER linked root, first. Their failures are logged and never abort this daemon's own
      // push: one repo whose credential was revoked must not silence the rest of the machine.
      await syncOtherRoots();

      if (null === cloud.config) return undefined;
      const report = await pushRoot(deps.reticleRoot, cloud);
      // `pushRoot` returns undefined only for an unlinked root, which the guard above has ruled out.
      if (report === undefined) return undefined;
      if (report.error !== undefined) {
        if (report.error !== reportedError) {
          reportedError = report.error;
          log('reticle_cloud_sync_failed', { error: report.error });
        }
      } else {
        reportedError = undefined;
        // Only when something actually moved. A per-minute "nothing to send" is noise that trains
        // people to stop reading the log.
        const moved =
          report.runsSent > 0 ||
          report.flowsSent > 0 ||
          report.derivedSent.length > 0 ||
          report.pulled > 0;
        if (moved) log('reticle_cloud_synced', { summary: describeSync(report) });
        /*
         * A cycle that moved something means a drive is in progress, so the next one comes sooner;
         * one that moved nothing means the machine is idle, so it backs straight off. The rate
         * follows the work without needing to be told about sessions, and an idle laptop settles at
         * the same cost it had before this existed.
         */
        nextDelay = moved ? activeIntervalMs : intervalMs;
      }
      return report;
    } catch (error: unknown) {
      // Belt and braces: runSyncCycle already swallows, and a throw here would kill the timer.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== reportedError) {
        reportedError = message;
        log('reticle_cloud_sync_failed', { error: message });
      }
      return undefined;
    } finally {
      running = false;
    }
  };

  /** The delay for the NEXT cycle: fast while the last one moved something, slow once it stops. */
  let nextDelay = intervalMs;

  const schedule = (delay: number): void => {
    if (stopped) return;
    // Replace, never stack. `nudge` and the interval both schedule, and leaving the old timer armed
    // would let every nudge add a permanent extra cycle per minute for the life of the process.
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void cycle().finally(() => schedule(nextDelay));
    }, delay);
    // Unref'd: a pending sync must never be the reason a process refuses to exit.
    timer.unref?.();
  };

  schedule(FIRST_CYCLE_DELAY_MS);

  return {
    syncNow: cycle,
    nudge: (): void => {
      // A cycle already in flight will not pick this up, so the nudge is still scheduled behind it
      // rather than dropped — otherwise the run that arrived during a slow cycle waits a full tick.
      schedule(NUDGE_DELAY_MS);
    },
    stop: (): void => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
