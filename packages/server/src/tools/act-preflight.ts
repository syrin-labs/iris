/**
 * Everything refused BEFORE the action window opens.
 *
 * Both checks here share one property, and it is the reason they belong together: each is decidable
 * without touching the page, and each would otherwise be discovered only after the click had landed
 * — when the action is spent, the page has moved, and the honest answer has already been lost.
 *
 * Refusing early is not a convenience. `reticle_act_and_wait` promises a verdict, and a verdict that
 * blames the app for the caller's own mistake is the most damaging thing a verification tool can
 * produce: it sends somebody to fix code that is not broken. "Nothing was acted on" is a far better
 * outcome than "unknown".
 */
import { SessionReplacedError } from '../session/pending-commands.js';
import { assertNativeInputSupported } from './act-danger.js';
import { unevaluablePredicateReason } from '../events/predicate-precheck.js';

/**
 * Refuse a sequence whose steps cannot be addressed.
 *
 * `steps` is a bare array of objects, so a step with neither `ref` nor `target` used to travel on
 * and dispatch as `ref: ''`. The browser then threw `ref '' no longer resolves to an element` —
 * a stale-ref diagnosis for a missing locator — and the caller went looking for a re-render.
 *
 * `target` is the same locator `reticle_act` / `reticle_act_and_wait` take; the handler resolves it
 * with `resolveActTarget` before dispatch. This check only asks that every step names one of the
 * two, and it runs before the first step, so a typo in step three cannot leave one and two applied.
 */
/**
 * Keys an agent reaches for when it means "and prove this happened".
 *
 * A sub-step reads `ref`/`target`/`action`/`args` and nothing else, and the schema is a permissive
 * record, so any of these was accepted and dropped. `until` is the likeliest of them by a distance:
 * it is what act_and_wait — the tool immediately next to this one — calls its assertion.
 *
 * Silently ignoring one manufactures a false green. A sequence carrying an impossible `until` came
 * back `completed: 1` with no error and nothing said about the predicate, which reads as the
 * consequence having held. act_sequence cannot grade one; refusing and naming the tool that can is
 * the same answer given to an unsupported native click, and for the same reason.
 */
const CONSEQUENCE_KEYS = ['until', 'expect', 'assert', 'waitFor'] as const;

export function assertSequenceSteps(steps: readonly unknown[]): void {
  if (0 === steps.length) {
    throw new Error(
      'reticle_act_sequence was given no steps. Pass steps: [{ ref, action, args? }] or [{ target, action, args? }] — nothing was acted on.',
    );
  }
  steps.forEach((raw, i) => {
    const step = 'object' === typeof raw && null !== raw ? (raw as Record<string, unknown>) : {};
    const claimed = CONSEQUENCE_KEYS.find((k) => step[k] !== undefined);
    if (claimed !== undefined) {
      throw new Error(
        `step ${String(i)} carries \`${claimed}\`, and reticle_act_sequence cannot grade it. ` +
          'Sub-steps are dispatched, never asserted — the key would be dropped and the sequence ' +
          'would report success having checked nothing. Drive the steps here, then prove the ' +
          'consequence with reticle_act_and_wait on the LAST action (its `until` is graded), or ' +
          'with reticle_assert after this call. Nothing was acted on.',
      );
    }
    if ('string' === typeof step['ref'] && step['ref'].length > 0) return;
    if (step['target'] !== undefined) return;
    throw new Error(
      `step ${String(i)} has no \`ref\` or \`target\`. ` +
        'Sequence steps take `ref` (from reticle_query/reticle_snapshot) or `target` ' +
        '(e.g. { testid } or { label }), the same locator reticle_act accepts. ' +
        'Nothing was acted on — the whole sequence is refused so a bad step cannot leave the earlier ones half-applied.',
    );
  });
}

/**
 * Throws if this call cannot honestly be driven. Call it after the args are parsed and before the
 * first dispatch — anything that depends on what is actually rendered belongs after the action.
 */
export function preflightAct(actArgs: Record<string, unknown>, until: unknown): void {
  // This path cannot honour a native-input request, and taking the argument and ignoring it told
  // the agent its trusted click had happened. See act-danger.
  assertNativeInputSupported(actArgs);
  const unevaluable = unevaluablePredicateReason(until);
  if (unevaluable !== undefined) throw new Error(unevaluable);
}

/**
 * Dispatch a write, or report that its outcome went unobserved.
 *
 * Returns null — never throws — when the transport was displaced by a newer connection claiming the
 * same id. That happens on any full-document navigation the act itself causes: the page unloads,
 * re-announces, and the write in flight is rejected by the handle that just died.
 *
 * The write is deliberately NOT re-sent. Re-asking a READ on the successor is free; re-sending a
 * WRITE is not, because nothing can prove the first one did not reach the page — and a duplicated
 * click on a button that charges a card is a far worse outcome than a verdict of "I could not see".
 * Every other failure propagates unchanged: only a replacement is an observation problem, and
 * treating a timeout or a refusal as one would launder a real failure into a shrug.
 */
export async function dispatchAct<T>(send: () => Promise<T>): Promise<T | null> {
  try {
    return await send();
  } catch (error: unknown) {
    if (error instanceof SessionReplacedError) return null;
    throw error;
  }
}
