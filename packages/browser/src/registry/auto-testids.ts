/**
 * The testids the page is actually showing, read from the live DOM.
 *
 * `registerCapabilities({ testids: [...] })` used to be the only source, and `init` filled it by
 * grepping the source at install time. That list is a snapshot of the codebase on the day `init` ran:
 * it goes stale on the next commit that renames an element, it is empty for every app whose testids
 * arrive with a lazy route, and finishing it was homework handed to whoever ran the install.
 *
 * The attribute in the DOM is the same declaration, read fresh, so nothing has to be copied into a
 * config file to be true. Reticle's own presenter markup is excluded — advertising our own controls
 * as the app's testable surface would be the tool describing itself.
 */

const TESTID_ATTR = 'data-testid';
const TESTID_SELECTOR = `[${TESTID_ATTR}]`;

/**
 * Ceiling on the reported list.
 *
 * A virtualized 500-row grid stamps a testid per cell, and the capabilities payload rides in every
 * announce — an uncapped read turns one long table into a permanently expensive message. The cap is
 * on the REPORT, not on what can be driven: a testid past it is still findable by query.
 */
export const MAX_AUTO_TESTIDS = 200;

/** Reticle's own UI carries testids; they are not the host app's surface. */
const RETICLE_OWN_PREFIX = 'reticle-';

export function domTestids(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let nodes: ArrayLike<Element>;
  try {
    nodes = doc.querySelectorAll(TESTID_SELECTOR);
  } catch {
    return out; // a document that cannot be queried (detached, hostile) simply advertises nothing
  }
  for (let i = 0; i < nodes.length && out.length < MAX_AUTO_TESTIDS; i += 1) {
    const value = nodes[i]?.getAttribute(TESTID_ATTR);
    if (null === value || undefined === value) continue;
    const trimmed = value.trim();
    if (0 === trimmed.length || seen.has(trimmed)) continue;
    if (trimmed.startsWith(RETICLE_OWN_PREFIX)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
