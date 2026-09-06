import { createHash } from 'node:crypto';
import { IntentStore } from './intent-store.js';
import { sessionRoot } from '../project/session-root.js';
import type { ToolDeps } from '../tools/tool-kit.js';

/**
 * Intent declared INLINE, on the tool that is already drawing the verdict.
 *
 * `reticle_intent` is on the extended surface, so declaring intent costs an agent a discovery, a
 * decision and a round trip before it has done anything — three places the capture silently fails,
 * and it does. `reticle_act_and_wait` and `reticle_assert` are in every agent's tool list already,
 * so one optional argument there makes the declaration free and discoverable by construction.
 *
 * This is a shortcut into the EXISTING ledger, never a second one. It writes `.reticle/intent.json`
 * through `IntentStore` exactly as `reticle_intent { action: "declare" }` does, so a reviewer reads
 * one file in one vocabulary and cannot tell from the row which door the intent came in by. The
 * pattern is `flows/flow-intent.ts`, which does the same job for a saved flow.
 */

/** Namespaced like `flow:`, so an inline id never collides with one an agent chose by hand. */
const INLINE_INTENT_ID_PREFIX = 'inline:';
const ID_SEPARATOR = ':';
const SLUG_SEPARATOR = '-';
const SLUG_MAX = 48;
const HASH_LENGTH = 8;
const HASH_ALGORITHM = 'sha1';
const NON_SLUG = /[^a-z0-9]+/g;
const SLUG_EDGES = /^-+|-+$/g;

/**
 * The ledger id a piece of inline prose is declared under.
 *
 * Derived from the statement rather than minted, so the same sentence declared on five verdicts is
 * one row rather than five, and a DIFFERENT sentence is a different row rather than a false
 * amendment of the first. The slug is there because the id is what an agent later types to reference
 * the intent, and a bare digest is unreadable; the digest is there because the slug is truncated and
 * two long statements sharing a prefix must not share a row.
 */
function inlineIntentId(statement: string): string {
  const slug = statement
    .toLowerCase()
    .replace(NON_SLUG, SLUG_SEPARATOR)
    .replace(SLUG_EDGES, '')
    .slice(0, SLUG_MAX)
    .replace(SLUG_EDGES, '');
  const digest = createHash(HASH_ALGORITHM).update(statement).digest('hex').slice(0, HASH_LENGTH);
  return `${INLINE_INTENT_ID_PREFIX}${slug}${SLUG_SEPARATOR}${digest}`;
}

/** What `provenBy` records: which tool drew the verdict, and when. */
export function inlineVerdictId(tool: string, at: number): string {
  return `${tool}${ID_SEPARATOR}${String(at)}`;
}

/**
 * Put an inline intent in the ledger and attach the predicate about to be evaluated. Returns the id
 * the verdict may later discharge, or undefined when there was no intent to record.
 *
 * `intent` carries EITHER prose OR the id of an intent already in the ledger. One field rather than
 * two because the surface is the scarce thing here and the two cases are told apart by the ledger
 * itself: a string that names an existing row is a reference, anything else is prose. A statement
 * that happens to equal an existing id is the same intent said twice, so pointing at the row is the
 * right answer there too, not a collision.
 *
 * A referenced intent is never re-declared, which would overwrite the agent's own words with an id,
 * and its binding is left alone when it already has one — a predicate bound deliberately through
 * `reticle_intent { action: "bind" }` is a stronger statement than whatever this one call asserts,
 * and quietly replacing it is exactly the narrowing the ledger exists to make visible.
 *
 * Best-effort by construction: a ledger that cannot be written is a small problem, and a verdict
 * that fails to return because of one is a large problem.
 */
/**
 * The surface an inline intent was captured on, so the store can FILE it.
 *
 * Measured on a real corpus: 167 of 173 things a project knew landed in `unsorted`, because
 * `act_and_wait({ intent })` declared a statement and nothing else. The subject ladder had no flow,
 * no route and no explicit subject to work from, so every record fell to the bucket of last resort
 * — and a coverage map that is one pile with six labels tells a manager the team knows nothing,
 * when the truth is that it knows a great deal and none of it is filed.
 *
 * The ROUTE is what makes this work at all, because it is always available: an agent asserting
 * something is always somewhere. A flow name is better when there is one, and `subjectFor` already
 * prefers it — this only has to supply both and let that ladder decide.
 *
 * Query and hash are dropped. `/issues?category=severe` and `/issues` are the same subject seen
 * twice; keeping the query would shard one area of the product across every filter anybody used.
 *
 * Returns undefined rather than an empty object when there is nothing to record. A surface that
 * says nothing reads as a capture that looked for a location and found none, rather than one that
 * never had one — and the second is the truth.
 */
