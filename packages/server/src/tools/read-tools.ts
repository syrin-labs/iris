/**
 * Read / record / replay tools — baselines + diff, recordings + replay, narrate, clock, state,
 * explore. Split out of tools.ts; assembled back via...READ_TOOLS.
 */
import { resolveAnnotateTarget } from '../flows/annotate-target.js';
import { z } from 'zod';
import {
  EventType,
  ReticleCommand,
  REPLAY_PROGRAM_VERSION,
  SnapshotMode,
  StorageArea,
} from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { advanceMsSchema, depthSchema } from './numeric-bounds.js';
import { proposeConsequences } from '../oracles/propose-consequences.js';
import type { CompiledProgram } from '../flows/recordings.js';
import { recordingBacktrackWarning, routesFromRecording } from '../flows/recording-backtrack.js';
import { replayProgram } from '../flows/replay.js';
import { diffLines } from '../project/baselines.js';
import { selectPath, capDepth, projectComponentState } from '../session/state-select.js';
import { costHint } from '../session/output-budget.js';
import { buildReactionReport, summarizeReaction } from '../events/reaction.js';
import { asString, asNumber, parseInteractive } from './tools-helpers.js';
import { type ToolDef, sessionIdShape, commandOrThrow, snapshotTree } from './tool-kit.js';
import { bufferEnvelope } from '../session/session-health.js';

/** The route part of a session URL. A host belongs to the machine, not to the journey. */
/**
 * The page a recording started on, as a NAVIGABLE path: pathname + hash.
 *
 * The hash matters and the pathname alone is not enough. Under a hash router every page has the
 * document pathname `/`, so a recording made on `#/posts/12` stored `/`, the replay's start-path
 * comparison saw `/` on both sides and never warned about drift, and the navigate it suggests
 * pointed at the default route rather than the recorded one.
 */
function pathnameOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * What record-stop says about a step that compiled to no anchor at all.
 *
 * `stable: false` does not mean "brittle". It means the compiler found no testid, no accessible
 * role+name and no component/source, so the step is bound to a live `ref` — a handle that dies with
 * the session. The replayer already states this outcome in full (see DEGRADED_STEP_REASON): the step
 * can never resolve on replay.
 *
 * The old wording here — "replay may be brittle (in-session only)" — described a fatal condition as
 * a quality note, so the agent saved the flow and learned the truth several calls later, as an
 * unhealable `anchor_degraded` drift at flow_verify, by which point nothing on screen points back
 * to the element that needed the attribute. Capture time is the only moment the fix is cheap: the
 * element is still on the page and the human is still in the loop.
 */
function unanchoredWarning(count: number): string {
  return (
    `${String(count)} step(s) not bound to a testid, an accessible role+name, or a component — ` +
    'they are pinned to a live ref, so they will replay in THIS session and can never resolve in ' +
    'another one. Add a data-testid to those elements and record the flow again, or accept that ' +
    'this recording is single-session only.'
  );
}

/** Severities the presenter HUD can render. */
const HUD_LEVELS = ['info', 'warn', 'error'] as const;
const HUD_LEVEL_LIST = HUD_LEVELS.join(' | ');
const hudLevelEnum = z.enum(HUD_LEVELS);

/**
 * How deep an unscoped `reticle_state` read goes before collapsing to size markers.
 *
 * 3 keeps every store name and every top-level key visible — enough to see what exists and to name a
 * `path` — while collapsing the collections that make an unscoped read enormous. Measured on the
 * bench fixture: unbounded 10,119 B, depth 4 1,323 B, depth 3 596 B, depth 2 322 B. Two loses the
 * per-store keys, which is the orientation the next call needs.
 */
const DEFAULT_STATE_DEPTH = 1;

