import {
  ElementQuerySchema,
  ElementState,
  PredicateKind,
  QueryBy,
  type ElementDescriptor,
  type ElementQuery,
} from '@reticlehq/core';
import { z } from 'zod';

export type Predicate =
  | {
      kind: typeof PredicateKind.ELEMENT;
      query: ElementQuery;
      state?: ElementState;
      absent?: boolean;
    }
  | {
      kind: typeof PredicateKind.TEXT;
      contains: string;
      visible?: boolean;
      absent?: boolean;
      /**
       * Restrict the match to a subtree, as a CSS selector or a ref — the same field, and the same
       * meaning, as `scope` on an element query.
       *
       * Without it the match is page-wide, and a word that appears both in a background tab label
       * and in the dialog that just opened satisfies the predicate BEFORE the action runs, so
       * `act_and_wait` reports `already_true` for an action that did exactly the right thing.
       */
      scope?: string;
      /** Match the scope root itself and check its combined subtree text. Requires `scope`. */
      self?: boolean;
    }
  | {
      kind: typeof PredicateKind.NET;
      method?: string;
      urlContains?: string;
      status?: number;
      /** Did the call succeed? The honest field for IPC, which has no status code. */
      ok?: boolean;
      since?: number;
      count?: number;
      /** A substring the RESPONSE body must contain — what the server answered, not what was sent. */
      bodyContains?: string;
    }
  | { kind: typeof PredicateKind.ROUTE; pathname?: string; contains?: string; since?: number }
  | {
      kind: typeof PredicateKind.CONSOLE;
      level?: string;
      /**
       * A substring the captured message must contain. With `absent: true` this flips the meaning
       * from "no console entries at all" to "THIS message did not appear" — the assertion people
       * actually write regression checks for (deprecation warnings, no-op handler notices).
       */
      contains?: string;
      absent?: boolean;
      since?: number;
    }
  | {
      kind: typeof PredicateKind.ANIMATION;
      name?: string;
      target?: string;
      completed?: boolean;
      since?: number;
    }
  | {
      kind: typeof PredicateKind.SIGNAL;
      name?: string;
      dataMatches?: Record<string, unknown>;
      /**
       * Exact number of matching signals in the window — the same cardinality assertion `net`
       * carries, on the channel the app itself speaks. Omit for presence (≥1).
       */
      count?: number;
      since?: number;
    }
  | { kind: typeof PredicateKind.STATE; store?: string; path: string; equals?: unknown }
  | { kind: typeof PredicateKind.SETTLED; quietMs?: number }
  | { kind: typeof PredicateKind.ALL_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.ANY_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.NOT; predicate: Predicate };

/**
 * Spellings an agent plausibly reaches for, mapped to the real field.
 *
 * `route` spells its field `pathname` while `state`, in the same union, spells its `path`. Every one
 * of these was silently DROPPED before, and because these kinds have all-optional fields, dropping
 * the only key supplied left a predicate that asserts nothing and passes on anything.
 */
const PREDICATE_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `text`/`value` on a `text` predicate: the kind is called "text", so `text:` is the first thing
  // anyone writes for it, and `value` follows from the element query's own `value` field. Both were
  // hard rejections, and a rejected predicate produces NO verdict at all — the drive ends with
  // nothing rather than with a failure, which is the worst outcome of the three.
  [PredicateKind.TEXT]: { text: 'contains', value: 'contains' },
  // `urlContains`/`url` reported from the field: an agent that had just written
  // `net { urlContains }` applied the same word to `route`, which spells it `contains`, and got
  // `unrecognized_keys` with no list of what would have worked. The parallel it assumed is a fair
  // one — route's `contains` matches the WHOLE route (path + query + fragment), so "the URL
  // contains this" is precisely what it does — and asserting a redirect after login is the single
  // most common thing an agent reaches for here.
  [PredicateKind.ROUTE]: { path: 'pathname', urlContains: 'contains', url: 'contains' },
  [PredicateKind.NET]: { url: 'urlContains' },
  // `textContains` on a `console` predicate: the reporter who hit the missing matcher reached for
  // it first, by analogy with `net { urlContains }` — and that parallel is exactly right, since
  // both mean "this entry must contain this substring". Accepted as an alias for `contains`.
  [PredicateKind.CONSOLE]: { textContains: 'contains' },
  [PredicateKind.SIGNAL]: { data: 'dataMatches' },
  // `of` on a composite: it reads naturally, several assertion libraries spell it that way, and it has
  // no other meaning here. Observed twice in one drive on a real app, and each rejection cost a round
  // trip AND produced no verdict — a composite is what an agent reaches for precisely when it has two
  // things to prove at once, so failing it is expensive at the worst moment.
  [PredicateKind.ALL_OF]: { of: 'predicates' },
  [PredicateKind.ANY_OF]: { of: 'predicates' },
  // `of` on `not` for the same reason it is accepted on the composites above — an agent that learned
  // the spelling one line earlier applies it to the third composite, and `not` was the one that
  // rejected it. The refusal did name `predicate`, but naming a field still costs the round trip
  // that produced no verdict, and the guess is unambiguous: `not` has exactly one child.
  [PredicateKind.NOT]: { of: 'predicate' },
};

