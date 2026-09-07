#!/usr/bin/env node
// Lossy-transform guard for the Reticle read path.
//
// THE INVARIANT
//
//   Any transform that can drop, truncate, or shape-coerce data on a path an agent reads must
//   report that it did, in a machine-readable way the consumer can detect.
//
// The consumer is an agent deciding whether a green verdict is trustworthy. A partial answer it
// cannot distinguish from a complete one is a false green — the failure this whole project exists to
// prevent. A note in a log, or a value quietly shortened with nothing to say so, is not a report.
//
// WHY A GUARD AND NOT DISCIPLINE
//
// The rule was broken three separate times, each found by hand and fixed in isolation: the ring
// buffer dropped events so an agent got a confident false negative; the offline queue dropped events
// during a bridge blip while the ledger still read clean; capDepth coerced a Map to `{}` with no
// marker, immediately upstream of the one function that gets this right. Three instances of one
// shape is a missing invariant, not three bugs.
//
// WHAT THIS CATCHES, AND WHAT IT HONESTLY DOES NOT
//
// Catches: a NEW export appearing in a read-path module without anybody classifying it, and a
// classified-lossy export with no conformance test naming it. That is the moment someone who has
// never heard of this rule is made to answer the question, which is the entire value.
//
// Does NOT catch: a newly-lossy BRANCH added inside a function already listed here. Nothing textual
// can. Stated so nobody mistakes a green guard for a proof.
//
// Usage:
//   node scripts/check-lossy-transforms.mjs            # check the real tree; exit 1 on drift
//   node scripts/check-lossy-transforms.mjs --self-test # prove the guard fails on a synthetic gap
//
// Wired into `pnpm lint`, so drift fails the build. See CONTRIBUTING.md ("Lossy transforms declare
// their loss") and packages/*/src/**/lossy-conformance.test.ts for the behavioural half.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * How a transform declares what it removed. Four legitimate styles, because the read path carries
 * four different kinds of payload and a report cannot always ride beside the value.
 */
export const Declaration = Object.freeze({
  /** A machine-readable field travelling BESIDE the value. The strongest form; prefer it. */
  REPORT: 'report',
  /** An unambiguous in-band sentinel the consumer can detect, where the value's shape must survive. */
  MARKER: 'marker',
  /** Announced on the event stream or a health surface rather than beside any one value. */
  SIGNAL: 'signal',
  /** Not lossy. Types, registration helpers, predicates. */
  NONE: 'none',
  /** KNOWN undeclared loss, accepted with a written reason. Every one of these is a real gap. */
  SILENT: 'silent',
});

const LOSSY = new Set([Declaration.REPORT, Declaration.MARKER, Declaration.SIGNAL]);

/**
 * The read path: the modules whose output an agent reads to reach a verdict, and the classification
 * of every export in them.
 *
 * Scope is deliberately the STATE/READ path rather than everything that can drop a byte. That is
 * where all three known instances landed and where a silent loss most directly produces a wrong
 * verdict. Snapshot/query truncation and the visual path are a second pass, not this one.
 *
 * To add a module here, list EVERY export. An unlisted export fails the guard, which is the point.
 */
