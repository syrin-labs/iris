/**
 * Refuse an unevaluable predicate BEFORE the action fires.
 *
 * `reticle_act_and_wait` dispatches, then evaluates `until`. So a locator the browser cannot use —
 * one naming fields the element resolver drops — was detected only after the click had landed and
 * the page had already moved. The result came back `verified:"unknown", inconclusive`, which reads
 * as "Reticle could not tell what happened".
 *
 * That is not true, and it is the wrong direction of error for a verification tool. Reticle could
 * tell perfectly well; what it could not do was evaluate a predicate the CALLER wrote badly. Charging
 * that to the app teaches the reader to distrust a verdict that was never about the app, and the
 * action has already been spent by the time they learn.
 *
 * The refusal shape already exists elsewhere and is exactly right: "target matched no element.
 * Nothing was acted on and no verdict is possible… This is a miss, not a Reticle defect: there is
 * nothing to report." This is that, applied one step earlier.
 */
import type { ElementQuery } from '@reticlehq/core';
import { residualQueryChecks } from './predicate-schema.js';

/** Composite predicates nest; the unusable one can be at any depth. */
const NESTED_KEYS = ['predicates', 'predicate'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => 'object' === typeof v && null !== v;

/** Every element query in a predicate tree, in the order a reader would meet them. */
function elementQueries(predicate: unknown, found: ElementQuery[] = []): ElementQuery[] {
  if (!isRecord(predicate)) return found;
  if (isRecord(predicate['query'])) found.push(predicate['query']);
  for (const key of NESTED_KEYS) {
    const nested = predicate[key];
    if (Array.isArray(nested)) for (const child of nested) elementQueries(child, found);
    else if (isRecord(nested)) elementQueries(nested, found);
  }
  return found;
}

/**
 * The reason this predicate cannot be evaluated, or undefined when it can.
 *
 * Only checks what is knowable WITHOUT the page — a locator that names fields the resolver drops is
 * wrong whatever the DOM contains, which is what makes it safe to refuse before acting. Anything
 * that depends on what is actually rendered is still decided after the action, where it belongs.
 */
export function unevaluablePredicateReason(predicate: unknown): string | undefined {
  for (const query of elementQueries(predicate)) {
    const residual = residualQueryChecks(query);
    if (0 === residual.unusable.length) continue;
    return (
      `the element locator ignores ${residual.unusable.map((f) => `\`${f}\``).join(', ')} ` +
      `in ${JSON.stringify(query)} — it resolves by the first of by+value, component/source, role, ` +
      'text, label, placeholder, testid, alt that is present, and nothing here can check the rest. ' +
      'Assert them one locator at a time, or move the extra field into the locator. ' +
      'Nothing was acted on: this predicate could never have been evaluated, so refusing it costs ' +
      'you nothing and spending the action on it would have cost you the verdict.'
    );
  }
  return undefined;
}