/**
 * The word half the assertion world spells `kind`.
 *
 * A discriminated union rejects `{ type: "text", ... }` with "Invalid discriminator value" on a field
 * the caller never wrote, so the reply reads as being about `kind` — which is absent — and never
 * says the word `type`. Observed on a live drive as the first rung of a ladder: one field name
 * learned per rejected call, each costing a verdict. No predicate kind declares a `type` field, so
 * lifting it is unambiguous, and an explicit `kind` still wins.
 */
const KIND_SPELLING = 'type';

/**
 * Element-query fields an agent writes FLAT on an `element` predicate instead of nested under
 * `query`. `reticle_query` takes exactly these at the top level, so an agent that has just located
 * something writes the same words again when it asserts on it — and got `query: Required` plus an
 * `unknown field` list for its trouble. Lifting them is unambiguous: they have no other meaning on
 * this kind.
 */
const ELEMENT_QUERY_FIELDS = [
  'by',
  'value',
  'role',
  'name',
  'text',
  'label',
  'placeholder',
  'testid',
  'alt',
  'component',
] as const;

/**
 * The locator fields the browser actually CONSUMES for a given query — mirrors the precedence in
 * `findIn` (packages/browser/src/dom/query.ts).
 *
 * An element query is not a conjunction. It is a first-match dispatch: `by`+`value` wins, then the
 * component/source anchor, then `role` (which alone also consumes `name`), then the first of
 * text/label/placeholder/testid/alt that is present. Every OTHER field the caller wrote is dropped on
 * the floor, silently, and the match reported as if the whole query had been honoured.
 *
 * Duplicated here on purpose. The alternative is to send the question to the browser, and the browser
 * cannot answer it: by the time a match comes back, the fields it ignored are indistinguishable from
 * the fields it used.
 */
function usedQueryFields(query: ElementQuery): ReadonlySet<string> {
  const used = new Set<string>();
  // The browser's `self` branch checks subtree text when supplied, but skips every other locator.
  // Mark only text as consumed so role/name/etc. remain residual checks on the returned descriptor.
  if (true === query.self) return query.text === undefined ? used : used.add('text');
  if (query.by !== undefined && query.value !== undefined) {
    used.add('by').add('value');
    if (QueryBy.ROLE === query.by) used.add('name');
    if (QueryBy.COMPONENT === query.by) used.add('component');
    return used;
  }
  if (query.component !== undefined || query.source !== undefined) return used.add('component');
  if (query.role !== undefined) return used.add('role').add('name');
  for (const field of ['text', 'label', 'placeholder', 'testid', 'alt'] as const) {
    if (query[field] !== undefined) return used.add(field);
  }
  return used;
}

/**
 * How a dropped field is checked back on the server, against the descriptor the match returned.
 *
 * `value` is the field this exists for: `{ role: "textbox", name: "GST amount", value: "274.58" }`
 * read as a locator has no `by`, so the value half was discarded and the predicate collapsed to "a
 * textbox named GST amount exists" — trivially true against an EMPTY field. Comparison is TRIMMED and
 * exact: an input's value is a value, not prose, and a trailing space in either the app or the
 * predicate is not a finding anybody wants. `""` asserts the field is empty, which describe() reports
 * by omitting the field entirely.
 *
 * `role`/`name`/`value` compare against exactly what `reticle_query` REPORTS, so the words an agent
 * copies out of a query result are the words that match here. `text` is a substring match, matching
 * Testing Library's `exact: false`, and falls back to the name because describe() omits `text` when it
 * equals the accessible name.
 */