/**
 * Strip a trailing `:line` from a `file:line` label.
 *
 * Anchored to the END and to digits, because a Windows path carries its own colon: splitting on the
 * first one turns `C:\\app\\src\\cart.tsx:12` into `C`, which is a path to nothing and would be
 * filed as though it were real.
 */
const SOURCE_LINE_SUFFIX = /:\d+$/;

export function surfaceForInlineIntent(
  url: string | undefined,
  flow: string | undefined,
  /** `file` or `file:line` for the element the verdict acted on, when it had one. */
  sourceLabel?: string,
): { route?: string; flow?: string; files?: string[] } | undefined {
  let route: string | undefined;
  if (url !== undefined) {
    try {
      const path = new URL(url).pathname;
      // A bare origin has no path worth filing under: `/` would put every record in one bucket,
      // which is the problem this exists to fix rather than a solution to it.
      if (path.length > 1) route = path;
    } catch {
      route = undefined;
    }
  }
  /*
   * The file, without its line.
   *
   * A record is about a FILE; the line is where one verdict happened to touch it, and keeping it
   * would make the same rule look like a different one every time the file was edited above it.
   */
  const file =
    sourceLabel === undefined || 0 === sourceLabel.length
      ? undefined
      : sourceLabel.replace(SOURCE_LINE_SUFFIX, '');
  if (route === undefined && flow === undefined && file === undefined) return undefined;
  return {
    ...(route === undefined ? {} : { route }),
    ...(flow === undefined ? {} : { flow }),
    ...(file === undefined ? {} : { files: [file] }),
  };
}

/**
 * The session's live URL, or undefined when no session can be named.
 *
 * `sessions.resolve` throws for every "cannot tell which tab" case, and none of them is a reason to
 * fail the caller's verdict — a missing surface costs a filing, not a result.
 */
function sessionUrl(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).url;
  } catch {
    return undefined;
  }
}

export async function linkInlineIntent(
  deps: ToolDeps,
  sessionId: string | undefined,
  intent: string | undefined,
  /** The predicate this verdict will evaluate, or undefined when it proves nothing (a bare settle). */
  binding: unknown,
): Promise<string | undefined> {
  if (intent === undefined || 0 === intent.trim().length) return undefined;
  try {
    const store = new IntentStore(deps.fs, sessionRoot(deps, sessionId), { now: deps.now });
    const existing = (await store.read()).find((row) => row.id === intent);
    const id = existing?.id ?? inlineIntentId(intent);
    // Declared WITHOUT a surface on purpose: see dischargeInlineIntent for why the route that
    // describes this record only exists after the action it is about.
    if (existing === undefined) await store.declare([{ id, statement: intent }]);
    if (binding !== undefined && existing?.binding === undefined) await store.bind(id, binding);
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Record that this verdict proved the intent. Call only for a verdict that actually proved something.
 *
 * The ledger's own rule does the rest: `dischargeIntent` refuses an intent with no binding, so an
 * intent declared inline on a wait that asserted no consequence stays open and honest instead of
 * collecting a proof nothing earned.
 */
export async function dischargeInlineIntent(
  deps: ToolDeps,
  sessionId: string | undefined,
  id: string | undefined,
  proof: { verdictId: string; grade: string; at: number },
  /** `file:line` of the element this verdict acted on, when there was one. */
  sourceLabel?: string,
): Promise<void> {
  if (id === undefined) return;
  try {
    const store = new IntentStore(deps.fs, sessionRoot(deps, sessionId), { now: deps.now });
    /*
     * File it HERE, not at declaration.
     *
     * The intent is declared before the action so a verdict can see it open, and at that instant the
     * agent is still on the page it is leaving — clicking through to /issues from / would have filed
     * the record under the page it left, or under nothing at all. The route that describes what the
     * intent is about is the one that exists once the consequence has landed.
     */
    const surface = surfaceForInlineIntent(sessionUrl(deps, sessionId), undefined, sourceLabel);
    if (surface !== undefined) await store.place(id, surface);
    await store.discharge(id, proof);
  } catch {
    // The verdict already stood. The proof is simply not recorded — see dischargeFlowIntent.
  }
}
