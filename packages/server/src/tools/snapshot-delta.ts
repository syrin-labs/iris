/**
 * Server-side snapshot delta — return only what CHANGED since the agent's last look.
 *
 * Why (grounded): screenshot/Playwright-MCP agents accrue 60–80K tokens of stale accessibility-tree
 * data over a session and start hallucinating selectors that no longer exist. The agent-facing cost
 * is the MCP result it reads (not the internal WS payload), so computing the delta here — and
 * returning only added/removed lines — directly cuts the tokens the model spends AND removes the
 * stale full-tree that drives hallucination. Reuses the same normalize+diff the baseline layer uses,
 * so "what changed" means the same thing everywhere.
 *
 * Pure decision (`snapshotDelta`) + a small route-invalidated cache (`SnapshotCache`). A route change
 * invalidates the prior snapshot (a diff across pages would be meaningless), so the next snapshot
 * returns full — never a misleading cross-page delta.
 */

/**
 * Identity for comparison, ref for action.
 *
 * The delta path used `normalizeLines` from the baseline layer, which strips the ref marker on
 * purpose — a ref stored in a baseline would make every later diff noisy. Correct there, wrong here:
 * every delta line came back as `- button "Row actions"` with no ref, and acting needs a ref, so the
 * full snapshot had to be taken anyway. The diff call cost tokens and bought nothing. One helper, two
 * callers, opposite requirements — so this path keeps the ref-stripped line as the KEY and emits the
 * ORIGINAL line with its ref.
 *
 * Focus is stripped from the key too. It rides in the line as `[focused]`, alone or comma-joined with
 * other states, so a focus move used to surface as one line removed and its twin added — structural
 * change reported where nothing had been added at all. Focus is a property OF a line, so it gets its
 * own field. Only focus is exempt: `disabled` moving is a real change and must still show.
 */

/** The ref marker, as `formatLine` writes it. Bounded quantifier: `\s*` backtracks polynomially. */
const REF_MARKER = /\s?\(ref=e\d+\)/;

/** The state bracket — ` [disabled,checked,expanded,focused]` — and the one state that is not structural. */
const STATE_BRACKET = /\s\[([a-z,]+)\]$/;
const FOCUSED_STATE = 'focused';

/** True when this line carries focus. */
function isFocused(line: string): boolean {
  return true === STATE_BRACKET.exec(line)?.[1]?.split(',').includes(FOCUSED_STATE);
}

/** The same line with focus removed — and the bracket dropped when focus was all it held. */
function withoutFocus(line: string): string {
  const match = STATE_BRACKET.exec(line);
  const states = match?.[1];
  if (null === match || undefined === match || undefined === states) return line;
  const rest = states.split(',').filter((s) => s !== FOCUSED_STATE);
  const head = line.slice(0, match.index);
  return 0 === rest.length ? head : `${head} [${rest.join(',')}]`;
}

/** What makes two lines "the same element" for diffing: no ref, no focus, no surrounding space. */
function deltaKey(line: string): string {
  return withoutFocus(line.replace(REF_MARKER, '')).trim();
}

interface DeltaLine {
  key: string;
  /** The line as the agent will read it: ref intact, focus removed so it cannot read as a change. */
  text: string;
}

function deltaLines(tree: string): DeltaLine[] {
  return tree
    .split('\n')
    .map((line) => ({ key: deltaKey(line), text: withoutFocus(line).trim() }))
    .filter((line) => line.key.length > 0);
}

/**
 * Multiset diff on the key, emitting the original text.
 *
 * Multiset rather than set because duplicate labels are the norm — twelve identical `Row actions`
 * buttons — and the count is the only thing that says how many left. Emitting the ORIGINAL text is
 * what finally tells them apart: with refs, "which twelve" has an answer.
 */
/** Extract the ref marker value from a text line, or undefined if absent. */
function refOf(text: string): string | undefined {
  return REF_MARKER.exec(text)?.[0]?.trim();
}

/** Extract the role (first word after the bullet) from a snapshot line — the structural type that must match. */
function roleOf(text: string): string {
  return (
    text
      .trimStart()
      .replace(/^-\s*/, '')
      .split(/[\s"(]/)[0] ?? ''
  );
}

function diffKeyed(prev: DeltaLine[], next: DeltaLine[]): { added: string[]; removed: string[] } {
  const bucket = (lines: DeltaLine[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const line of lines) {
      const existing = map.get(line.key);
      if (existing === undefined) map.set(line.key, [line.text]);
      else existing.push(line.text);
    }
    return map;
  };
  const before = bucket(prev);
  const after = bucket(next);
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key) ?? [];
    const now = after.get(key) ?? [];
    // Pair the SAME REF first. Twelve identical `Row actions` buttons are one key, and the ref is the
    // only thing that says which of them left — an end-of-list surplus would name an arbitrary one.
    const survived = new Set(now);
    const wentOrChanged = was.filter((text) => !survived.has(text));
    const arrivedOrChanged = now.filter((text) => !new Set(was).has(text));
    // Whatever is left over on both sides is the SAME element with a re-minted ref (a re-render, or a
    // navigation that restarts the sequence). Pairing those off is what stops a ref change reading as
    // a removal plus an addition; only the count difference is a real structural change.
    const paired = Math.min(wentOrChanged.length, arrivedOrChanged.length);
    removed.push(...wentOrChanged.slice(paired));
    added.push(...arrivedOrChanged.slice(paired));
  }
  return { removed, added };
}