export const READ_PATH = Object.freeze({
  'packages/browser/src/security/serialization.ts': {
    TruncationReport: [Declaration.NONE, 'the report type itself'],
    sanitizeWithReport: [
      Declaration.REPORT,
      'the reference implementation — returns { value, truncation? } so a caller cannot mistake a fraction for the whole',
    ],
    sanitizeForTransport: [
      Declaration.SILENT,
      'convenience wrapper that DISCARDS the report. Kept for callers whose payload is bounded by construction; anything on the read path must use sanitizeWithReport instead',
    ],
    safeStringify: [
      Declaration.SILENT,
      'wraps sanitizeForTransport and so inherits its dropped report, and additionally collapses a throwing value to "[UNSERIALIZABLE]". Log/diagnostic use only',
    ],
    isSensitiveKey: [
      Declaration.NONE,
      're-exported from @reticlehq/core — a predicate over a key name, reads and drops nothing',
    ],
    scrubKnownSecrets: [
      Declaration.MARKER,
      're-exported from @reticlehq/core — replaces a high-confidence secret shape in place with REDACTED_VALUE, so the returned text carries an in-band sentinel over any redacted span',
    ],
  },
  'packages/core/src/state-select.ts': {
    PathSelection: [Declaration.NONE, 'the selection result type'],
    selectPath: [
      Declaration.REPORT,
      'a miss returns { found:false, availableKeys } and, when that key list is a SAMPLE, totalKeys beside it',
    ],
    projectComponentState: [
      Declaration.REPORT,
      'drops React effect hooks (chained, null-filled fiber internals) from a component hook read and reports the drop as component.truncation = { droppedItems, note }; every state/memo/ref hook value passes through untouched',
    ],
    capDepth: [
      Declaration.MARKER,
      'collapses past the budget to a sized sentinel — "[Array(5)]", "{…3 keys}", "[Set(2)]", "{Map(3)}". In-band because the caller asked for a depth cap and the value shape has to survive it',
    ],
  },
  'packages/browser/src/registry/stores.ts': {
    StoreGetter: [Declaration.NONE, 'type'],
    StoreSubscribe: [Declaration.NONE, 'type'],
    StoreRegisteredListener: [Declaration.NONE, 'type'],
    StoreLike: [Declaration.NONE, 'type'],
    onStoreRegistered: [Declaration.NONE, 'registration, reads nothing'],
    registerStore: [Declaration.NONE, 'registration, reads nothing'],
    unregisterStore: [Declaration.NONE, 'registration, reads nothing'],
    storeNames: [Declaration.NONE, 'names only, never truncated'],
    sourceOwner: [Declaration.NONE, 'a registered name or undefined; reads no store state'],
    markAdapterSource: [Declaration.NONE, 'records what an adapter wraps; reads nothing'],
    subscribableStores: [Declaration.NONE, 'registry projection, never truncated'],
    readStoresRaw: [
      Declaration.NONE,
      'deliberately UNCAPPED — it exists so a scoped read selects before the caps apply',
    ],
    readStores: [
      Declaration.SILENT,
      "convenience wrapper that DROPS readStoresWithTruncation's report. Every read-path caller uses the reporting form",
    ],
    readStoresWithTruncation: [
      Declaration.REPORT,
      'returns { stores, truncation? } keyed by store name, so a 1,000-entity store that came back as 142 says so',
    ],
  },
  'packages/browser/src/transport/transport.ts': {
    CommandOutcome: [Declaration.NONE, 'type'],
    MAX_QUEUE: [Declaration.NONE, 'the bound itself, exported so tests overflow the real one'],
    RECONNECT_MAX_DELAY_MS: [
      Declaration.NONE,
      'a reconnect timing ceiling, not a transform — no agent-visible data passes through it',
    ],
    nextReconnectDelay: [
      Declaration.NONE,
      'pure arithmetic on a delay (double, then clamp); exported so the backoff POLICY is testable, since the scheduling itself runs on a timer bound before any fake clock',
    ],
    Transport: [
      Declaration.SIGNAL,
      'a full offline queue evicts its oldest events and then emits TRANSPORT_OVERFLOW { dropped } to the bridge, so the gap is declared on the stream it happened to',
    ],
  },
  'packages/server/src/events/ring-buffer.ts': {
    RingBuffer: [
      Declaration.SIGNAL,
      'eviction is counted and surfaced by bufferHealth() as { total, dropped }, which session health and act summaries read to mark a window truncated',
    ],
  },
  'packages/server/src/input/network-detail.ts': {
    NetworkDetail: [Declaration.NONE, 'the payload type'],
    ResponseLike: [Declaration.NONE, 'type: the Playwright surface the attachment reads'],
    PageLike: [Declaration.NONE, 'type: the Playwright surface the attachment reads'],
    buildNetworkDetail: [
      Declaration.REPORT,
      'bounds the request body it takes raw off the network stack and returns requestBodyTruncated beside it, so a capped payload cannot be read as a whole one; redaction inside that body and the headers replaces values in place with REDACTED_VALUE, an in-band marker',
    ],
    mergeNetworkDetail: [
      Declaration.REPORT,
      'the wire body is the one field that REPLACES the in-page one rather than filling a gap, so both caveats ride with it: requestBodyTruncated follows the body that won, and requestBodyDivergedFromPage states that the two disagreed',
    ],
    attachNetworkDetail: [
      Declaration.SILENT,
      'a response whose headers() rejects is dropped with nothing said. It rejects when the page or CDP session is closing, which is exactly when responses race teardown, and the alternative on the stdio start() path is an unhandled rejection that takes down the MCP server. A real gap: a drive that navigates away mid-flight loses those details and the window does not say so',
    ],
  },
  'packages/core/src/toon.ts': {
    ToonElement: [Declaration.NONE, 'type'],
    toToon: [
      Declaration.MARKER,
      'a container whose children are not expanded carries count=N on its own line, so a collapsed subtree states its size',
    ],
    resultToToon: [
      Declaration.MARKER,
      'delegates to toToon; non-element results pass through as JSON',
    ],
    isToonable: [Declaration.NONE, 'predicate'],
  },
});

