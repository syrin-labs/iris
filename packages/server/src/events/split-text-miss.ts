/**
 * Turning "no element matched {text: …}" into something an agent can act on, when the string IS here.
 *
 * `by: text` matches an element's own text nodes. A label rendered across several children —
 * `v-html`, one `<span>` per word, a highlighted substring — is on the page and matches nothing, and
 * the verdict is byte-identical to the one for an element that never rendered.
 *
 * That equivalence is the expensive part. Reported from the field: `act_and_wait` returned
 * `effect.appeared` containing `"Move to Reticle Repro Folder"`, the `until` predicate in the SAME
 * call searched for that string and failed, and the drive ended in a bug report against an app that
 * had rendered correctly. `appeared` concatenates an added subtree while `text` reads direct text
 * only, so the channel an agent is most likely to copy from produces the one locator this query
 * cannot resolve.
 *
 * Naming the container ends it in one step: `ref` is a locator, and a scoped text predicate with
 * `self: true` checks the container's combined subtree text. The recovery is a predicate the agent
 * can paste rather than another guess, and it is serialized as JSON so the schema test can parse it.
 */

import { PredicateKind } from '@reticlehq/core';

/** Enough of the label to recognise it; the message is read in a tool result, not a log. */
const MAX_TEXT = 60;

/** What the container is, in the fewest words that still identify it on the page. */
function nameOf(owner: SplitTextOwner): string {
  const name = owner.name !== undefined && owner.name.length > 0 ? owner.name : undefined;
  const role = owner.role !== undefined && owner.role.length > 0 ? owner.role : 'element';
  return name === undefined ? role : `${role} '${truncate(name)}'`;
}

function truncate(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** The container descriptor the browser attaches to a missed text query. */
interface SplitTextOwner {
  ref?: string;
  role?: string;
  name?: string;
}

/**
 * The "…but it IS here, split across children" clause, or undefined when there is nothing to say.
 *
 * Undefined — not a vaguer sentence — when the browser found no container: an ordinary miss keeps the
 * short message it already had. A clause that fires on every failure stops carrying information.
 */
export function describeSplitTextMiss(
  owner: SplitTextOwner | undefined,
  searchedText?: string,
): string | undefined {
  if (owner === undefined) return undefined;
  const where = nameOf(owner);
  const scope = owner.ref !== undefined && owner.ref.length > 0 ? owner.ref : undefined;
  const recovery =
    scope === undefined || searchedText === undefined
      ? 'scope to that container and match it as a whole'
      : `retry as ${JSON.stringify({
          kind: PredicateKind.TEXT,
          contains: searchedText,
          scope,
          self: true,
        })}`;
  return `that text IS on the page, split across the children of ${where} — no single element's own text carries it, so no text query can match it; ${recovery}`;
}