const RESIDUAL_CHECKS: Readonly<
  Record<string, (element: ElementDescriptor, want: string) => boolean>
> = {
  value: (element, want) => (element.value ?? '').trim() === want.trim(),
  role: (element, want) => element.role === want,
  name: (element, want) => element.name.trim() === want.trim(),
  text: (element, want) => (element.text ?? element.name).includes(want),
};

interface ResidualQueryChecks {
  /** Dropped fields this side CAN check, as [field, wanted value] pairs. */
  checks: [string, string][];
  /** Dropped fields with no descriptor to check them against — refuse rather than ignore. */
  unusable: string[];
}

/**
 * Split a query's dropped fields into the ones the server can still enforce and the ones it cannot.
 *
 * The alternative — refuse every dropped field — breaks calls that work today and that our own
 * cheatsheet advertises (`{ role: "button", text: "Save" }`), and breaks them into no verdict at all.
 * Enforcing what we can and refusing only the rest keeps those calls working AS WRITTEN, which is the
 * outcome the caller was already assuming.
 */
export function residualQueryChecks(query: ElementQuery): ResidualQueryChecks {
  const used = usedQueryFields(query);
  const checks: [string, string][] = [];
  const unusable: string[] = [];
  for (const field of ELEMENT_QUERY_FIELDS) {
    const want = query[field];
    if (want === undefined || used.has(field)) continue;
    if ('string' === typeof want && RESIDUAL_CHECKS[field] !== undefined)
      checks.push([field, want]);
    else unusable.push(field);
  }
  return { checks, unusable };
}

/** Does this element satisfy every field the locator dropped? */
export function satisfiesResiduals(
  element: ElementDescriptor,
  checks: readonly [string, string][],
): boolean {
  return checks.every(([field, want]) => true === RESIDUAL_CHECKS[field]?.(element, want));
}

/** How the element's own reading of a dropped field should be REPORTED back on a failure. */
export function describeResidual(element: ElementDescriptor, field: string): string {
  const reading =
    'value' === field
      ? (element.value ?? '')
      : 'text' === field
        ? (element.text ?? element.name)
        : 'role' === field
          ? element.role
          : element.name;
  return `${element.role} "${element.name}" ${field}=${JSON.stringify(reading)}`;
}

/** `type` read as the discriminator when — and only when — `kind` is absent. */
function renameKindSpelling(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj['kind'] !== undefined || 'string' !== typeof obj[KIND_SPELLING]) return obj;
  const out: Record<string, unknown> = { ...obj, kind: obj[KIND_SPELLING] };
  delete out[KIND_SPELLING];
  return out;
}