/**
 * Where each lossy transform's loss is PROVEN — the behavioural half of the invariant.
 *
 * Two of these predate the registry. `Transport` and `RingBuffer` each already had a suite whose
 * whole subject was the declared gap, written when the drop was found by hand; pointing at them
 * beats copying them, and a registry that forced a duplicate would be teaching the wrong lesson. The
 * two `lossy-conformance` files cover the transforms that had no such suite. `serialization.test.ts`
 * is a third: its "scrubKnownSecrets" describe block already asserts REDACTED_VALUE replaces a
 * detected secret shape, so it is the existing fixture for that MARKER declaration, not a new one.
 */
export const CONFORMANCE_TESTS = Object.freeze([
  'packages/core/src/lossy-conformance.test.ts',
  'packages/browser/src/security/lossy-conformance.test.ts',
  'packages/browser/src/security/serialization.test.ts',
  'packages/browser/src/transport/transport.overflow-marker.test.ts',
  'packages/server/src/events/ring-buffer.test.ts',
  'packages/server/src/input/network-detail.lossy-conformance.test.ts',
]);

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const INLINE_EXPORT_PATTERN = new RegExp(
  `^export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+(${IDENTIFIER})`,
  'gm',
);
const DEFAULT_EXPORT_PATTERN = /^export\s+default\b/gm;
// Matches `export { a, b as c };` and, deliberately, `export { a, b as c } from '...'` the same way:
// a named re-export creates a binding under THIS module's name (`c`), which is exactly what the guard
// tracks. `export * from '...'` cannot be resolved this way — see hasWildcardReexport below.
// The `type` modifier is skipped in both positions — `export type { A }` and `export { type A }` are
// the same binding to this guard, and a type-only export the pattern refuses to match is a name that
// disappears from the drift check entirely, which is the one outcome a guard must never have.
const EXPORT_LIST_PATTERN = /^export\s*(?:type\s+)?\{([\s\S]*?)\}/gm;
const EXPORT_LIST_ENTRY_PATTERN = new RegExp(
  `^(?:type\\s+)?(${IDENTIFIER})(?:\\s+as\\s+(${IDENTIFIER}))?$`,
);

