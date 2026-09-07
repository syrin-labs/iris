import { asRecord } from './tools-helpers.js';

/** One candidate the browser returned for a target query. */
interface TargetCandidate {
  ref?: unknown;
  role?: unknown;
  name?: unknown;
  visible?: unknown;
}

/** What the resolution produced: a ref to act on, or the reason there isn't one. */
export type TargetResolution =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Turn a target QUERY into the single ref an action can be performed on.
 *
 * `act_and_wait` took only a `ref`, so every verification cost a `reticle_query` turn first just to
 * learn one string. The advertised tool surface is re-sent on every turn, so that extra turn was not
 * a small cost: measured on the wire, a two-turn verification spent 10,756 of its 11,235 tokens on
 * schema and 479 on the actual answers. Removing the turn removes half the schema bill.
 *
 * Ambiguity is an ERROR, never a pick. Choosing "the first match" would let a verification act on a
 * different element than the author meant and still report success, which is the false green this
 * product exists to prevent — and the failure is invisible, because the verdict describes the
 * element it DID act on. The message names the candidates so the caller can narrow rather than guess.
 *
 * Invisible matches are filtered before counting: a hidden duplicate is a common way for a
 * legitimately unambiguous query to look ambiguous, and refusing on it would push callers back to
 * the two-turn path for no gain.
 */
export function resolveTargetRef(candidates: readonly unknown[]): TargetResolution {
  const all = candidates.map((c) => asRecord(c) as TargetCandidate);
  const visible = all.filter((c) => c.visible !== false);
  const usable = visible.length > 0 ? visible : all;

  if (0 === usable.length) {
    return {
      kind: 'error',
      message:
        'target matched no element. Nothing was acted on and no verdict is possible — widen the ' +
        'query, or take a reticle_snapshot to see what is actually on the page.',
    };
  }
  if (usable.length > 1) {
    const named = usable
      .slice(0, 5)
      .map((c) => {
        const role = 'string' === typeof c.role ? c.role : '?';
        const name = 'string' === typeof c.name ? c.name : '';
        const ref = 'string' === typeof c.ref ? c.ref : '?';
        return name.length > 0 ? `${ref} (${role} "${name}")` : `${ref} (${role})`;
      })
      .join(', ');
    return {
      kind: 'error',
      message:
        `target matched ${String(usable.length)} elements and an action must not guess between ` +
        `them: ${named}. Narrow the query (add role/name/testid or a scope), or pass an explicit ` +
        '`ref` from reticle_query.',
    };
  }
  const only = usable[0];
  const ref = only === undefined ? undefined : only.ref;
  if ('string' !== typeof ref || 0 === ref.length) {
    return { kind: 'error', message: 'target matched an element with no usable ref.' };
  }
  return { kind: 'ref', ref };
}
