import {
  DATA_RETICLE_SOURCE_ATTR,
  ElementState,
  QueryBy,
  REDACTED_VALUE,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type PresentRegion,
  type QueryEmptyHint,
  type QueryResult,
  TRANSPORT_LIMITS,
} from '@reticlehq/core';
import { isFrame, isHtmlElement, isInput, isSelect, isTextArea } from './realm.js';
import { capturedRootOf } from './shadow-registry.js';
import {
  getAccessibleName,
  getRole,
  describe,
  getStates,
  isInViewport,
  isVisible,
} from './a11y.js';
import { isIgnored } from './dom-ignore.js';
import { isSensitiveKey } from '../security/serialization.js';
import { declaredTestids } from '../registry/capabilities.js';
import { identifyComponent } from '../registry/adapters.js';
import { refs } from './refs.js';

const TESTID_ATTR = 'data-testid';
const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;
const MAX_PRESENT_TESTIDS = 12;
/** Bound the fiber-walk fallback so a component-name query can't scan an unbounded DOM. */
const MAX_COMPONENT_CANDIDATES = 2000;
/** Likely-actionable elements considered when resolving a component anchor without a source stamp. */
const COMPONENT_CANDIDATE_SELECTOR = `[${SOURCE_ATTR}], [${TESTID_ATTR}], button, a, input, select, textarea, [role]`;

/**
 * Every candidate a semantic locator may match: the container ITSELF first, then its descendants.
 *
 * The container's own text, role or name was matched by every engine this replaces - a scoped
 * `{ text: "Saved" }` against `<div id="status">Saved</div>` found #status itself - so dropping
 * the root here would turn exactly those scoped queries into silent zero-match answers: the worst
 * failure mode, indistinguishable from the element being absent. `self: true` stays the way to
 * reach an UNLABELLED root (it skips the predicate entirely); this keeps a root that DOES satisfy
 * the predicate findable without a second spelling.
 */
function elementsUnder(container: HTMLElement): HTMLElement[] {
  // Embedded roots include ShadowRoots, which are DocumentFragments: they have no attributes or
  // tag to match on, so only a true Element root joins the candidates.
  const self = Node.ELEMENT_NODE === container.nodeType ? [container] : [];
  return [...self, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
}

/**
 * Match user-visible prose the way the public query API has always promised: trim and collapse
 * whitespace, compare canonically equivalent Unicode in NFC, and keep fuzzy text queries
 * case-insensitive. Attribute identifiers such as testid stay exact and do not pass through here.
 */
function normaliseVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().normalize('NFC');
}

function fuzzyVisibleText(actual: string, expected: string): boolean {
  return normaliseVisibleText(actual)
    .toLowerCase()
    .includes(normaliseVisibleText(expected).toLowerCase());
}

function exactVisibleText(actual: string, expected: string): boolean {
  return normaliseVisibleText(actual) === normaliseVisibleText(expected);
}

function directText(el: Element): string {
  if (isInput(el)) {
    const type = el.type.toLowerCase();
    if ('submit' === type || 'button' === type || 'reset' === type) return el.value;
  }
  const tag = el.tagName.toLowerCase();
  if ('script' === tag || 'style' === tag) return '';
  return Array.from(el.childNodes)
    .filter((node) => Node.TEXT_NODE === node.nodeType)
    .map((node) => node.textContent ?? '')
    .join('');
}

/**
 * Elements whose accessible name comes from author-supplied naming rather than free subtree
 * content - the set `by: label` addresses.
 *
 * Form controls plus anything explicitly named with aria-label/aria-labelledby covers the common
 * case. `button`, `meter`, `output` and `progress` are included because their names arrive on
 * attributes (`value`) or from their caption, which is precisely what a label query is looking
 * for; leaving them out would silently drop buttons from label searches.
 */
function semanticNameTarget(el: Element): boolean {
  if (isInput(el) || isTextArea(el) || isSelect(el)) return true;
  const tag = el.tagName.toLowerCase();
  return (
    'button' === tag ||
    'meter' === tag ||
    'output' === tag ||
    'progress' === tag ||
    el.hasAttribute('aria-label') ||
    el.hasAttribute('aria-labelledby')
  );
}