/** Every top-level export name in a TypeScript source, read as text. */
export function exportedNames(source) {
  const names = [];

  // Each pattern is a shared `g`-flag RegExp reused across calls, so `lastIndex` must be reset before
  // every scan — otherwise a call on a later (or shorter) source silently resumes mid-string or finds
  // nothing at all.
  INLINE_EXPORT_PATTERN.lastIndex = 0;
  let match;
  while ((match = INLINE_EXPORT_PATTERN.exec(source)) !== null) names.push(match[1]);

  // The external name of a default export is literally `default`, per the ES module spec
  // (`import { default as x }` is equivalent to `import x`) — there is no better name to report,
  // named or anonymous.
  DEFAULT_EXPORT_PATTERN.lastIndex = 0;
  while ((match = DEFAULT_EXPORT_PATTERN.exec(source)) !== null) names.push('default');

  EXPORT_LIST_PATTERN.lastIndex = 0;
  while ((match = EXPORT_LIST_PATTERN.exec(source)) !== null) {
    for (const rawEntry of match[1].split(',')) {
      const entry = rawEntry.trim();
      if (entry.length === 0) continue;
      const entryMatch = entry.match(EXPORT_LIST_ENTRY_PATTERN);
      if (entryMatch === null) continue;
      const [, localName, alias] = entryMatch;
      names.push(alias ?? localName);
    }
  }

  return names;
}