/** Rename known aliases before parse; an explicit canonical key always wins. */
function applyPredicateAliases(input: unknown): unknown {
  if (typeof input !== 'object' || null === input || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  const obj = renameKindSpelling(given);
  const kind = 'string' === typeof obj['kind'] ? obj['kind'] : '';
  const aliases = PREDICATE_ALIASES[kind];
  let out = obj;
  if (aliases !== undefined) {
    out = { ...obj };
    for (const [from, to] of Object.entries(aliases)) {
      if (out[from] === undefined) continue;
      if (out[to] === undefined) out[to] = out[from];
      delete out[from];
    }
  }
  return PredicateKind.ELEMENT === kind ? liftElementQuery(out) : out;
}

/**
 * Fold flat query fields into `query`. An explicit `query` wins outright — a caller that supplied
 * both told us which one it meant, and merging the two would invent a locator neither side wrote.
 */
function liftElementQuery(obj: Record<string, unknown>): Record<string, unknown> {
  const loose = ELEMENT_QUERY_FIELDS.filter((field) => obj[field] !== undefined);
  if (0 === loose.length) return obj;
  const out = { ...obj };
  const query: Record<string, unknown> = {};
  for (const field of loose) {
    query[field] = out[field];
    delete out[field];
  }
  if (out['query'] === undefined) out['query'] = query;
  return out;
}

/**
 * Strict on every branch. A key that is nobody's spelling is now a schema error naming it, instead of
 * a stripped field and a green — see predicate-strict.test.ts for the MCP session that found this.
 *
 * Built on demand rather than at module scope: the `allOf`/`anyOf`/`not` branches reference
 * `PredicateSchema` itself, which does not exist yet while this module is initialising. Calling it
 * after init is what makes the union introspectable — see `predicateFieldsFor`.
 */
function predicateUnion() {
  return z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal(PredicateKind.ELEMENT),
        query: ElementQuerySchema,
        state: z.nativeEnum(ElementState).optional(),
        absent: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.TEXT),
        contains: z.string(),
        visible: z.boolean().optional(),
        absent: z.boolean().optional(),
        scope: z.string().optional(),
        self: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.NET),
        method: z.string().optional(),
        urlContains: z.string().optional(),
        status: z.number().optional(),
        ok: z.boolean().optional(),
        since: z.number().optional(),
        count: z.number().int().nonnegative().optional(),
        /**
         * A substring the call's RESPONSE body must contain - what the server answered.
         *
         * The only channel that can catch a UI echoing its own input instead of the server's answer.
         * Reported from a real payments UI: a refund posted `{"amount":"1187.01"}`, the server read it
         * as paise and answered 200 with `{"refunded":11.87}`, and the page displayed the number the
         * user had typed. Request fired, exactly once, status 200, console clean, page settled — every
         * assertable channel green on a hundred-fold wrong refund, so the verdict was `yes`.
         *
         * A substring rather than a JSON path, deliberately: `"refunded":11.87` is the whole assertion
         * for the money case, it needs no schema for the body, and it works the same on JSON, form
         * encoding and plain text. A path-and-equals form can be added later if a real case needs one;
         * this is the shape that turns "a blob I read" into a verdict.
         *
         * Requires body capture (`reticle({ captureNetworkBodies: true })`), and says so when the body
         * was never recorded rather than reporting an ordinary mismatch.
         */
        bodyContains: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.ROUTE),
        pathname: z.string().optional(),
        contains: z.string().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.CONSOLE),
        level: z.string().optional(),
        contains: z.string().min(1).optional(),
        absent: z.boolean().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.ANIMATION),
        name: z.string().optional(),
        target: z.string().optional(),
        completed: z.boolean().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.SIGNAL),
        name: z.string().optional(),
        dataMatches: z.record(z.unknown()).optional(),
        /**
         * Exact number of matching signals since the action — presence becomes cardinality.
         *
         * The double-fire is the defect no state-only oracle can see: a handler wired twice fires
         * the signal twice, the store ends up in the right shape either way, and a presence check
         * is green on both. The wrong-name variant is the same blind spot from the other side — the
         * intended signal fires once while a mistyped sibling fires alongside it, and only a count
         * scoped to the matched name tells the two apart. Omit = presence (≥1); `0` asserts the
         * signal never fired, which is a claim in its own right and NOT the same as omitting it.
         */
        count: z.number().int().nonnegative().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.STATE),
        store: z.string().optional(),
        path: z.string(),
        equals: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.SETTLED),
        quietMs: z.number().positive().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal(PredicateKind.ALL_OF), predicates: z.array(PredicateSchema) })
      .strict(),
    z
      .object({ kind: z.literal(PredicateKind.ANY_OF), predicates: z.array(PredicateSchema) })
      .strict(),
    z.object({ kind: z.literal(PredicateKind.NOT), predicate: PredicateSchema }).strict(),
  ]);
}

export const PredicateSchema = z.lazy(() =>
  z.preprocess(applyPredicateAliases, predicateUnion()),
) as unknown as z.ZodType<Predicate>;

/**
 * The fields a given predicate kind accepts, read off the schema itself.
 *
 * Derived rather than listed so the two can never disagree: a rejection message that names a stale
 * field set is worse than one that names none, because the agent trusts it and retries into the same
 * wall. Empty for a kind that is not in the union.
 */
export function predicateFieldsFor(kind: string): readonly string[] {
  const shape = shapeForKind(kind);
  if (null === shape) return [];
  return Object.keys(shape).filter((field) => 'kind' !== field);
}

/**
 * The union option for `kind`, or null when the kind is not one.
 *
 * One place that walks the union, so the field list and the nested lookup cannot disagree about
 * which option a kind resolves to — and so adding a third reader is a call rather than a fourth
 * copy of the same loop.
 */
function shapeForKind(kind: string): z.ZodRawShape | null {
  for (const option of predicateUnion().options) {
    const literal = option.shape['kind'];
    if (literal instanceof z.ZodLiteral && literal.value === kind) return option.shape;
  }
  return null;
}