/**
 * Same ref AND same role in both added and removed = value change, not a structural
 * arrival/departure. Refs alone are not stable identities — they are re-minted on re-render — so a
 * removed button and an added textbox sharing a ref must stay in their respective lists.
 */
function extractChanged(
  added: string[],
  removed: string[],
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const addedByRef = new Map<string, { idx: number; text: string; role: string }>();
  for (const [i, text] of added.entries()) {
    const ref = refOf(text);
    if (ref !== undefined) addedByRef.set(ref, { idx: i, text, role: roleOf(text) });
  }
  const changedIndicesInAdded = new Set<number>();
  const changedIndicesInRemoved = new Set<number>();
  const changed: string[] = [];
  for (const [i, text] of removed.entries()) {
    const ref = refOf(text);
    if (ref === undefined) continue;
    const match = addedByRef.get(ref);
    if (match !== undefined && match.role === roleOf(text)) {
      changed.push(match.text);
      changedIndicesInAdded.add(match.idx);
      changedIndicesInRemoved.add(i);
      addedByRef.delete(ref);
    }
  }
  return {
    added: added.filter((_, i) => !changedIndicesInAdded.has(i)),
    removed: removed.filter((_, i) => !changedIndicesInRemoved.has(i)),
    changed,
  };
}

/**
 * Where focus sits now: the line to show, plus the identity to compare it BY.
 *
 * These have to be two different things. Comparing the rendered lines said focus had moved whenever
 * the focused element merely changed — typing into a focused textbox rewrites its `[value=...]`, so
 * `from` and `to` came back naming the same element with different text. Focus identity is the
 * ELEMENT, so the comparison is on the ref, and the line is only what gets displayed. Where there is
 * no ref to compare (a non-interactive line), the ref-stripped key stands in.
 *
 * Read from the raw tree so a line the diff filters out cannot silently swallow the focus report.
 */
function focusedLine(tree: string): { id: string; text: string } | undefined {
  const focused = tree.split('\n').find((line) => isFocused(line));
  if (focused === undefined) return undefined;
  const text = withoutFocus(focused).trim();
  return { id: REF_MARKER.exec(focused)?.[0]?.trim() ?? deltaKey(focused), text };
}

export const SnapshotDeltaMode = {
  FULL: 'full',
  DELTA: 'delta',
  UNCHANGED: 'unchanged',
} as const;
export type SnapshotDeltaMode = (typeof SnapshotDeltaMode)[keyof typeof SnapshotDeltaMode];

interface SnapshotDelta {
  added: string[];
  removed: string[];
  changed: string[];
  addedCount: number;
  removedCount: number;
}

/** Where focus moved, when it moved. Absent fields mean nothing held focus on that side. */
interface FocusChange {
  from?: string;
  to?: string;
}

type DeltaDecision =
  | { mode: typeof SnapshotDeltaMode.FULL }
  | { mode: typeof SnapshotDeltaMode.UNCHANGED; focusChanged?: FocusChange }
  | { mode: typeof SnapshotDeltaMode.DELTA; delta: SnapshotDelta; focusChanged?: FocusChange };

/** Pure: decide full vs delta vs unchanged given the previous tree (same route) and the next tree. */
export function snapshotDelta(prevTree: string | undefined, nextTree: string): DeltaDecision {
  if (prevTree === undefined) return { mode: SnapshotDeltaMode.FULL };
  const raw = diffKeyed(deltaLines(prevTree), deltaLines(nextTree));
  const { added, removed, changed } = extractChanged(raw.added, raw.removed);
  const before = focusedLine(prevTree);
  const now = focusedLine(nextTree);
  // Reported only on a MOVE. Repeating "focus is still here" every turn is the noise the delta exists
  // to remove, and an absent field is how the agent knows nothing happened.
  const focusChanged: FocusChange | undefined =
    before?.id === now?.id
      ? undefined
      : {
          ...(before === undefined ? {} : { from: before.text }),
          ...(now === undefined ? {} : { to: now.text }),
        };
  const moved = focusChanged === undefined ? {} : { focusChanged };
  if (0 === added.length && 0 === removed.length && 0 === changed.length) {
    return { mode: SnapshotDeltaMode.UNCHANGED, ...moved };
  }
  return {
    mode: SnapshotDeltaMode.DELTA,
    delta: {
      added,
      removed,
      changed,
      addedCount: added.length,
      removedCount: removed.length,
    },
    ...moved,
  };
}