// `export * from '...'` re-exports every name from another module. Nothing textual can resolve those
// names without reading and evaluating that module too, so the guard does not try — it fails loudly
// instead, per the issue's "resolve it or fail loudly, but do not let it pass silently" choice.
const WILDCARD_REEXPORT_PATTERN = /^export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+['"]/m;

/** Whether a source contains a wildcard re-export the guard cannot resolve textually. */
export function hasWildcardReexport(source) {
  return WILDCARD_REEXPORT_PATTERN.test(source);
}

/**
 * Compare the registry against the tree.
 * @returns {Array<{file: string, name?: string, reason: string}>}
 */
export function findDrift(readPath, readSource, conformanceSources) {
  const problems = [];
  const testText = conformanceSources.join('\n');

  for (const [file, entries] of Object.entries(readPath)) {
    const source = readSource(file);
    if (source === null) {
      problems.push({ file, reason: 'listed in the registry but not found on disk' });
      continue;
    }
    if (hasWildcardReexport(source)) {
      problems.push({
        file,
        reason:
          "contains a wildcard re-export (export * from '...'); the re-exported names cannot be " +
          'resolved by reading this file alone — replace it with explicit named exports so each one ' +
          'can be classified, or remove it from the read path',
      });
    }
    const actual = exportedNames(source);
    for (const name of actual) {
      if (!Object.hasOwn(entries, name)) {
        problems.push({
          file,
          name,
          reason:
            'exported from a read-path module but not classified. Add it to READ_PATH: does it drop, truncate or shape-coerce anything an agent reads, and if so how does it say so?',
        });
      }
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (!actual.includes(name)) {
        problems.push({ file, name, reason: 'classified in the registry but no longer exported' });
        continue;
      }
      const [declaration, note] = entry;
      if (!Object.values(Declaration).includes(declaration)) {
        problems.push({ file, name, reason: `unknown declaration style "${declaration}"` });
      }
      if (typeof note !== 'string' || note.length === 0) {
        problems.push({ file, name, reason: 'classified with no reason written down' });
      }
      // A lossy transform nobody tests is a registry entry, not an invariant.
      if (LOSSY.has(declaration) && !testText.includes(name)) {
        problems.push({
          file,
          name,
          reason: `declared ${declaration} but named in no conformance test — add a fixture that guarantees loss and assert the loss is declared`,
        });
      }
    }
  }
  return problems;
}

function readFromDisk(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** In-memory proof that the guard catches real drift — an unproven guard is its own false green. */
function selfTest() {
  const MISSING_FILE = Symbol('missing-file');
  const WILDCARD_REEXPORT = Symbol('wildcard-reexport');
  const registry = {
    'fake/mod.ts': {
      declared: [Declaration.REPORT, 'returns a report'],
      ghost: [Declaration.NONE, 'no longer exported'],
      noReason: [Declaration.MARKER, ''],
      badStyle: ['whispered', 'not a declaration style'],
      untested: [Declaration.MARKER, 'lossy but named in no test'],
    },
    'fake/missing.ts': { anything: [Declaration.NONE, 'file is not on disk'] },
  };
  const source = [
    'export function declared() {}',
    'export function noReason() {}',
    'export function badStyle() {}',
    'export function untested() {}',
    'export function unclassified() {}',
    'function reexportedLocal() {}',
    'export { reexportedLocal };',
    'export { declared as declaredAlias };',
    'interface TypeOnlyList {}',
    'interface TypeOnlyEntry {}',
    'export type { TypeOnlyList };',
    'export { type TypeOnlyEntry };',
    'export default function () {}',
    "export * from './helpers.js';",
  ].join('\n');
  const problems = findDrift(registry, (file) => (file === 'fake/mod.ts' ? source : null), [
    'expect(declared()).toBeDefined(); noReason(); badStyle();',
  ]);
  const got = problems.map((p) => `${p.name ?? '-'}:${p.reason.slice(0, 24)}`);
  const expected = [
    ['unclassified', 'a new export must be classified'],
    ['ghost', 'a removed export must be flagged'],
    ['noReason', 'a classification with no reason must be flagged'],
    ['badStyle', 'an unknown declaration style must be flagged'],
    ['untested', 'a lossy export with no conformance test must be flagged'],
    [MISSING_FILE, 'a registry file missing from disk must be flagged'],
    ['reexportedLocal', 'an export list entry (export { x }) must be classified'],
    [
      'declaredAlias',
      'an export list alias (export { x as y }) must be classified by its exported name',
    ],
    ['TypeOnlyList', 'a type-only export list (export type { x }) must be classified'],
    ['TypeOnlyEntry', 'a type-only list entry (export { type x }) must be classified'],
    ['default', 'export default must be classified'],
    [WILDCARD_REEXPORT, 'a wildcard re-export (export * from) must fail loudly, not pass silently'],
  ];
  const missing = expected.filter(([marker]) => {
    if (marker === MISSING_FILE) return !problems.some((p) => p.file === 'fake/missing.ts');
    if (marker === WILDCARD_REEXPORT) {
      return !problems.some(
        (p) => p.file === 'fake/mod.ts' && p.name === undefined && p.reason.includes('wildcard'),
      );
    }
    return !problems.some((p) => p.name === marker);
  });
  if (missing.length > 0) {
    console.error('self-test FAILED — guard missed:', missing.map(([, why]) => why).join('; '));
    process.exit(1);
  }
  console.log(
    'lossy-transform guard self-test passed (%d synthetic problems caught: %s)',
    problems.length,
    got.length,
  );
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const conformance = CONFORMANCE_TESTS.map((file) => readFromDisk(file) ?? '');
  const missingSuite = CONFORMANCE_TESTS.filter((file) => readFromDisk(file) === null);
  const problems = findDrift(READ_PATH, readFromDisk, conformance);
  for (const file of missingSuite) {
    problems.push({
      file,
      reason: 'conformance suite listed in CONFORMANCE_TESTS but not on disk',
    });
  }
  if (problems.length > 0) {
    console.error('Lossy-transform registry drift:\n');
    for (const p of problems) {
      console.error(`  ✗ ${p.file}${p.name === undefined ? '' : ` → ${p.name}`}\n    ${p.reason}`);
    }
    console.error(
      `\n${problems.length} problem(s). The rule: a transform that drops, truncates or shape-coerces` +
        '\ndata an agent reads must report that it did. See scripts/check-lossy-transforms.mjs.',
    );
    process.exit(1);
  }
  const counted = Object.values(READ_PATH).reduce((n, e) => n + Object.keys(e).length, 0);
  console.log(
    'Lossy transforms OK (%d exports classified across %d read-path modules).',
    counted,
    Object.keys(READ_PATH).length,
  );
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
