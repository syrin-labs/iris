/**
 * A regular beat, so SILENCE in the daemon log becomes evidence.
 *
 * `installExitTrace` hooks `'exit'`, which a SIGKILL never fires. So a daemon that is killed —
 * crashed, OOM-ed, swept by another project, `kill -9`'d by the recipe in every troubleshooting
 * thread — leaves no trace at all, and the last line before its port goes dark is whatever it
 * happened to be doing. Worse, a daemon that DID exit logs `code: 0`, so a tidy shutdown and a
 * violent death are the same shape to anyone reading the file.
 *
 * Measured cost of that: a correct SvelteKit install was written up as an install failure, because
 * the daemon had died 21 seconds earlier and nothing in the log said so. The fixture was named in the
 * report; the daemon was not.
 *
 * Two halves, and the second is what makes the first worth having:
 *   - DaemonHeartbeat emits `reticle_daemon_alive` on a fixed cadence, unconditionally.
 *   - classifyDaemonLife reads a log back and says which way the daemon ended.
 *
 * A heartbeat nobody interprets is just log volume.
 */

/** The event name a beat carries. One `grep` separates liveness from everything else in the file. */
export const DAEMON_HEARTBEAT_EVENT = 'reticle_daemon_alive';
/** Written by installExitTrace when the process exits through Node. */
const DAEMON_EXIT_EVENT = 'reticle_daemon_exiting';
/** Written by installExitTrace when a signal arrives, which is a CAUSE the exit line does not carry. */
const DAEMON_SIGNAL_EVENT = 'reticle_daemon_signalled';

/**
 * How often a live daemon says so.
 *
 * The median daemon lives 28 minutes, so at 30s that is ~56 lines — readable, and small against a log
 * that already rotates. Shorter would make the gap sharper and the file noisier; the gap only needs
 * to be legible against a connect window, which is measured in seconds.
 */
export const DAEMON_HEARTBEAT_MS = 30_000;

/**
 * How many beats may be missed before a reader calls it dead.
 *
 * Timers slip under load — the battery boots three servers and a browser — and a reader that cries
 * death on one late beat is a reader people learn to ignore. Two intervals plus a margin.
 */
const MISSED_BEATS_TOLERATED = 2;

/**
 * The cadence, from the environment. Same shape as `resolveIdleCheckMs`: a bad value falls back
 * rather than throwing, and 0 or negative is not a legal cadence — it would spin.
 */
export function resolveHeartbeatMs(raw: string | undefined): number {
  if (raw === undefined || '' === raw.trim()) return DAEMON_HEARTBEAT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DAEMON_HEARTBEAT_MS;
  return Math.floor(n);
}

interface HeartbeatFacts {
  /** Browser sessions connected right now. */
  sessions: number;
  /**
   * Has this daemon EVER served a tool call? A lifetime fact, not a window count.
   *
   * It is the difference between a death that cost somebody work and one that cost nothing — the
   * same distinction `isUselessDaemon` already draws. A windowed count would reset under the reader
   * and make a long-lived daemon look freshly idle.
   */
  served: boolean;
}

interface DaemonHeartbeatOptions {
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Read at each beat, never cached — the point is to describe the daemon NOW. */
  facts: () => HeartbeatFacts;
  intervalMs?: number;
  /** Injected, per the repo rule: never call Date.now() inside logic. */
  clock?: () => number;
}