export const READ_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.BASELINE_SAVE,
    description:
      'Snapshot the current semantic state under a name, to diff against later (regression detection).',
    inputSchema: {
      name: z
        .string()
        .describe(
          'Label for this baseline snapshot (e.g. "dashboard-initial"). Use the same name in reticle_baseline{action:"diff"} to compare.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      baseline: z
        .string()
        .describe('Saved baseline name — pass to reticle_baseline{action:"diff"} to compare.'),
      lineCount: z.number(),
    },
    handler: async (deps, args) => {
      const name = asString(args['name']) ?? 'default';
      const { lines, route } = await snapshotTree(deps, asString(args['sessionId']));
      deps.baselines.save({ name, lines, route });
      return { baseline: name, lineCount: lines.length };
    },
  },
  {
    name: ReticleTool.BASELINE_LIST,
    description: 'List saved baseline names.',
    inputSchema: {},
    outputSchema: {
      baselines: z.array(z.string()),
    },
    handler: (deps) => Promise.resolve({ baselines: deps.baselines.list() }),
  },
  {
    name: ReticleTool.DIFF,
    description:
      'Diff current semantic state vs a saved baseline: REMOVED/ADDED elements + console-error count. Call reticle_baseline{action:"list"} to list saved baselines, reticle_baseline{action:"save"} to create one. Pass `baseline` (name from reticle_baseline{action:"list"}). Answers "did anything silently go missing/break?".',
    inputSchema: {
      baseline: z
        .string()
        .describe(
          'Baseline name to compare against. Call reticle_baseline{action:"list"} to get available names; names are created by reticle_baseline{action:"save"}.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      baseline: z.string(),
      removed: z.array(z.string()),
      added: z.array(z.string()),
      consoleErrors: z.number(),
      routeChanged: z.boolean(),
      buffer: z.unknown().optional(),
    },
    handler: async (deps, args) => {
      // `name` too: the merged reticle_baseline family made this required field optional, and the
      // SIBLING that creates a baseline calls it `name` — its description even says to reuse it
      // here. So `{ action:"diff", name:"x" }` is a valid call that used to look up 'default' and
      // report "no baseline named 'default'", naming something the caller never mentioned.
      const name = asString(args['baseline']) ?? asString(args['name']) ?? 'default';
      const base = deps.baselines.get(name);
      if (base === undefined) throw new Error(`no baseline named '${name}'`);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const { lines, route } = await snapshotTree(deps, asString(args['sessionId']));
      const { removed, added } = diffLines(base.lines, lines);
      const consoleErrors = session
        .eventsSince(0)
        .filter(
          (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
        ).length;
      // Buffer-honesty: the console-error count reads the whole buffer, which evicts — surface the
      // eviction so a chatty-page regression check can't silently under-report with no signal.
      return {
        baseline: name,
        removed,
        added,
        consoleErrors,
        routeChanged: base.route !== route,
        ...bufferEnvelope(session),
      };
    },
  },
  {
    name: ReticleTool.RECORD_START,
    description: 'Start recording the event timeline under a name (for replay / a flow report).',
    inputSchema: {
      recordingName: z
        .string()
        .describe(
          'Identifier for this recording. Pass the same name to reticle_record{action:"stop"} and reticle_replay.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      since: z.number(),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['recordingName']) ?? 'default';
      const cursor = session.elapsed();
      // Where the journey begins, so a saved flow can navigate here before step 1 instead of
      // replaying from wherever the page happens to be. Pathname only: a host or port belongs to
      // the machine that recorded it, not to the journey.
      deps.recordings.start(name, cursor, pathnameOf(session.url));
      return Promise.resolve({ recordingName: name, since: cursor });
    },
  },
  {
    name: ReticleTool.RECORD_STOP,
    description:
      'Stop the recording identified by `recordingName` and return both the reaction report for the span and a compiled, replayable { program: { version, steps:[{tool,args,stable}] } } of the agent acts captured during it. `warning` is present when the window left a page and returned to it — replay has no navigation steps, so the next click will look for a control on a page the tab is no longer on.',
    inputSchema: {
      recordingName: z
        .string()
        .describe('Identifier of an active recording started with reticle_record{action:"start"}.'),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      program: z.unknown(),
      warning: z.string().optional(),
      proposedConsequences: z
        .array(z.unknown())
        .optional()
        .describe(
          'Ranked mustHold proposals derived from the recorded window (signal > net/state/route > presence, weak flagged) — accept one as a flow success/until to turn the recording into a real oracle.',
        ),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // The recording actually RUNNING when there is exactly one, not the literal name `default` —
      // the same defaulting that made `annotate` report "no steps" against a recording full of them.
      // With several running, `default` stays the documented answer rather than a guess.
      const name = resolveAnnotateTarget(asString(args['recordingName']), deps.recordings.active());
      const rec = deps.recordings.stop(name);
      if (rec === undefined) {
        const active = deps.recordings.active();
        throw new Error(
          0 === active.length
            ? `no active recording named '${name}' — none is in progress`
            : `no active recording named '${name}'; in progress: ${active.map((r) => `'${r}'`).join(', ')}`,
        );
      }
      const events = session.eventsSince(rec.cursor);
      const routes = routesFromRecording(rec.startPath, events);
      const program: CompiledProgram = {
        name,
        version: REPLAY_PROGRAM_VERSION,
        steps: rec.steps,
        ...(rec.startPath === undefined ? {} : { startPath: rec.startPath }),
        ...(0 === routes.length ? {} : { routes }),
      };
      deps.recordings.saveCompiled(program);
      const unstable = rec.steps.filter((s) => !s.stable).length;
      const report = buildReactionReport(events, session.elapsed() - rec.cursor);
      // Self-generating oracles: propose ranked mustHold from what the recorded window actually did.
      const proposedConsequences = proposeConsequences(events);
      const digest = summarizeReaction(report);
      // Say that the timeline was left out, and where it lives.
      //
      // Dropping the raw events is right: they were most of a response large enough to truncate the
      // part that mattered. But a field that simply stops appearing is indistinguishable from one
      // this version never had, and an agent cannot ask for something it does not know exists. The
      // same rule the capped diff arrays follow: a trim is never silent.
      const timeline =
        events.length > 0
          ? {
              timeline_omitted: `${String(events.length)} event(s) were recorded and are not included here. Call reticle_observe { since: ${String(rec.cursor)} } for the raw timeline.`,
            }
          : {};
      const unanchored = 0 < unstable ? unanchoredWarning(unstable) : undefined;
      const backtrack = recordingBacktrackWarning(routes);
      const warning = [unanchored, backtrack].filter((part): part is string => part !== undefined);
      const body = {
        recordingName: name,
        program,
        ...timeline,
        ...(0 === warning.length ? {} : { warning: warning.join(' ') }),
        ...(proposedConsequences.length > 0 ? { proposedConsequences } : {}),
        ...digest,
      };
      return Promise.resolve({
        ...body,
        cost: costHint(body, events.length),
      });
    },
  },
  {
    name: ReticleTool.REPLAY,
    description:
      'Re-execute a previously recorded program by recordingName. Re-resolves each step to its element by testid (falling back to the stored ref for unstable steps) and runs the actions in order against the live session. Stops at the first failure. Destructive controls require confirmDangerous:true on every replay; confirmation is never persisted. Returns { ok, steps:[{tool,ok,error?,note?}] }.',
    inputSchema: {
      recordingName: z
        .string()
        .describe(
          'Name of a compiled recording (from reticle_record{action:"stop"}) to re-execute.',
        ),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this replay only.'),
      ...sessionIdShape,
    },
    outputSchema: {
      recordingName: z.string(),
      ok: z.boolean(),
      steps: z.array(
        z.object({
          tool: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
    },
    handler: async (deps, args) => {
      const name = asString(args['recordingName']) ?? 'default';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) throw new Error(`no compiled recording named '${name}'`);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const steps = await replayProgram(session, program, true === args['confirmDangerous']);
      return { recordingName: name, since, steps, ok: steps.every((s) => s.ok) };
    },
  },
  {
    name: ReticleTool.NARRATE,
    description:
      'Narrate your intent on the page (presenter HUD) so the human watching sees what you are about to do and why. Use a short sentence before a meaningful action.',
    inputSchema: {
      text: z
        .string()
        .describe(
          'Short sentence describing your next action, shown on the presenter HUD for the developer watching.',
        ),
      // Derived, like every other advertised vocabulary here: a free string let a typo through to
      // a HUD that then rendered an unknown severity.
      level: hudLevelEnum
        .optional()
        .describe(`Display severity: ${HUD_LEVEL_LIST}. Default: info.`),
      ...sessionIdShape,
    },
    outputSchema: { ok: z.boolean() },
    handler: async (deps, args) => {
      const result = (await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.NARRATE,
        {
          text: args['text'],
          level: args['level'],
        },
      )) as Record<string, unknown>;
      return { ok: true, ...result };
    },
  },
  {
    name: ReticleTool.CLOCK,
    description:
      'Control a fake clock: { freeze:true } to freeze time, { advanceMs:N } to fast-forward timers (toasts, debounces, auto-dismiss), { reset:true } to restore. Lets you test time-gated UI deterministically.',
    inputSchema: {
      freeze: z
        .boolean()
        .optional()
        .describe('Freeze the fake clock. Time stops advancing until advanceMs or reset.'),
      advanceMs: advanceMsSchema
        .optional()
        .describe(
          'Fast-forward time by this many milliseconds — triggers debounces, toasts, auto-dismiss timers.',
        ),
      reset: z.boolean().optional().describe('Restore the real clock.'),
      ...sessionIdShape,
    },
    // The command returns `{ frozen }`. It used to declare `{ ok, elapsed }` — neither of which any
    // clock code path produces — and MCP strips undeclared fields from structuredContent, so a
    // successful freeze and a failed one both validated to `{}` and became indistinguishable.
    outputSchema: {
      frozen: z.boolean().optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.CLOCK, {
        freeze: args['freeze'],
        advanceMs: args['advanceMs'],
        reset: args['reset'],
      }),
  },
  {
    name: ReticleTool.STATE,
    example: { depth: 2 },
    description:
      "Read live framework state without the app pre-broadcasting it. PREFERRED/RELIABLE: `store` reads a registered store (e.g. 'workspace'); omit `store` to read all stores. To avoid paying for a huge store, scope the read: `path` extracts a dot-path sub-tree (e.g. 'captionCache.v3', with numeric array indices), and `depth` collapses anything deeper than N levels to a size marker. A wrong `path` returns { found:false, availableKeys } so it is diagnosable. `ref` attempts a best-effort read of the nearest React component's hook state and is BOUNDED — on failure it returns component: { ok: false, reason: 'component-state-unavailable' }. Without path/depth: returns { stores, storeNames, component? }.",
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe(
          "Element ref — attempts a best-effort read of the nearest React component's hook state.",
        ),
      store: z
        .string()
        .optional()
        .describe("Registered store name (e.g. 'workspace'). Omit to read all stores."),
      path: z
        .string()
        .optional()
        .describe(
          "Dot-path into the store (e.g. 'captionCache.v3'). Numeric array indices are supported.",
        ),
      depth: depthSchema
        .optional()
        .describe(
          'Collapse anything deeper than N levels to a size marker — avoids huge outputs for large stores. A whole number of levels, 1 or more.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      stores: z.record(z.unknown()).optional(),
      storeNames: z.array(z.string()).optional(),
      found: z.boolean().optional(),
      value: z.unknown().optional(),
      // Scoped-read diagnostics (echoed store/path + the keys that WERE available on a miss) — declared
      // so a schema-strict client keeps the self-correction hint instead of dropping it.
      store: z.string().optional(),
      path: z.string().optional(),
      availableKeys: z.array(z.string()).optional(),
      // Present only when `availableKeys` is a SAMPLE. Declared for the same reason as the truncation
      // report below: a capped list of 50 keys with no count reads as a complete one, so an agent
      // concludes the key it wants is absent when it is merely past the cap.
      totalKeys: z.number().optional(),
      component: z
        .object({
          ok: z.boolean(),
          reason: z.string().optional(),
          state: z.unknown().optional(),
          // The component name and the projected hook VALUES — declared so a schema-strict client
          // keeps them (they were the point of passing `ref` at all).
          component: z.string().optional(),
          hooks: z.array(z.unknown()).optional(),
          // Present only when effect hooks were projected out. Declared for the same reason as the
          // store truncation report below: a shortened list with no marker reads as a complete one.
          truncation: z
            .object({ droppedItems: z.number(), note: z.string() })
            .optional()
            .describe('Present only when effect hooks were dropped — `hooks` is a projection.'),
        })
        .optional(),
      // Truncation report — present ONLY when a transport cap trimmed the value. Declared so a
      // schema-strict client on the `full` profile KEEPS it: this is a false-green GUARD, and dropping
      // it would hand back a partial store with no marker, which is the exact silent truncation the
      // report exists to prevent (re-introduced for structuredContent consumers if it is not here).
      truncation: z
        .object({
          droppedItems: z.number(),
          truncatedValues: z.number(),
          note: z.string(),
        })
        .partial()
        .optional()
        .describe('Present only when a cap trimmed the value — the read is NOT the whole store.'),
    },
    handler: async (deps, args) => {
      const store = asString(args['store']);
      const path = asString(args['path']);
      const depth = asNumber(args['depth']);
      // Forward path/depth so a CURRENT browser SDK scopes the read IN-PAGE, before the transport —
      // the value never gets size-truncated in transit. (An older SDK ignores them and returns the
      // whole store; we then scope server-side below as a back-compat fallback.)
      const raw = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.STATE_READ,
        {
          ref: args['ref'],
          store,
          path,
          depth,
        },
      );
      // Project the component hook read BEFORE anything else touches it: React hands back the raw
      // fiber hook list, whose effect entries are chained null-filled internals an agent cannot act
      // on (measured: 2632 -> 1459 bytes on a five-state/three-effect component). Done here rather
      // than in the SDK so an older browser build gets the same projection. The drop is disclosed
      // on `component.truncation`.
      const result =
        'object' === typeof raw && null !== raw && 'component' in raw
          ? { ...raw, component: projectComponentState(raw.component) }
          : raw;
      // Normalize storeNames to a string[] regardless of how the wire delivered it — the
      // outputSchema requires an array, and a non-array here makes MCP reject the whole result
      // (so the agent gets nothing instead of the state). Defensive: a string becomes a 1-element array.
      const root = result as {
        stores?: Record<string, unknown>;
        storeNames?: unknown;
        found?: unknown;
      };
      const names = Array.isArray(root.storeNames)
        ? root.storeNames.filter((n): n is string => 'string' === typeof n)
        : 'string' === typeof root.storeNames && root.storeNames.length > 0
          ? [root.storeNames]
          : [];

      // The browser already scoped it in-page (the `found` shape) — pass through, just safe storeNames.
      if ('boolean' === typeof root.found) {
        return { ...(root as Record<string, unknown>), storeNames: names };
      }

      if (path === undefined && depth === undefined) {
        // An unscoped read used to hand back the WHOLE store tree: 10,119 bytes on this repo's own
        // fixture. A tool result is not paid once — it stays in the conversation and is re-sent on
        // every later turn, so one such read cost roughly 34,000 tokens across a 16-turn run.
        //
        // The VALUES are bounded; the ENVELOPE is not touched. `{ stores, storeNames, component }`
        // is the documented shape and callers depend on it — a first attempt applied the bound by
        // routing through the path selector, which silently changed the reply to `{ found, value }`
        // and took the component projection and the bridge round-trip with it. Capping in place
        // keeps every store name and the component read exactly where they were; only collections
        // deeper than the bound collapse to a marker like "[Array(40)]", which still says what is
        // there and how much of it.
        //
        // A default, not a cap: any explicit `depth` is honoured at any value, and `path` reads a
        // sub-tree at full fidelity. Nothing became unreachable, only cheaper by default.
        const stores = root.stores;
        const bounded =
          'object' === typeof stores && null !== stores
            ? Object.fromEntries(
                Object.entries(stores).map(([k, v]) => [k, capDepth(v, DEFAULT_STATE_DEPTH)]),
              )
            : undefined;
        // Say that it was bounded, and only when it actually was. A read that quietly hands back
        // less than it was asked for is the shape of a false green: the agent sees
        // `deployments: "[Array(40)]"`, concludes it has read the store, and asserts over a summary.
        // The marker alone is suggestive; this makes it explicit and names the way to the real value.
        const trimmed = bounded !== undefined && JSON.stringify(bounded) !== JSON.stringify(stores);
        return {
          ...(root as Record<string, unknown>),
          ...(bounded === undefined ? {} : { stores: bounded }),
          storeNames: names,
          ...(trimmed
            ? {
                truncation: {
                  note:
                    `bounded to depth ${String(DEFAULT_STATE_DEPTH)} per store — this is NOT the ` +
                    'whole store. Values shown as "[Array(n)]" or "{…n keys}" were collapsed; read ' +
                    'one with { store, path } (e.g. { store:"app", path:"deployments.0" }) or pass ' +
                    'an explicit `depth` for more.',
                },
              }
            : {}),
        };
      }

      // Back-compat: an older browser returned the whole store; scope it here (may already be
      // size-truncated in transit for a very large store — that is the limitation this fix removes
      // for current SDKs).
      const base = store !== undefined ? (root.stores ?? {})[store] : result;
      const selection = path !== undefined ? selectPath(base, path) : { found: true, value: base };
      const value =
        selection.found && depth !== undefined ? capDepth(selection.value, depth) : selection.value;
      return {
        store,
        path,
        ...selection,
        value,
        storeNames: names,
      };
    },
  },
  {
    name: ReticleTool.EXPLORE,
    description:
      'Autonomous-exploration helper: list interactive elements (with refs) + current console-error count, so the agent can drive the app and report anomalies.',
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          'CSS selector or element ref to restrict the interactive element list to a subtree.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      interactive: z.array(z.unknown()),
      consoleErrors: z.number(),
      hint: z.string(),
      buffer: z.unknown().optional(),
      truncated: z
        .boolean()
        .optional()
        .describe(
          'True when the page exceeded the snapshot cap, so `interactive` is a document-order PREFIX — a floor on the controls that exist, not a total. Narrow with `scope` to reach the rest.',
        ),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const result = await session.command(ReticleCommand.SNAPSHOT, {
        mode: SnapshotMode.INTERACTIVE,
        scope: args['scope'],
      });
      if (!result.ok) throw new Error(result.error ?? 'snapshot failed');
      const snap = (result.result ?? {}) as { tree?: string; truncated?: boolean };
      const consoleErrors = session
        .eventsSince(0)
        .filter(
          (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
        ).length;
      return {
        interactive: parseInteractive(snap.tree ?? ''),
        // The walk stops at its node cap and returns a document-order prefix, so an inventory taken
        // from a big page is a floor, not a census — and this is the tool crawl's description points
        // agents at first for "a non-destructive list of what is here".
        ...(true === snap.truncated ? { truncated: true } : {}),
        consoleErrors,
        hint: 'act on each ref, observe the reaction, and report failed requests / console errors / dead controls',
        // Buffer-honesty: the console-error count spans the whole buffer, which evicts — signal it.
        ...bufferEnvelope(session),
      };
    },
  },
  {
    name: ReticleTool.STORAGE,
    description:
      "Read the app's client-side storage: localStorage, sessionStorage, and readable cookies. " +
      'Verifies auth/session persistence a screenshot cannot see — "token persisted after login", ' +
      '"cart survived reload", "logout cleared the session". Sensitive keys (token/session/password/…) ' +
      'are REDACTED; httpOnly cookies are invisible to JS by design. `area` scopes to local|session|' +
      'cookies (omit for all three); `key` returns just that value with found:true/false so a miss is ' +
      'diagnosable.',
    inputSchema: {
      area: z
        .nativeEnum(StorageArea)
        .optional()
        .describe('Scope to one storage area. Omit to read all three.'),
      key: z
        .string()
        .optional()
        .describe("Return only this key's value (found:false when absent)."),
      ...sessionIdShape,
    },
    outputSchema: {
      local: z.record(z.string()).optional(),
      session: z.record(z.string()).optional(),
      cookies: z.record(z.string()).optional(),
      area: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      found: z.boolean().optional(),
    },
    handler: async (deps, args) => {
      const area = asString(args['area']);
      const key = asString(args['key']);
      const result = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.STORAGE_READ,
        area !== undefined ? { area } : {},
      );
      const data = ('object' === typeof result && result !== null ? result : {}) as Record<
        string,
        unknown
      >;
      if (key === undefined) return data;
      // Look up the key in the scoped area, or across all three areas when none was named.
      const areas = area !== undefined ? [data] : [data['local'], data['session'], data['cookies']];
      for (const a of areas) {
        if ('object' === typeof a && a !== null && key in a) {
          return { area, key, value: String((a as Record<string, unknown>)[key]), found: true };
        }
      }
      return { area, key, found: false };
    },
  },
];