const DEFAULT_MAX_ENTRIES = 50;

/** Per-(session,scope,mode) last-snapshot cache. Route-aware: a route change invalidates the entry. */
export class SnapshotCache {
  readonly #map = new Map<string, { route: string; tree: string }>();
  readonly #max: number;

  constructor(max: number = DEFAULT_MAX_ENTRIES) {
    this.#max = max;
  }

  /** True when an entry exists for this key (regardless of route match). */
  has(key: string): boolean {
    return this.#map.has(key);
  }

  /** Last tree for this key IF the route still matches; undefined when absent or route changed. */
  recall(key: string, route: string): string | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined || entry.route !== route) return undefined;
    // LRU touch: re-insert so a HOT key isn't evicted while colder, more-recently-added keys survive
    // (Map preserves insertion order; delete+set moves it to the most-recently-used end).
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.tree;
  }

  remember(key: string, route: string, tree: string): void {
    // Re-insert to move the key to the most-recently-used end (a plain set keeps its old position).
    this.#map.delete(key);
    if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { route, tree });
  }
}

/**
 * Joins the cache-key parts. NUL because `scope` is a caller-supplied selector that may contain any
 * printable character — a printable separator could be forged into a colliding key. Written as an
 * ESCAPE, never as a literal NUL byte: a raw one makes this file read as binary to grep/diff tooling,
 * which silently hid every symbol in it from repo-wide searches.
 */
const CACHE_KEY_SEPARATOR = '\u0000';

export function snapshotCacheKey(sessionId: string, scope: string, mode: string): string {
  return `${sessionId}${CACHE_KEY_SEPARATOR}${scope}${CACHE_KEY_SEPARATOR}${mode}`;
}

/** Said out loud when a diff was computed over a capped tree, so "unchanged" cannot mean "nothing happened". */
const CAPPED_DIFF_NOTE =
  'this diff covers only the first N nodes of the page (the snapshot hit its cap), so "unchanged" means "unchanged in the part that was captured" — narrow with `scope` to see the rest';

interface SnapshotDeltaOpts {
  sessionId: string;
  scope: string;
  mode: string;
  diff: boolean;
}

/**
 * Shape a raw snapshot result for the agent: when `diff` is requested and a same-route prior
 * snapshot exists, return only the delta (or `unchanged`) instead of the full tree. Always updates
 * the cache. Non-object/errorless results pass through. The cache is the only state; the decision is
 * the pure `snapshotDelta`.
 */
export function applySnapshotDelta(
  raw: unknown,
  opts: SnapshotDeltaOpts,
  cache: SnapshotCache,
): unknown {
  if (typeof raw !== 'object' || null === raw) return raw;
  const r = raw as Record<string, unknown>;
  // Only shape genuine snapshots (have a string tree). An error envelope passes through untouched.
  if (typeof r['tree'] !== 'string') return raw;
  const tree = r['tree'];
  const status =
    'object' === typeof r['status'] && r['status'] !== null
      ? (r['status'] as Record<string, unknown>)
      : {};
  const route = 'string' === typeof status['route'] ? status['route'] : '';
  const key = snapshotCacheKey(opts.sessionId, opts.scope, opts.mode);

  if (!opts.diff) {
    cache.remember(key, route, tree);
    return raw;
  }

  const prev = cache.recall(key, route);
  const hadEntry = cache.has(key);
  cache.remember(key, route, tree);
  const decision = snapshotDelta(prev, tree);
  if (decision.mode === SnapshotDeltaMode.FULL) {
    const reason = hadEntry ? 'route changed' : 'first snapshot for this route';
    return { ...(r as object), mode: SnapshotDeltaMode.FULL, reason };
  }
  // The walk stops at a node cap and returns a DOCUMENT-ORDER PREFIX, so two capped snapshots of a
  // large page are identical whenever the change happened past the cap — and "unchanged" is then a
  // statement about the cap, not about the page. Carried through on both branches: a delta computed
  // over a prefix is real but not exhaustive either.
  const capped = true === r['truncated'] ? { truncated: true, note: CAPPED_DIFF_NOTE } : {};
  // Spread onto BOTH branches. A value computed correctly and declared nowhere on the way out is the
  // defect shape that hit this release five separate times: nothing throws, no test reddens, the
  // field is simply absent forever.
  const moved = decision.focusChanged === undefined ? {} : { focusChanged: decision.focusChanged };
  if (decision.mode === SnapshotDeltaMode.UNCHANGED) {
    return { mode: SnapshotDeltaMode.UNCHANGED, status: r['status'], ...moved, ...capped };
  }
  const { changed, ...structuralDelta } = decision.delta;
  const changedField = changed.length > 0 ? { changed, changedCount: changed.length } : {};
  return {
    mode: SnapshotDeltaMode.DELTA,
    delta: structuralDelta,
    ...changedField,
    status: r['status'],
    ...moved,
    ...capped,
  };
}
