/**
 * Self-instrumentation — the most agent-native item. When capability gaps exist (a flow can only assert
 * presence because no signal fires, an unregistered store, a missing testid), the layer emits ready-to-
 * apply instrumentation proposals as concrete diffs, so the AGENT closes the gap and the app's
 * observability compounds run over run — instead of a human being a prerequisite. Deterministic mapping
 * from a located gap to the code to insert; pure and testable. Result-enrichment wiring is a later step.
 *
 * Kinds come from `@reticlehq/core`. A second enum here is how `reticle_domain` used to say
 * `missing-signal` while honesty said `no-signal-on-mutation` for the same absence.
 */
import { InstrumentationGapKind } from '@reticlehq/core';

/** The three core kinds a located proposal can close. Other kinds are verdict-side, not insert-side. */
type LocatableGapKind =
  | typeof InstrumentationGapKind.NO_SIGNAL_ON_MUTATION
  | typeof InstrumentationGapKind.NO_STORE_REGISTERED
  | typeof InstrumentationGapKind.MISSING_TESTID;

export interface LocatedGap {
  kind: LocatableGapKind;
  file: string;
  line: number;
  /** The name to instrument with — a signal name, store name, or testid. */
  name: string;
  /** Why this gap matters (e.g. "checkout flow asserts presence only"). */
  context?: string;
}

interface InstrumentationProposal {
  file: string;
  line: number;
  /** The code to insert. */
  insert: string;
  rationale: string;
}

/** PascalCase a store name for a `useX.getState` hint (cart → Cart). */
function pascal(name: string): string {
  return 0 === name.length ? name : name[0]?.toUpperCase() + name.slice(1);
}

function insertFor(gap: LocatedGap): string {
  switch (gap.kind) {
    case InstrumentationGapKind.NO_SIGNAL_ON_MUTATION:
      return `reticle.signal('${gap.name}');`;
    case InstrumentationGapKind.NO_STORE_REGISTERED:
      return `registerStore('${gap.name}', () => use${pascal(gap.name)}.getState());`;
    case InstrumentationGapKind.MISSING_TESTID:
      return `data-testid="${gap.name}"`;
  }
}

function rationaleFor(gap: LocatedGap): string {
  let base: string;
  switch (gap.kind) {
    case InstrumentationGapKind.NO_SIGNAL_ON_MUTATION:
      base = `emit a consequence signal so verification proves the outcome, not just presence`;
      break;
    case InstrumentationGapKind.NO_STORE_REGISTERED:
      base = `register the store so state assertions can read the source of truth`;
      break;
    case InstrumentationGapKind.MISSING_TESTID:
      base = `add a stable testid so the anchor survives refactors`;
      break;
  }
  return undefined === gap.context ? base : `${base} — ${gap.context}`;
}

/** Turn located capability gaps into ready-to-apply instrumentation proposals. Deterministic. */
export function proposeInstrumentation(gaps: readonly LocatedGap[]): InstrumentationProposal[] {
  return gaps.map((gap) => ({
    file: gap.file,
    line: gap.line,
    insert: insertFor(gap),
    rationale: rationaleFor(gap),
  }));
}
