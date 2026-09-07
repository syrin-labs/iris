import { NO_SESSION_CONNECTED_ERROR } from '@reticlehq/core';
import { notePendingNoSessionReason } from '../telemetry/tool-refused.js';
import type { NoSessionReason } from '@reticlehq/core';
import {
  declareDrivenRedactionKeys,
  forgetDrivenRedactionKeys,
} from '../input/driven-redaction.js';
import { Session, type SessionInfo } from './session.js';
import { AttachmentHistory } from './attachment-history.js';
import type { NoSessionNextAction } from './no-session-next-action.js';
import { pickDocumentSuccessor, type SessionIdentity } from './session-successor.js';

/**
 * The agent's active project, used to scope auto-selection. `projectId` is the stable build-stamped
 * identity (authoritative when present); `url` is the app origin, a fallback hint for older SDKs that
 * don't stamp a projectId. Both optional — an empty scope means "no project filter" (legacy behavior).
 */
interface ResolveScope {
  projectId?: string;
  url?: string;
}

/** The scheme://host:port of a URL, or undefined if it can't be parsed. Used to compare origins. */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Narrow a session list to those belonging to the scoped project. With a `projectId` the match is by
 * that stable id (origin ignored — it survives port swaps). With only a `url`, match by origin. With
 * no scope, return the list unchanged (legacy single-/multi-session behavior).
 */
function scopeSessions(sessions: Session[], scope?: ResolveScope): Session[] {
  if (scope === undefined) return sessions;
  if (scope.projectId !== undefined) {
    return sessions.filter((s) => s.projectId === scope.projectId);
  }
  const wantOrigin = originOf(scope.url);
  if (wantOrigin !== undefined) {
    return sessions.filter((s) => originOf(s.url) === wantOrigin);
  }
  return sessions;
}

/**
 * Honest, scoped error when sessions exist but none match the agent's project.
 *
 * The daemon takes its default scope from the `.reticle.json` of whichever directory started it, so
 * attaching from a second project — or another worktree of the SAME project — makes every tool
 * refuse while `reticle_sessions` shows the tab sitting right there. The old message asked "is that
 * app running with @reticlehq/core enabled?", which is the one thing that is definitely true, so the
 * reader goes looking at their app instead of at the scope. Name what IS connected and how to
 * target it: both facts are already in hand here.
 */
function scopeMissError(connected: Session[], scope?: ResolveScope): string {
  const who =
    scope?.projectId !== undefined
      ? `project '${scope.projectId}'`
      : scope?.url !== undefined
        ? `your app at ${scope.url}`
        : 'the active project';
  const listed = connected
    .map((s) => `'${s.projectId ?? 'untagged'}' (${s.url}, sessionId '${s.id}')`)
    .join(', ');
  return (
    `no browser session for ${who}, but ${String(connected.length)} session(s) ARE connected under a ` +
    `different project: ${listed}. The daemon scopes to the .reticle.json of the directory it was ` +
    `started in, so this is a scope mismatch, not a dead app. Pass the sessionId above to target one, ` +
    `or restart the daemon from that app's directory.`
  );
}

/**
 * Owns the set of connected browser sessions and the smart auto-selection that resolves which one a
 * tool targets when the agent omits an explicit sessionId. Extracted from session.ts so each file
 * stays one cohesive unit (Session = one tab; SessionManager = the registry over all tabs).
 */
/** How many bridge-initiated closes to remember for diagnosis. */
const MAX_REMEMBERED_CLOSURES = 5;

/**
 * How many recently-departed session ids to remember for successor rebind.
 *
 * A full-document navigation HELLO's back under a new id while the agent still holds the old one.
 * The tombstone is how `resolve(oldId)` finds the unique same-origin successor instead of refusing.
 * Bounded so a long-lived daemon cannot accumulate one record per tab forever.
 */