/**
 * Resolve a scope to its container. A container of `null` means a scope was GIVEN but resolved to
 * nothing (unmounted, or a selector that matches no element) - the caller must NOT fall back to the
 * whole page, or a scoped query silently widens into a phantom match. `scope === undefined` (no scope)
 * legitimately searches the body.
 */
function resolveContainer(scope: string | undefined): {
  container: HTMLElement | null;
  scopeMissing: boolean;
} {
  if (scope === undefined) return { container: document.body, scopeMissing: false };
  const byRef = refs.resolve(scope);
  if (isHtmlElement(byRef)) return { container: byRef, scopeMissing: false };
  try {
    const found = document.querySelector(scope);
    if (isHtmlElement(found)) return { container: found, scopeMissing: false };
  } catch {
    // invalid selector - treat as a missing scope, never a whole-page search
  }
  return { container: null, scopeMissing: true };
}

/**
 * Resolve an element by its SOURCE location - the precise, granular auto-anchor. The babel plugin
 * stamps `data-reticle-source="file:line:column"` on host elements, so a line-level starts-with match
 * pins the exact JSX element with a single fast attribute selector (no fiber walk). Column is
 * ignored so a small column drift doesn't unbind the anchor.
 */
function findBySource(
  container: HTMLElement,
  source: { file: string; line: number },
): HTMLElement[] {
  const prefix = `${source.file}:${source.line}:`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    return Array.from(container.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}^="${prefix}"]`));
  } catch {
    return [];
  }
}

/**
 * Resolve by component display name when no source stamp is available: scan a bounded set of
 * likely-actionable elements and keep those whose NEAREST enclosing component (via the registered
 * framework adapter) matches. Coarser than source (one component renders many hosts) - used as a
 * fallback / for frameworks without a source plugin.
 */
function findByComponentName(container: HTMLElement, component: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let scanned = 0;
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(COMPONENT_CANDIDATE_SELECTOR),
  )) {
    if (scanned >= MAX_COMPONENT_CANDIDATES) break;
    scanned += 1;
    const info = identifyComponent(el);
    if (info !== null && info.componentStack[0] === component) out.push(el);
  }
  return out;
}

/** Auto-anchor resolution: source (precise) first, then component name (coarse fallback). */
function findByComponent(container: HTMLElement, query: ElementQuery): HTMLElement[] {
  if (query.source !== undefined) {
    const bySource = findBySource(container, query.source);
    if (bySource.length > 0) return bySource;
  }
  if (query.component !== undefined && query.component.length > 0) {
    return findByComponentName(container, query.component);
  }
  return [];
}

/**
 * Role + name, matched with the same local accessibility engine used to describe results.
 *
 * This intentionally makes Reticle's reported role and name the source of truth. If an element is
 * described as `textbox "Search User"`, the resolver must accept that exact pair, not a different
 * role or name from a second library.
 */
function queryByRoleAndName(
  container: HTMLElement,
  role: string,
  name: string | undefined,
): HTMLElement[] {
  return elementsUnder(container).filter(
    (el) =>
      getRole(el) === role && (name === undefined || exactVisibleText(getAccessibleName(el), name)),
  );
}

function queryByText(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => fuzzyVisibleText(directText(el), value));
}

function queryByLabel(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter(
    (el) => semanticNameTarget(el) && fuzzyVisibleText(getAccessibleName(el), value),
  );
}

function queryByPlaceholder(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => {
    const placeholder = el.getAttribute('placeholder');
    return placeholder !== null && fuzzyVisibleText(placeholder, value);
  });
}

function queryByTestId(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => el.getAttribute(TESTID_ATTR) === value);
}

function queryByAlt(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => {
    const alt = el.getAttribute('alt');
    return alt !== null && fuzzyVisibleText(alt, value);
  });
}

/** Run the appropriate local query against ONE root, light DOM or a shadow root. */
function findIn(container: HTMLElement, query: ElementQuery): HTMLElement[] {
  const by = query.by;
  const value = query.value;

  // Explicit `by`+`value` form.
  if (by !== undefined && value !== undefined) {
    switch (by) {
      case QueryBy.ROLE:
        return queryByRoleAndName(container, value, query.name);
      case QueryBy.TEXT:
        return queryByText(container, value);
      case QueryBy.LABEL:
        return queryByLabel(container, value);
      case QueryBy.PLACEHOLDER:
        return queryByPlaceholder(container, value);
      case QueryBy.TESTID:
        return queryByTestId(container, value);
      case QueryBy.ALT:
        return queryByAlt(container, value);
      case QueryBy.COMPONENT:
        // value is the component name;.source (if present) still takes precedence inside.
        return findByComponent(container, { ...query, component: query.component ?? value });
      default:
        // THROW, never `return []`. An unsupported strategy answering "no matches" is
        // indistinguishable from the element genuinely being absent, so `by:'css'` - the first thing
        // anyone arriving from Playwright reaches for - reported a page with a <body> as empty. The
        // server now rejects unknown strategies at the schema; this is the same guarantee for every
        // other path in (replay, reticle_run, an internal caller), because a false negative invented
        // by the tool is the exact failure this product exists to prevent.
        throw new Error(
          `unsupported query strategy '${String(by)}' - use one of: ${Object.values(QueryBy).join(', ')}`,
        );
    }
  }

  // Auto-anchor (component / source) - checked before the role/text fields so a query carrying
  // both a component anchor and an incidental role resolves by the more durable anchor.
  if (query.component !== undefined || query.source !== undefined) {
    return findByComponent(container, query);
  }

  // Structured form (role+name, or any single field). Same round-trip guarantee as the by+value
  // spelling above - the two forms must not disagree about what is findable.
  if (query.role !== undefined) {
    return queryByRoleAndName(container, query.role, query.name);
  }
  if (query.text !== undefined) return queryByText(container, query.text);
  if (query.label !== undefined) return queryByLabel(container, query.label);
  if (query.placeholder !== undefined) return queryByPlaceholder(container, query.placeholder);
  if (query.testid !== undefined) return queryByTestId(container, query.testid);
  if (query.alt !== undefined) return queryByAlt(container, query.alt);
  return [];
}

/**
 * Every open shadow root at or beneath `root`, in document order.
 *
 * A closed root is deliberately unreachable - `element.shadowRoot` is null by design, and the SDK
 * reports that as a blind spot rather than pretending to see through it.
 */
/**
 * A same-origin `<iframe>`'s body, or null when the document is unreachable.
 *
 * Cross-origin access THROWS in some engines and yields null in others, so both are handled - and
 * both mean the same thing here: not ours to read. That case is not a silent skip, it is reported
 * separately as a declared blind spot.
 */
function readableFrameBody(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.body ?? null;
  } catch {
    return null;
  }
}

/** How deep to follow frames-inside-frames before giving up. Real consoles nest one, maybe two. */
const FRAME_DEPTH_MAX = 3;

/**
 * Every root beneath the scope that the page can read but `querySelectorAll` will not reach:
 * open shadow roots, and the documents of SAME-ORIGIN iframes.
 *
 * The iframe half was measured missing: a same-origin frame whose text the page could read straight
 * off `contentDocument` returned zero matches from `query`, and coverage said nothing about it - the
 * worst combination, an absent-element answer for content that is right there. Cross-origin frames
 * are a genuinely different case and stay unread; they are declared instead.
 */
function embeddedRootsUnder(root: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  const walk = (node: ParentNode, depth: number): void => {
    for (const el of node.querySelectorAll<HTMLElement>('*')) {
      const shadow = el.shadowRoot ?? capturedRootOf(el);
      if (shadow !== null) {
        // A ShadowRoot is a DocumentFragment. The local query helpers only call querySelectorAll on
        // the container, and every call site only reads from it.
        found.push(shadow as unknown as HTMLElement);
        walk(shadow, depth); // nested web components
        continue;
      }
      if (depth >= FRAME_DEPTH_MAX) continue;
      if (!isFrame(el)) continue;
      const body = readableFrameBody(el);
      if (null === body) continue; // cross-origin - declared, not searched
      found.push(body);
      walk(body, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * NOTE ON COST. The walk above is a `querySelectorAll('*')` over the container, and `reticle_query` is
 * a hot-path tool, so every query on every app pays it - including the overwhelming majority that hold
 * no web components.
 *
 * A cache invalidated by a MutationObserver was written and then REMOVED, because it is not sound:
 * `attachShadow` on an element that is already in the document mutates only the shadow tree, which an
 * observer watching documentElement's subtree never sees. The cached "no shadow roots here" would
 * persist and the content would be silently missed - a false negative indistinguishable from a genuinely
 * absent element, which is the exact bug the piercing was added to fix.
 *
 * Correctness wins until there is a measurement saying the walk actually matters. The allocation is
 * avoided (iterate the live NodeList rather than copying it); the traversal itself stays.
 */
/**
 * Run the query against the light DOM AND every open shadow root beneath the scope.
 *
 * A single querySelectorAll call only walks the root it starts from, so a control inside a web
 * component returned zero matches on a completely healthy page - a miss indistinguishable from a
 * genuinely absent element. The snapshot has always pierced open roots; this makes `query` agree
 * with it.
 */
function findCandidates(query: ElementQuery): { candidates: HTMLElement[]; scopeMissing: boolean } {
  const { container, scopeMissing } = resolveContainer(query.scope);
  // A given-but-missing scope searches NOTHING - never the whole page. The empty result plus the
  // scopeMissing flag is what keeps "gone scope" distinct from "absent element".
  if (null === container) return { candidates: [], scopeMissing: true };
  // `self: true` asks for the container ITSELF, which every other path excludes by construction.
  // A layout element with no role, name, testid or own text is unreachable by any semantic locator,
  // and it is routinely the element carrying the handler - "click the empty space in this row" is a
  // real user action that was simply not expressible. Requires a scope: without one there is no root
  // to return, and answering `document.body` would be a wrong answer wearing the shape of one.
  if (true === query.self) {
    if (query.scope === undefined) return { candidates: [], scopeMissing };
    return { candidates: isIgnored(container) ? [] : [container], scopeMissing };
  }
  const seen = new Set<HTMLElement>();
  const out: HTMLElement[] = [];
  const collect = (els: HTMLElement[]): void => {
    for (const el of els) {
      if (seen.has(el)) continue; // reachable from both host and root - count once
      // Reticle's OWN UI is not part of the app under test. `snapshot` has always excluded it; query
      // did not, so the presenter panel and the annotator answered `by: role` like app controls -
      // measured on a real merchant dashboard, 7 of the 40 buttons an agent could see were ours
      // ("Pause", "End", "Chat", "Export"). Two of those
      // share a NAME with a real control on that page, so an agent resolving "Export" could drive the
      // observer instead of the app and then reason about the result. Filtered here, at the one
      // collection point, so every entry path (by role/text/testid, shadow roots, scoped) is covered.
      if (isIgnored(el)) continue;
      seen.add(el);
      out.push(el);
    }
  };
  collect(findIn(container, query));
  for (const embedded of embeddedRootsUnder(container)) collect(findIn(embedded, query));
  return { candidates: out, scopeMissing };
}

/** Longest attribute value returned; one enormous href must not blow the response budget. */
export const ATTR_VALUE_MAX = 512;
/** Most attributes projected per element - a guard against a caller asking for everything. */
const ATTR_KEYS_MAX = 12;

/**
 * Read the requested attributes off an element.
 *
 * Absent attributes are OMITTED rather than returned empty, so "not present" and "present but blank"
 * stay distinguishable. Credential-bearing names are redacted with the same rule the network and
 * storage paths use - a projection API must not become an exfiltration path.
 */
function projectAttrs(el: Element, keys: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of keys.slice(0, ATTR_KEYS_MAX)) {
    const raw = el.getAttribute(key);
    if (null === raw) continue;
    out[key] = isSensitiveKey(key) ? REDACTED_VALUE : raw.slice(0, ATTR_VALUE_MAX);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function inState(el: Element, state: ElementState, memo?: Map<Element, boolean>): boolean {
  // inViewport is computed on demand rather than listed in getStates, so it stays assertable without
  // adding a state to every element in every snapshot (it would bloat the wire and churn every
  // describe). The predicate path is the only consumer that needs it. (#398)
  if (ElementState.IN_VIEWPORT === state) return isInViewport(el, memo);
  return getStates(el, isVisible(el, memo)).includes(state);
}

/**
 * How many matches are DESCRIBED, however many are found.
 *
 * describe() is the expensive part of a query: it resolves the accessible name and forces a style
 * computation for every ancestor to decide visibility. Describing every match on a page with
 * thousands of them freezes the main thread for seconds - and then the wire discards all but the
 * first `MAX_COLLECTION_ITEMS` anyway, so the work past that point was never observable by anyone.
 * Matching one to the other means the cost of a broad query is bounded by the transport rather than
 * by the size of the page.
 */
const MAX_DESCRIBED = TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS;

/**
 * Match an element predicate against the live DOM.
 *
 * `count` is every match; `elements` is the described prefix. Keeping those separate is what lets
 * "how many?" stay exact while the answer stays affordable.
 */
export function matchQuery(
  query: ElementQuery,
  state?: ElementState,
  limit: number = MAX_DESCRIBED,
): MatchResult {
  // NO blanket try/catch here. It used to turn ANY exception during candidate-finding into
  // `elements = []`, which is the same lie as the `default` arm above: a query that could not run
  // reported that the element is not on the page. The one failure it was plausibly guarding -
  // a scope selector that matches nothing - is already handled explicitly and distinctly, as
  // `scopeMissing`, so what remained was a net that could only convert real faults into false
  // negatives.
  const found = findCandidates(query);
  const elements: HTMLElement[] = found.candidates;
  const scopeMissing = found.scopeMissing;
  // One visibility cache for the whole (synchronous) query pass. isVisible is an O(depth) forced-style
  // walk; the state filter runs it over EVERY candidate (the count must be exact) - on a match-heavy
  // page (e.g. a 3k-row grid) that is tens of thousands of getComputedStyle calls on the host's main
  // thread. The memo makes each element's ancestors resolve once, then short-circuit for every sibling.
  const visMemo = new Map<Element, boolean>();
  const filtered =
    state === undefined ? elements : elements.filter((el) => inState(el, state, visMemo));
  const attrs = query.attrs;
  const described = filtered.slice(0, Math.max(0, Math.min(limit, MAX_DESCRIBED)));
  const descriptors: ElementDescriptor[] = described.map((el) => {
    const base = describe(el, visMemo);
    if (attrs === undefined || 0 === attrs.length) return base;
    const projected = projectAttrs(el, attrs);
    return projected === undefined ? base : { ...base, attrs: projected };
  });
  return {
    matched: filtered.length > 0,
    count: filtered.length,
    elements: descriptors,
    ...(scopeMissing ? { scopeMissing: true } : {}),
    // On a MISS, carry the same diagnosis `runQuery` has always returned. MATCH is the command every
    // PREDICATE uses, so without this a failed assertion was a dead end ("no element matched") while
    // the identical failure through reticle_query listed the testids that ARE present. Computed only
    // when there is nothing to report, so the hot path pays nothing.
    ...(0 === filtered.length ? { hint: buildEmptyHint(query) } : {}),
  };
}

/** Resolve `aria-labelledby` (one or more element IDs) to the referenced elements' text - a bare ID is
 * not a human-readable name. Undefined when unset or nothing resolves. */
function resolveLabelledBy(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby');
  if (null === ids) return undefined;
  const text = ids
    .split(/\s+/)
    .map((id) =>
      id.length > 0 ? (el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '') : '',
    )
    .filter((t) => t.length > 0)
    .join(' ');
  return text.length > 0 ? text : undefined;
}

/** Structural clusters of the page - the successor to the raw testid list in zero-match hints. */
function buildPresentRegions(query: ElementQuery): PresentRegion[] {
  // For the diagnostic hint we WANT the page's orientation even when the scope is gone, so fall back
  // to the body here (the match path above already reported scopeMissing, so this can't mask it).
  const container = resolveContainer(query.scope).container ?? document.body;
  const regions: PresentRegion[] = [];
  const CONTAINER_ROLES = [
    'list',
    'listbox',
    'grid',
    'table',
    'tree',
    'treegrid',
    'dialog',
    'alertdialog',
    'navigation',
    'main',
    'banner',
    'form',
    'search',
    'menu',
    'menubar',
    'tablist',
  ] as const;
  for (const role of CONTAINER_ROLES) {
    const containers = queryByRoleAndName(container, role, undefined);
    for (const el of containers) {
      const name =
        el.getAttribute('aria-label') ??
        resolveLabelledBy(el) ?? // aria-labelledby is an element ID - resolve it to the referenced TEXT
        el.getAttribute('data-testid') ??
        undefined;
      const children = el.querySelectorAll('[role]');
      const sample: string[] = [];
      for (const child of Array.from(children)) {
        if (sample.length >= 3) break;
        const childRole = child.getAttribute('role');
        const childName =
          child.getAttribute('aria-label') ??
          child.getAttribute('data-testid') ??
          child.textContent?.trim().slice(0, 40) ??
          '';
        if (childRole !== null && childName.length > 0) {
          sample.push(`${childRole}[${childName}]`);
        }
      }
      const region: PresentRegion = { role, childCount: children.length, sample };
      if (name !== undefined && name.length > 0) region.name = name;
      regions.push(region);
      if (regions.length >= 10) return regions;
    }
  }
  return regions;
}

/**
 * The tightest single element whose SUBTREE text carries `wanted`, when no element's OWN text does.
 *
 * `by: text` matches an element's direct text nodes (`directText`), so a label rendered across
 * several child nodes — `v-html`, an inline `<span>` per word, a highlighted substring — exists on
 * the page and matches nothing. The two channels disagree by construction: `act_and_wait` reports
 * `appeared` by concatenating an added subtree, so the string an agent is most likely to copy into
 * its next predicate is exactly the shape this query cannot find.
 *
 * That failure is indistinguishable from the element being absent, which is the expensive half: the
 * agent reads "no element matched", concludes the app did not render, and reports a bug against
 * correct code.
 *
 * Returns the DEEPEST container rather than the first, because every ancestor up to `<body>` also
 * contains the string and naming `<body>` is not a locator. The deepest one is the tightest scope
 * that still holds the whole string, which is the one worth pasting back.
 */
function splitTextOwner(container: HTMLElement, wanted: string): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestDepth = -1;
  for (const el of elementsUnder(container)) {
    if (isIgnored(el)) continue; // never point an agent at Reticle's own UI
    if (!fuzzyVisibleText(el.textContent ?? '', wanted)) continue;
    let depth = 0;
    for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) depth++;
    if (depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
  }
  return best;
}

/** The text this query searched for, in either spelling, or undefined when it searched by something else. */
function wantedTextOf(query: ElementQuery): string | undefined {
  if (query.text !== undefined) return query.text;
  return QueryBy.TEXT === query.by ? query.value : undefined;
}

/** Diagnostic hint for a zero-match query: what testids ARE present in the searched scope. */
function buildEmptyHint(query: ElementQuery): QueryEmptyHint {
  const container = resolveContainer(query.scope).container ?? document.body;
  const all = container.querySelectorAll(`[${TESTID_ATTR}]`);
  const present: string[] = [];
  for (const el of Array.from(all)) {
    if (isIgnored(el)) continue; // the "what IS here" hint must not advertise Reticle's own UI either
    const id = el.getAttribute(TESTID_ATTR);
    if (id !== null && id.length > 0 && !present.includes(id)) {
      present.push(id);
      if (present.length >= MAX_PRESENT_TESTIDS) break;
    }
  }
  // DECLARED, not observed: see declaredTestids. Every present testid is also an observed one, so
  // the merged list would make this flag true for any page that has a testid at all.
  const registered = declaredTestids();
  const knownEmptyState = present.some((id) => registered.includes(id));
  const route = `${location.pathname}${location.search}`;
  const hint: QueryEmptyHint = {
    route,
    presentTestids: present,
    presentRegions: buildPresentRegions(query),
    knownEmptyState,
  };
  // Only for a text search, and only when the string IS here — otherwise this is an ordinary miss
  // and the extra clause would lengthen every failure to say nothing.
  const wanted = wantedTextOf(query);
  if (wanted !== undefined) {
    const owner = splitTextOwner(container, wanted);
    if (owner !== undefined) hint.splitText = describe(owner);
  }
  return hint;
}

/**
 * Resolve a query to descriptors for the `query` MCP tool.
 *
 * `count` is carried through deliberately: the server reports match totals from it rather than from
 * the array, because the array is capped in transit. Dropping it here - which this function used to
 * do - silently put the server back to counting survivors and calling that the answer.
 */
export function runQuery(query: ElementQuery, limit?: number): QueryResult {
  const result = matchQuery(query, undefined, limit);
  const scopeFields = true === result.scopeMissing ? { scopeMissing: true as const } : {};
  if (0 === result.elements.length) {
    return {
      elements: result.elements,
      count: result.count,
      hint: buildEmptyHint(query),
      ...scopeFields,
    };
  }
  return { elements: result.elements, count: result.count, ...scopeFields };
}