export class DaemonHeartbeat {
  readonly #log: DaemonHeartbeatOptions['log'];
  readonly #facts: () => HeartbeatFacts;
  readonly #intervalMs: number;
  readonly #clock: () => number;
  readonly #startedAt: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: DaemonHeartbeatOptions) {
    this.#log = opts.log;
    this.#facts = opts.facts;
    this.#intervalMs = opts.intervalMs ?? DAEMON_HEARTBEAT_MS;
    this.#clock = opts.clock ?? ((): number => Date.now());
    this.#startedAt = this.#clock();
  }

  /**
   * One beat. Exposed so a test can drive it with an injected clock rather than waiting.
   *
   * Unconditional on purpose. Skipping the beat when nothing happened is the obvious optimisation and
   * it destroys the signal: silence would then mean "idle" OR "dead", which is precisely the
   * ambiguity this exists to remove.
   */
  beat(): void {
    const facts = this.#facts();
    this.#log(DAEMON_HEARTBEAT_EVENT, {
      uptimeMs: this.#clock() - this.#startedAt,
      // The cadence travels WITH the beat so a reader never hard-codes it. Hard-coding is how the
      // reader and the emitter drift apart the first time the interval is tuned.
      everyMs: this.#intervalMs,
      sessions: facts.sessions,
      served: facts.served,
    });
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.beat(), this.#intervalMs);
    // Never the reason a process stays alive — this is a diagnostic, not a workload.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** How a daemon's life ended, as far as its own log can say. */
export const DaemonEnd = {
  /** Still beating within tolerance. */
  ALIVE: 'alive',
  /** Logged its own exit, with no signal before it. */
  CLEAN: 'clean',
  /** A signal arrived — the cause an exit line with `code: 0` does not carry. */
  SIGNALLED: 'signalled',
  /** The beat simply stopped. No exit, no signal: killed, crashed, or swept. */
  DIED_SILENTLY: 'died_silently',
  /** No beat was ever emitted, so this log cannot answer the question. */
  UNKNOWN: 'unknown',
} as const;
export type DaemonEnd = (typeof DaemonEnd)[keyof typeof DaemonEnd];

/**
 * One parsed line of a daemon log. The index signature is not laziness: these lines carry whatever
 * their event needed (`code`, `port`, `pid`, `reason`, …), and a reader that refused unknown keys
 * would reject the very file it exists to read.
 */
interface LogLine {
  t: number;
  event: string;
  signal?: unknown;
  everyMs?: unknown;
  [field: string]: unknown;
}

export interface DaemonLife {
  end: DaemonEnd;
  /** When the last beat landed, or undefined if there was never one. */
  lastBeatMs?: number;
  /** How long the log has been silent, when that is the finding. */
  silentForMs?: number;
  signal?: string;
}

/**
 * Read a daemon log back and say how it ended.
 *
 * UNKNOWN rather than ALIVE when there is no heartbeat at all — every log written before this
 * existed, and any file the reader was pointed at by mistake. Inferring health from the absence of a
 * signal we never sent is the same confident-wrong this module replaces.
 */
export function classifyDaemonLife(lines: readonly LogLine[], nowMs: number): DaemonLife {
  const beats = lines.filter((l) => l.event === DAEMON_HEARTBEAT_EVENT);
  const exit = lines.findLast((l) => l.event === DAEMON_EXIT_EVENT);
  const signal = lines.findLast((l) => l.event === DAEMON_SIGNAL_EVENT);

  if (exit !== undefined) {
    // A signal is the CAUSE; the exit line only says it happened. Reporting `clean` for a SIGTERMed
    // daemon is how "shut down tidily" and "the bridge every app needs is gone" became one sentence.
    return signal === undefined
      ? { end: DaemonEnd.CLEAN }
      : {
          end: DaemonEnd.SIGNALLED,
          ...('string' === typeof signal.signal ? { signal: signal.signal } : {}),
        };
  }

  const last = beats.at(-1);
  if (last === undefined) return { end: DaemonEnd.UNKNOWN };

  const everyMs = 'number' === typeof last.everyMs ? last.everyMs : DAEMON_HEARTBEAT_MS;
  const silentForMs = nowMs - last.t;
  return silentForMs > everyMs * MISSED_BEATS_TOLERATED
    ? { end: DaemonEnd.DIED_SILENTLY, lastBeatMs: last.t, silentForMs }
    : { end: DaemonEnd.ALIVE, lastBeatMs: last.t };
}