const MAX_TOMBSTONES = 32;

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  /**
   * Continuity per session, so a listing can answer "was this attached the whole time".
   *
   * Owned here because this is the one place that sees both halves — every add and every remove.
   */
  readonly #attachment = new AttachmentHistory();
  /**
   * Recently departed sessions, keyed by the id the agent still holds.
   *
   * Insertion order is LRU: the oldest is dropped when the cap is hit. A reconnect under the same
   * id forgets its tombstone — the live session is the answer then.
   */
  readonly #tombstones = new Map<string, SessionIdentity>();
  /**
   * The active project's scope, set once from the daemon's .reticle.json. When a tool resolves a session
   * without passing its own scope, this is applied — so auto-selection is project-scoped by default
   * and a stray tab from another app is never picked, even on the no-sessionId path.
   */
  #defaultScope: ResolveScope | undefined;

  /** Set the active project's default resolve scope (called once at daemon wiring). */
  setDefaultScope(scope: ResolveScope | undefined): void {
    this.#defaultScope = scope;
  }

  /**
   * Told about every session that registers, so the fact outlives this process.
   *
   * Injected rather than done here: this class owns a registry, not the filesystem. Wired here
   * because `add` is the ONE method every path that registers a session goes through — the same
   * reasoning that put the redaction declaration below it.
   */
  #recordConnection: ((projectId: string | undefined) => void) | undefined;

  setConnectionRecorder(record: ((projectId: string | undefined) => void) | undefined): void {
    this.#recordConnection = record;
  }

  add(session: Session): Session | undefined {
    this.#everConnected = true;
    this.#recordConnection?.(session.projectId);
    const previous = this.#sessions.get(session.id);
    this.#sessions.set(session.id, session);
    // Who can SEE this session's HUD feed. Wired here because `add` is the one method every path
    // that registers a session goes through, and read lazily so a tab that opens later still counts.
    // Optional-call for the same reason `pushImpact` is one at the dispatch chokepoint: a test
    // double is a partial Session, and wiring a courtesy channel must never break registration.
    session.setViewers?.(() => this.#viewersFor(session));
    // Publish what this app declared sensitive to the driven-path rule. Here rather than in the
    // bridge because EVERY path that registers a session goes through this method, and a declaration
    // that silently fails to register is a leak nothing would report.
    declareDrivenRedactionKeys(session.id, session.redactKeys);
    this.#attachment.attached(session.id);
    this.#tombstones.delete(session.id);
    return previous;
  }

  /**
   * The other tabs of the same app as `driven`.
   *
   * Scoped the same way auto-selection is: by the stable projectId when the driven tab stamped one,
   * else by origin. A drive session is frequently a headless pooled context (see Session.#viewers),
   * so without this the human's own tab is the one place the report never reaches.
   */
  #viewersFor(driven: Session): Session[] {
    const scope: ResolveScope =
      driven.projectId === undefined ? { url: driven.url } : { projectId: driven.projectId };
    return scopeSessions([...this.#sessions.values()], scope).filter((s) => s !== driven);
  }

  remove(session: Session): boolean {
    if (this.#sessions.get(session.id) !== session) return false;
    session.rejectAll('session disconnected');
    forgetDrivenRedactionKeys(session.id);
    // Recorded, not forgotten: a session that comes back needs its gap measured, and a listing after
    // the reconnect is exactly where that matters.
    this.#attachment.detached(session.id);
    this.#rememberTombstone(session);
    return this.#sessions.delete(session.id);
  }

  #rememberTombstone(session: Session): void {
    const origin = originOf(session.url);
    if (origin === undefined) return;
    if (this.#tombstones.has(session.id)) this.#tombstones.delete(session.id);
    this.#tombstones.set(session.id, {
      id: session.id,
      url: session.url,
      ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    });
    while (this.#tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }

  #successorOf(sessionId: string): Session | undefined {
    const departed = this.#tombstones.get(sessionId);
    if (departed === undefined) return undefined;
    const picked = pickDocumentSuccessor(
      this.all().map((s) => ({
        id: s.id,
        url: s.url,
        ...(s.projectId === undefined ? {} : { projectId: s.projectId }),
      })),
      departed,
    );
    if (picked === undefined) return undefined;
    return this.#sessions.get(picked.id);
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => {
      const info = s.info();
      const attachment = this.#attachment.of(s.id);
      return attachment === undefined ? info : { ...info, attachment };
    });
  }

  /** Continuity for one session — "has this been attached the whole time I am reasoning about?" */
  attachmentOf(sessionId: string): ReturnType<AttachmentHistory['of']> {
    return this.#attachment.of(sessionId);
  }

  /** Every connected session — used by the liveness reaper to sweep for idle/disconnected ones. */
  all(): Session[] {
    return [...this.#sessions.values()];
  }

  count(): number {
    return this.#sessions.size;
  }

  /**
   * Resolve the target session. With an explicit id, returns it. With none and exactly
   * one connected, returns that.
   *
   * With none and multiple connected, applies smart auto-selection:
   * 1. Prefer non-throttled sessions (not hidden + recently heard from).
   * 2. Within each tier, prefer lowest lastSeenMs (most recently active SDK heartbeat).
   * 3. If two or more non-throttled sessions are within 1 s of each other, throw —
   * genuinely ambiguous, agent must specify sessionId.
   * 4. If ALL sessions are throttled (e.g. user is working in their editor on another
   * desktop), skip the gap check and pick the freshest heartbeat. This lets the agent
   * keep working in the background without requiring sessionId every time.
   */
  /**
   * Why a session recently went away, when the bridge closed it rather than the tab.
   *
   * The bridge enforces a message-rate cap and closes the socket on breach with `1008 message rate
   * exceeded` — a policy violation, so the SDK does not retry. The app keeps running and Reticle is
   * blind from that moment. Measured on the bench app: 2600 requests fired in one tick disconnected
   * the session permanently, and the only trace was a line in the PAGE console, which no agent reads.
   *
   * Without this the agent is told "no browser session connected — check your app is running with
   * @reticlehq/browser enabled", which is precisely wrong: the app IS running and instrumented. It
   * was hung up on. Keeping the last few reasons turns an unexplained disappearance into a fact.
   */
  readonly #recentClosures: { at: number; reason: string }[] = [];

  /**
   * What the daemon knows about WHY nothing is connected, refreshed in the background.
   *
   * Measured: of the sessions that call any tool, half make exactly one call — usually
   * reticle_sessions — and stop, because the answer they get names two things they cannot check and
   * nothing they can do. The daemon can tell "no app is running" from "an app is running and never
   * dialled us" from "one was connected and left", and each has a different fix. Optional so a
   * bridge constructed without a daemon (every unit test) keeps the plain message.
   */
  #noSessionHint: (() => string | undefined) | undefined;
  /**
   * The CODE for the same diagnosis `#noSessionHint` renders as prose.
   *
   * Registered from the same `explainNoSession` call as the hint, so the two cannot describe
   * different branches. See no-session-watch.ts.
   */
  #noSessionReason: (() => NoSessionReason | undefined) | undefined;

  /** Wire the diagnosis provider (daemon boot). Absent ⇒ the plain, static message. */
  setNoSessionHint(hint: (() => string | undefined) | undefined): void {
    this.#noSessionHint = hint;
  }

  /**
   * The same diagnosis, for a caller that is ASKING about sessions rather than failing to get one.
   *
   * `reticle_sessions` is the first thing an agent reaches for and it returned a bare empty array —
   * confidently, with nothing to act on. An agent cannot tell an empty list apart from a daemon that
   * is down, an app with no SDK, or a tab that was closed, so it stops there. The diagnosis was
   * already computed for the error path; this exposes it to the read path too.
   */
  noSessionHint(): string | undefined {
    return this.#noSessionHint?.();
  }

  setNoSessionReason(reason: (() => NoSessionReason | undefined) | undefined): void {
    this.#noSessionReason = reason;
  }

  noSessionReason(): NoSessionReason | undefined {
    return this.#noSessionReason?.();
  }

  /**
   * The same diagnosis with the prose taken out — one action kind and one literal command.
   *
   * Separate from the hint rather than folded into it because the two have different consumers and
   * different lifetimes: `resolve` throws an Error, which can only ever carry a string, while
   * `reticle_sessions` returns a structured payload an agent can branch on without parsing English.
   */
  #noSessionNextAction: (() => NoSessionNextAction | undefined) | undefined;

  setNoSessionNextAction(next: (() => NoSessionNextAction | undefined) | undefined): void {
    this.#noSessionNextAction = next;
  }

  noSessionNextAction(): NoSessionNextAction | undefined {
    return this.#noSessionNextAction?.();
  }

  /** Whether any session has connected since this daemon booted — half the diagnosis. */
  #everConnected = false;

  everConnected(): boolean {
    return this.#everConnected;
  }

  /** Record a bridge-initiated close so `resolve` can explain a session that vanished. */
  noteClosure(reason: string, at: number): void {
    this.#recentClosures.push({ at, reason });
    if (this.#recentClosures.length > MAX_REMEMBERED_CLOSURES) this.#recentClosures.shift();
  }

  /** The most recent bridge-initiated close, if any. */
  lastClosure(): { at: number; reason: string } | undefined {
    return this.#recentClosures[this.#recentClosures.length - 1];
  }

  /**
   * The id of the session that most recently went away, if any.
   *
   * Distinct from {@link lastClosure}, which only records closes the bridge itself initiated
   * (handshake refusals, auth failures) — an ordinary disconnect never reaches it. This reads the
   * tombstone ring `remove()` maintains, so it covers every departure.
   *
   * Read by the no-session diagnosis, which needs to say something about the session that actually
   * vanished rather than about the daemon's lifetime history (#611).
   */
  lastDeparted(): string | undefined {
    let last: string | undefined;
    for (const id of this.#tombstones.keys()) last = id;
    return last;
  }

  /**
   * A dead `sessionId`, answered with what the caller needs to recover — not with an errand.
   *
   * Telemetry, 2026-08-10: one agent called `reticle_navigate` twelve times against an id that was
   * no longer connected. That single loop is **12 of the 58 tool errors recorded all day, 21%**. The
   * refusal said only `no connected session with id 'x'`, and the recovery hint told it to call
   * `reticle_sessions` and retry — two extra round trips to learn something this method already
   * knows at the moment it refuses. An agent charged two calls to recover will often just repeat the
   * one it made.
   *
   * So: name the live ids inline, and when there are none say that instead, because "retry with a
   * valid one" is advice nobody can act on when no valid one exists.
   */
  #unknownSessionError(sessionId: string): string {
    const live = [...this.#sessions.values()];
    if (0 === live.length) {
      return (
        `no connected session with id '${sessionId}', and no sessions are connected at all — so ` +
        'there is no other id to retry with. The app is not dialling this daemon; call ' +
        'reticle_sessions for the diagnosis rather than retrying this call.'
      );
    }
    const named = live.map((s) => `'${s.id}' (${s.url})`).join(', ');
    return (
      `no connected session with id '${sessionId}'. Connected right now: ${named}. ` +
      'Retry with one of those, or omit sessionId entirely and let Reticle scope to your project.'
    );
  }

  resolve(sessionId?: string, scope?: ResolveScope): Session {
    if (sessionId !== undefined) {
      const found = this.#sessions.get(sessionId) ?? this.#successorOf(sessionId);
      if (found === undefined) {
        throw new Error(this.#unknownSessionError(sessionId));
      }
      found.markAgentActivity(); // liveness — a targeted tool keeps the session alive / revives it
      return found;
    }
    if (0 === this.#sessions.size) {
      const closure = this.lastClosure();
      // A diagnosis beats a checklist: it names which of the three causes this actually is.
      const hint = this.#noSessionHint?.();
      // BOTH, when there are both — the two answer different questions and the pair is strictly
      // more than either. This used to be an either/or, and a recorded refusal DISCARDED the whole
      // diagnosis: the one case where the daemon has hard evidence about why nothing is connected
      // was also the one case where it threw away everything else it had learned, including the
      // port scan and the next action. The refusal leads, because it is the fact.
      const refusal =
        closure === undefined
          ? ''
          : ` NOTE: the bridge REFUSED or closed a connection recently — "${closure.reason}". The app is probably still running and trying to connect: it was turned away, and the SDK does not retry after a policy close. The reason above names the fix — do not go looking for a stopped dev server.`;
      // Hand the branch code to the refusal that is about to be reported for this throw. The
      // diagnosis is computed HERE and the refusal is classified from the message downstream, so
      // without this the largest refusal cohort stays one undifferentiated bucket (#615).
      notePendingNoSessionReason(this.#noSessionReason?.());
      throw new Error(`${hint ?? NO_SESSION_CONNECTED_ERROR}${refusal}`);
    }
    // Scope to the agent's active project FIRST, so a stray tab from another app/origin (e.g. a
    // leftover dashboard on a different port) is structurally unselectable — it never enters the
    // candidate set, no matter how recently it was heard from. This is the anti-cross-talk guard.
    // An explicit per-call scope wins; otherwise the daemon's active-project default applies.
    const effectiveScope = scope ?? this.#defaultScope;
    const connected = [...this.#sessions.values()];
    const all = scopeSessions(connected, effectiveScope);
    if (0 === all.length) {
      // Sessions exist, but none belong to the scoped project — never fall back to a foreign tab.
      // ponytail: still a refusal, deliberately. Auto-targeting the only connected tab would be the
      // friendlier 90% case and would also silently defeat the anti-cross-talk guard this scope
      // exists to be. Naming the tab and its sessionId costs the agent one extra argument.
      throw new Error(scopeMissError(connected, effectiveScope));
    }
    if (1 === all.length) {
      const [only] = all;
      if (only === undefined) throw new Error('session lookup failed');
      only.markAgentActivity();
      return only;
    }

    // Two projects and nothing to choose between them: refuse, BEFORE any scoring.
    //
    // Reported from the field: a call from `apps/next-app-router` was answered by a `rowy-*`
    // session, and `act_and_wait` spent 16.9s returning `verified:'no'` about an app never under
    // test — a confident false verdict, with a source pointer, about code the agent never touched.
    //
    // The recency rule below cannot prevent it. It asks "is one of these clearly fresher", which is
    // the right question for two tabs of ONE app and the wrong question for two apps: the fresher
    // tab of the wrong project is still the wrong project. The reported case had a clear winner,
    // so the ambiguity check passed and the wrong app was selected.
    //
    // This sits ahead of scoring so freshness cannot rescue it. It only fires when nothing scoped
    // the call — an explicit `sessionId` returns far above, and an explicit or default scope has
    // already narrowed `all` to one project by here.
    const projects = new Set(all.map((s) => s.projectId).filter((p) => p !== undefined));
    if (projects.size > 1) {
      const listed = all
        .filter((s) => s.projectId !== undefined)
        .map((s) => `'${String(s.projectId)}' (${s.url}, sessionId '${s.id}')`)
        .join(', ');
      throw new Error(
        `${String(projects.size)} different projects are connected and nothing says which one this ` +
          `call is about: ${listed}. Pass sessionId to target one. Reticle refuses rather than ` +
          'guessing here because picking the wrong app produces a confident verdict about code you ' +
          'never touched — the daemon scopes to the directory it was started in, so running it above ' +
          'several apps leaves it unable to tell them apart.',
      );
    }

    // Multiple sessions: score each (lower = better candidate for auto-selection).
    // 0 = non-throttled (visible + recently-heard), 1 = throttled (hidden or stale heartbeat),
    // 2 = attached but not answering commands. A wedged tab keeps streaming events, so recency
    // RATES IT HIGHEST — it was beating a healthy sibling on the one signal scoring looked at, and
    // every call auto-targeted the one tab guaranteed to time out.
    const scored = all.map((s) => ({
      s,
      score: s.unresponsive() ? 2 : s.throttled() ? 1 : 0,
      ms: s.lastSeenMs(),
    }));
    const bestScore = Math.min(...scored.map((x) => x.score));
    const candidates = scored.filter((x) => x.score === bestScore);

    // Sort candidates by recency (ascending lastSeenMs = most recently active first).
    candidates.sort((a, b) => a.ms - b.ms);
    const [best, runnerUp] = candidates;

    if (best === undefined) throw new Error('session lookup failed');

    // Only auto-select if there is a clear winner.
    //
    // When at least one non-throttled (focused/visible) session exists, require a >1 s recency
    // gap before committing — two tabs that both had recent heartbeats are genuinely ambiguous.
    //
    // When ALL candidates are throttled (e.g. the user switched to their editor on another
    // desktop), the gap requirement is dropped: every session is already in "background" mode
    // so we just pick the one with the freshest heartbeat and let the agent proceed. Requiring
    // a gap here only produces spurious "ambiguous" errors while the user works elsewhere.
    // Nothing healthy left to choose between (all throttled, or all wedged): drop the gap check.
    const allThrottled = bestScore >= 1;
    const RECENCY_GAP_MS = allThrottled ? 0 : 1_000;
    const clearWinner = runnerUp === undefined || best.ms + RECENCY_GAP_MS < runnerUp.ms;

    if (!clearWinner) {
      // Ambiguous: list sessions with their health so the agent can choose.
      const detail = all
        .map(
          (s) =>
            `${s.id} (${s.throttled() ? 'throttled' : 'active'}, lastSeenMs=${s.lastSeenMs()})`,
        )
        .join(', ');
      throw new Error(`multiple sessions connected — pass sessionId to target one: ${detail}`);
    }

    best.s.markAgentActivity();
    return best.s;
  }
}
