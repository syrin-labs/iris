import {
  IntentState,
  JournalVerdictEffectSchema,
  RUN_ESTABLISHED_CAP,
  type Intent,
  type JournalAction,
} from '@reticlehq/core';
import { subjectOf } from '../runs/run-context.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * Were `reticle_context` and `reticle_intent` used at all — and did using them change anything?
 *
 * Both shipped with the same pre-registered disproof: *if agents never call it, cut it*. Nothing
 * recorded whether they were called, so the disproof could never be run, and a feature whose
 * disproof cannot be run is one nobody can kill. This is the smallest thing that makes the question
 * answerable, per session, locally — an instrument, not a scold. The numbers exist so a FEATURE can
 * be removed, never so an agent can be blamed for how it drove.
 *
 * ## Fold first, record only what nothing records
 *
 * Three of the four questions are already answerable from what is on disk. The intent ledger says
 * what was declared; the journal says what was driven and what verdicts were drawn. Those are folded
 * here and never re-stored, for the reason `run-context.ts` gives at length: two ways to compute one
 * number is worse than one way.
 *
 * The journal does NOT record read-only calls — it holds actions and verdicts only. So "was
 * `reticle_context` called" has no ledger to fold, and that one thing is recorded, in memory, on the
 * session, by `CaptureLedger`. It is the whole of the new state.
 *
 * ## Absent is not zero
 *
 * A session this daemon has recorded nothing for — journaling off, a session adopted after the fact
 * — reports `observed: false` and states no counts at all. It has not established that the features
 * went unused; it has established that it was not watching. This repo has shipped the other bug
 * twice.
 */

/**
 * The calls this instrument needs and the journal does not keep.
 *
 * Deliberately a short explicit list rather than "everything that is not an action". Under-inclusion
 * is the safe direction: a read tool missing from here lowers the hit side and the miss side by the
 * same call, so the comparison the disproof turns on stays fair. Over-inclusion is not — a lifecycle
 * or disk-side tool landing in here would be counted as a "read" the agent made of the app, which it
 * was not.
 */
export const CAPTURED_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.CONTEXT,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  ReticleTool.STATE,
  ReticleTool.STORAGE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.OBSERVE,
  ReticleTool.EXPLORE,
]);

/**
 * How many calls the ledger holds before it starts dropping the oldest.
 *
 * A verification loop is 50–200 calls, so this is not reached in normal use; it exists so a runaway
 * session cannot grow a per-session array without bound. When it IS reached the report says
 * `truncated` rather than presenting a short count as a complete one.
 */
const CAPTURE_CAP = 2000;

/** One recorded call: which tool, what it was about, and how far into the run it happened. */
export interface CapturedCall {
  tool: string;
  /** The ref or target the call named, when it named one. Absent for a whole-page read. */
  subject?: string;
  /**
   * The session's dispatched-action count at the moment of the call — the same counter that mints
   * journal action ids, so it lines up with `reticle_context`'s own `step` whenever the journal is on.
   */
  afterActions: number;
}

/**
 * The one thing that is stored rather than folded: the read-only calls the journal never sees.
 *
 * In memory and per session, the same shape as `GapLedger`. It is not durable on purpose — the
 * question is about one run, and a second file on disk would be a second thing to reconcile with the
 * journal.
 */
export class CaptureLedger {
  #calls: CapturedCall[] = [];
  #dropped = 0;
  #tools = new Map<string, number>();

  /**
   * One call, under the name of the tool that RAN — every tool, not just the read set above.
   *
   * Separate from `note` because it answers a different question and is bounded differently: this
   * map cannot outgrow the tool table however long the session runs, so it needs no cap and never
   * has to report a floor. See honesty/tool-hit-rate.ts for what it feeds.
   */
  noteTool(tool: string): void {
    this.#tools.set(tool, (this.#tools.get(tool) ?? 0) + 1);
  }

  /** How many times each tool was called this session, in first-call order. */
  toolCalls(): ReadonlyMap<string, number> {
    return this.#tools;
  }

  note(call: CapturedCall): void {
    this.#calls.push(call);
    if (this.#calls.length > CAPTURE_CAP) {
      this.#calls.shift();
      this.#dropped += 1;
    }
  }

  calls(): readonly CapturedCall[] {
    return this.#calls;
  }

  /** How many calls fell off the front. Non-zero means the counts below are a floor. */
  get dropped(): number {
    return this.#dropped;
  }
}

/**
 * Record one captured call against the session that made it.
 *
 * Tolerates a session that carries no ledger, exactly as `noteSessionGaps` does and for the same
 * reason: `Session` is satisfied structurally, and many specs — plus any consumer embedding this
 * engine — build one as an object literal. Such a session is a real caller that simply keeps no
 * ledger, and an instrument must never be the reason a tool call throws. Its calls are then absent
 * rather than counted as zero, which is what `observed: false` exists to say.
 */
export function noteCapturedCall(
  session: { capture?: CaptureLedger; actionCount?: number },
  call: Omit<CapturedCall, 'afterActions'>,
): void {
  session.capture?.note({ ...call, afterActions: session.actionCount ?? 0 });
}

/**
 * Count one call against the session that made it, whichever tool it was.
 *
 * Tolerant of a ledger-less session for exactly the reason `noteCapturedCall` is: its calls are then
 * absent rather than counted as zero, which is what `observed: false` exists to say.
 */
export function noteToolDispatched(session: { capture?: CaptureLedger }, tool: string): void {
  session.capture?.noteTool(tool);
}

