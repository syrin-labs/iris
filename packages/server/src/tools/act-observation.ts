/**
 * What to do when the observer left in the middle of an act.
 *
 * A full-document navigation — often the very thing the act CAUSED — tears the SDK down. The page
 * re-announces, and whatever this call still had in flight is gone. That is a fact about the
 * observer, never about the application, and the difference matters: every honest verdict this
 * engine can give depends on not converting "I stopped watching" into "your app is broken".
 *
 * Extracted from act-tools.ts, which had reached the file-size cap. It earns its own module because
 * it is one idea — follow the document that took over, and re-ask there — used from the two points
 * where observation can be lost: a write rejected at dispatch, and a wait cut off mid-predicate.
 */

import type { Session } from '../session/session.js';
import { awaitDocumentSuccessor, type SuccessorRegistry } from '../session/session-successor.js';
import type { EvalResult } from '../events/predicate-eval.js';

interface FollowSuccessor {
  sessions: SuccessorRegistry;
  session: Session;
  verdict: EvalResult;
  /** Total budget the CALLER granted, in ms. */
  timeout: number;
  /** `session.elapsed()` at the moment the predicate started. */
  predicateStarted: number;
  /** Re-ask the declared consequence on `next`, with whatever budget is left. */
  reevaluate: (next: Session, budgetMs: number) => Promise<EvalResult>;
}

interface FollowedOutcome {
  session: Session;
  verdict: EvalResult;
  /** True when the wait moved to a new document, so the caller must reset its event cursor. */
  followed: boolean;
}

/**
 * Follow the unique same-origin successor and re-ask there, or leave the verdict untouched.
 *
 * `navigate` already waits for the HELLO and returns the new id; this path used to grade
 * `observation_lost` and leave the agent holding a DEAD id, so the next assert failed even though
 * the new page had loaded perfectly. Two live tabs at that origin is still a guess, and
 * `awaitDocumentSuccessor` refuses to guess — a wrong follow drives somebody else's app.
 */
export async function followLostObservation(input: FollowSuccessor): Promise<FollowedOutcome> {
  const { sessions, session, verdict, timeout, predicateStarted, reevaluate } = input;
  if (true !== verdict.observationLost || 0 >= timeout)
    return { session, verdict, followed: false };

  const remaining = timeout - (session.elapsed() - predicateStarted);
  const next = remaining > 0 ? await awaitDocumentSuccessor(sessions, session, remaining) : null;
  if (null === next) return { session, verdict, followed: false };

  // Computed on the DEPARTED session, before the caller points at the successor: the new session's
  // elapsed() starts at 0 and would silently refund the whole budget the caller had already spent.
  const leftover = timeout - (session.elapsed() - predicateStarted);
  if (leftover <= 0) return { session: next, verdict, followed: true };
  return { session: next, verdict: await reevaluate(next, leftover), followed: true };
}