/**
 * Is this tool parameter ACTUALLY the predicate union?
 *
 * Not a name check. `until` is overloaded on this surface — the act/assert family means a predicate
 * by it, while reticle_observe / _network / _console mean a NUMBER, an upper cursor bound — so any
 * caller keying on the word would treat a numeric parameter as a predicate and describe it to the
 * agent as an object. Keying on the schema cannot make that mistake.
 *
 * Lives beside the schema because two callers now ask the question: the lean tool surface, which
 * compacts these parameters, and `reticle_tools`, which spells their grammar out on request. Two
 * spellings of "is this a predicate" is one chance for the surface and the grammar to disagree.
 */
export function isPredicateParam(schema: z.ZodTypeAny): boolean {
  const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodTypeAny) : schema;
  return inner === PredicateSchema || inner === (PredicateSchema as z.ZodTypeAny).optional();
}

/**
 * Every kind's fields, in one block an agent can write a predicate from.
 *
 * The tool surface advertises the KIND list and points at `reticle_tools` for the fields, because
 * inlining the 12-variant recursive union in the declared JSON Schema costs thousands of characters
 * per predicate parameter, re-sent every turn, to describe a grammar most calls use one variant of.
 * That trade is right — but the pointer has to land somewhere, and it landed on a parameter
 * description reading "same shape as reticle_assert". So the grammar was reachable from nothing, and
 * an agent that could not find `route`'s fields fell back to a `text` check where a route check was
 * meant: the weaker oracle, which is the expensive half of an undiscoverable grammar.
 *
 * Derived from the schema, like `predicateFieldsFor` and for the same reason: a hand-written grammar
 * that drifts is worse than none, because the agent trusts it and retries into the same wall.
 */
export function predicateGrammar(): Readonly<Record<string, string>> {
  const grammar: Record<string, string> = {};
  for (const kind of Object.values(PredicateKind)) {
    const nested = predicateNestedFieldsFor(kind);
    grammar[kind] = predicateFieldsFor(kind)
      .map((field) => {
        const keys = nested[field];
        return undefined === keys ? field : `${field} { ${keys.join(', ')} }`;
      })
      .join(', ');
  }
  return grammar;
}

/**
 * The keys of a field that is an object, once its wrappers are peeled. Empty for anything else.
 *
 * Exported so the wrapper handling is asserted against THIS function rather than through the
 * rendered sentence. Reached only that way, a wrapper it fails to peel returns `[]`, the old
 * message prints unchanged, and nothing reddens — a regression with no symptom.
 *
 * No top-level predicate field is currently declared behind a wrapper, so the real schema exercises
 * none of these paths; that is exactly why they are worth a case each.
 */
export function nestedKeysOf(schema: z.ZodTypeAny | undefined): readonly string[] {
  if (undefined === schema) return [];
  const inner = unwrapSchema(schema);
  // `instanceof z.ZodObject` narrows to ZodObject<any>, whose `.shape` is `any`. Name the shape
  // type so the keys are read off something typed rather than laundering an `any` through
  // Object.keys.
  if (!(inner instanceof z.ZodObject)) return [];
  return Object.keys((inner as z.ZodObject<z.ZodRawShape>).shape);
}

/** Peel optional/nullable/default/effects wrappers off a field to reach the schema underneath. */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

/**
 * One level into the fields that are themselves objects — `{ query: ['by', 'value', ...] }`.
 *
 * Naming the top-level fields alone leaves `element` unguessable: `query` is an object with its own
 * required shape, and a plain CSS string works in `reticle_snapshot.scope` and `reticle_query.scope`,
 * so assuming it works here is the natural guess. The rejection is the only place that inconsistency
 * can be explained.
 *
 * One level only. Derived from the schema for the same reason `predicateFieldsFor` is: a stale field
 * list is worse than none, because the agent trusts it and retries into the same wall.
 */
export function predicateNestedFieldsFor(
  kind: string,
): Readonly<Record<string, readonly string[]>> {
  const shape = shapeForKind(kind);
  if (null === shape) return {};
  const nested: Record<string, readonly string[]> = {};
  for (const [field, schema] of Object.entries(shape)) {
    if ('kind' === field) continue;
    const keys = nestedKeysOf(schema);
    if (0 < keys.length) nested[field] = keys;
  }
  return nested;
}