/** What one session's use of the two features looks like. Everything but `observed` is omitted when nothing was recorded. */
interface FeatureCapture {
  /** False when this daemon recorded nothing for the session — "not watched", never "not used". */
  observed: boolean;
  /** The ledger dropped calls, so every count is a floor. Present only when true. */
  truncated?: boolean;
  context?: {
    calls: number;
    /** The dispatched-action count each call was made at, in order. */
    atSteps: number[];
    acted: number;
    refetched: number;
    readOther: number;
    nothingAfter: number;
  };
  intents?: { declared: number; open: number };
  missed?: { verdictsWithNoIntentDeclared: number; refetchedEstablished: number };
}

/**
 * Every point in the run at which each subject became an established fact.
 *
 * "Established" is not a second definition: it is the rule `establishedFromJournal` folds by — an
 * action with an observed settle outcome, filed under the ref or target it named — and `subjectOf`
 * is imported from there rather than rewritten, so the two cannot drift apart.
 */
function establishedIndexes(actions: readonly JournalAction[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  actions.forEach((action, index) => {
    if (undefined === action.settled) return;
    const key = subjectOf(action);
    if (undefined === key) return;
    const at = out.get(key);
    if (at === undefined) out.set(key, [index]);
    else at.push(index);
  });
  return out;
}

/** Was this subject already an established fact by the time a call at `afterActions` was made? */
function wasEstablished(
  index: Map<string, number[]>,
  subject: string | undefined,
  afterActions: number,
): boolean {
  if (undefined === subject) return false;
  const at = index.get(subject);
  if (at === undefined) return false;
  // Action `i` has been dispatched once the counter reads `i + 1`, so `i + 1 <= afterActions` is
  // "already true when the call was made" — which is what keeps a FIRST look off this count. The
  // lower bound is the run context's own window: a fact that has scrolled past RUN_ESTABLISHED_CAP
  // is not something `reticle_context` would have handed back, so re-reading it is not a re-fetch.
  return at.some((i) => i + 1 <= afterActions && i + 1 > afterActions - RUN_ESTABLISHED_CAP);
}

/**
 * Did calling `reticle_context` change what happened next?
 *
 * The mechanical proxy, stated so it can be argued with: look at the very next recorded call. If an
 * action was dispatched before it — the action counter moved — the agent ACTED, and the context
 * plausibly helped. If instead the next call is a read of a subject the context had just supplied,
 * the agent re-fetched what it had been handed, and the context did not help.
 *
 * ## What this proxy CANNOT see
 *
 *  - Whether the agent READ the response, reasoned over it, or wrote a better answer from it. There
 *    is no signal for that anywhere, and this must not be mistaken for one.
 *  - Anything that happens between two Reticle calls: source edits, calls to other MCP servers, a
 *    turn ending, a human interrupting. A long gap is invisible and reads as adjacency.
 *  - Reads that name no ref or target (a whole-page snapshot). They land in `readOther`, never in
 *    `refetched`, so a snapshot that duplicated the context is under-counted, not over-counted.
 *  - Causation. `acted` is proximity in a call sequence, nothing more. An agent that would have acted
 *    anyway is indistinguishable from one the context unblocked.
 *  - `reticle_context` called with no session connected — it answers there by design, and there is no
 *    per-session ledger to record it against, so those calls are missing entirely.
 *  - Two agents driving one session. Their calls interleave into one sequence and "next call" stops
 *    meaning "next thing that agent did".
 */
export function foldFeatureCapture(input: {
  calls: readonly CapturedCall[];
  dropped: number;
  actions: readonly JournalAction[];
  intents: readonly Intent[];
  /** The session's dispatched-action count now, so a run that ended on an action is not read as idle. */
  finalActions: number;
}): FeatureCapture {
  const { calls, actions, intents } = input;
  if (0 === calls.length && 0 === actions.length) return { observed: false };

  const established = establishedIndexes(actions);
  const isRefetch = (call: CapturedCall): boolean =>
    ReticleTool.CONTEXT !== call.tool &&
    wasEstablished(established, call.subject, call.afterActions);

  let acted = 0;
  let refetched = 0;
  let readOther = 0;
  let nothingAfter = 0;
  const atSteps: number[] = [];
  calls.forEach((call, i) => {
    if (ReticleTool.CONTEXT !== call.tool) return;
    atSteps.push(call.afterActions);
    const next = calls[i + 1];
    if (next === undefined) {
      if (input.finalActions > call.afterActions) acted += 1;
      else nothingAfter += 1;
      return;
    }
    if (next.afterActions > call.afterActions) acted += 1;
    else if (isRefetch(next)) refetched += 1;
    else readOther += 1;
  });

  // A verdict is any journal action carrying the bounded verdict effect both verification tools
  // write. Parsed with core's own schema rather than a local shape, for the usual reason.
  const verdicts = actions.filter((a) => JournalVerdictEffectSchema.safeParse(a.effect).success);

  return {
    observed: true,
    ...(input.dropped > 0 ? { truncated: true } : {}),
    context: { calls: atSteps.length, atSteps, acted, refetched, readOther, nothingAfter },
    intents: {
      declared: intents.length,
      open: intents.filter((it) => IntentState.PROVED !== it.state).length,
    },
    missed: {
      // The coarse question, asked honestly. Nothing binds a verdict to a specific intent outside
      // flow replay, so "covered" cannot mean "this intent proves this verdict" without inventing a
      // link Reticle cannot observe — the same reason `undeclared-change.ts` asks only whether
      // anything at all was declared. So this counts verdicts drawn against an EMPTY ledger, and
      // stops at zero once anything is declared. That zero is not a claim that every verdict was
      // covered; it is the end of what this can see.
      verdictsWithNoIntentDeclared: 0 === intents.length ? verdicts.length : 0,
      refetchedEstablished: calls.filter(isRefetch).length,
    },
  };
}
