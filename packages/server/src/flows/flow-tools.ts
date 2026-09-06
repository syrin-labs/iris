import { z } from 'zod';
import { emptyFlowRefusal } from './empty-flow.js';
import { aliasParam } from '../tools/alias-args.js';
import {
  FlowErrorCode,
  RecordedSaveError,
  ReplayStatus,
  type FlowReplayResult,
} from '@reticlehq/core';
import type { FlowFile } from '@reticlehq/core';
import { recordSuiteFlakes } from './suite-flakes.js';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { workerCountSchema } from '../tools/numeric-bounds.js';
import { log } from '../log.js';
import { cloudFetch, syncFlowToCloud, SyncOutcome } from '../cloud/cloud-sync.js';
import { mapWithConcurrency, resolveConcurrency } from './parallel-suite.js';
import { acquireLeasedSession } from '../tools/lease-tools.js';
import { homedir } from 'node:os';
import { resolveProjectCloud } from '../cloud/cloud-config.js';
import { buildSuiteVerdict } from './decision.js';
import { classifyFlowAssertions } from './flow-classify.js';
import { recordingBacktrackWarning } from './recording-backtrack.js';
import { isValidFlowName, flowPath } from '../project/reticle-dir.js';
import type { SuiteVerdict } from '@reticlehq/core';
import { type FlowAnnotations } from './flows.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { flowsForSession } from './flow-store-for-session.js';
import {
  replayNamedFlow,
  flowErrorMessage,
  latestRecordedFlow,
  sessionProjectId,
} from './flow-replay-run.js';
import { persistAndSyncVerificationRun, type TimedReplay } from '../runs/verification-sync.js';
import { runServerVerify } from './server-verify.js';
import { healFlow } from './heal-run.js';

export { replayNamedFlow } from './flow-replay-run.js';

/**
 * Best-effort mirror of a just-saved flow to Reticle (only when logged in — both cloud env vars
 * set). Fire-and-forget: resolves the config, POSTs via the platform fetch, and logs the outcome. Any
 * failure is swallowed so a network hiccup never affects the local save.
 */
async function syncSavedFlowToCloud(
  deps: ToolDeps,
  flow: FlowFile,
  projectId: string | undefined,
): Promise<void> {
  // Per-project cloud: sync a saved flow only when cloud is attached AND flow sync is enabled.
  const cloud = await resolveProjectCloud(deps.fs, deps.reticleRoot, homedir(), process.env);
  if (null === cloud.config || !cloud.policy.flows) return; // not attached / flows disabled → local only
  const result = await syncFlowToCloud(flow, cloud.config, projectId, cloudFetch);
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-flow-sync-failed', { flow: flow.name, status: result.status, error: result.error });
  }
}

/**
 * The URL a leased context should open: the app's ORIGIN, not the live tab's current location.
 *
 * The live tab drifts — every replay navigates it — so using its full URL made each lease start wherever
 * the previous run happened to finish (observed: leases opening /deployments and failing to find the
 * login control that only exists at the root). A lease must be a FRESH visit to a deterministic entry
 * point; flows that need another page carry their own startPath.
 */
export function leasableAppUrl(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    const url = deps.sessions.resolve(sessionId).url;
    if (typeof url !== 'string' || 0 === url.length) return undefined;
    return new URL(url).origin;
  } catch {
    return undefined; // no live session (or an unparseable URL) → sequential path
  }
}

/** A flow whose leased context never came up is a suite ERROR, never a silent pass. */
export function leaseFailureReplay(name: string, error: string | undefined): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.ERROR,
    steps: [],
    error: {
      code: ReplayStatus.ERROR,
      message: `could not run in a leased context: ${error ?? 'unknown error'}`,
    },
  };
}

/** Stand-in path for a flow whose name fails the path-segment guard — never a real join. */
const INVALID_FLOW_NAME_PATH = '(invalid flow name — not a usable path)';

/**
 * How a save reports that nobody said what the flow is for.
 *
 * Declared once and shared by every save tool: an undeclared field is stripped from
 * `structuredContent` by a schema-strict MCP client, so a save path that forgot this line would
 * report the nudge to the unit tests and to nobody else.
 */
const INTENT_GAP_FIELD = z
  .unknown()
  .optional()
  .describe(
    'Present ONLY when the flow was saved with nothing saying what it is for: { kind, missing, cost, fix }. The flow is on disk either way — this never blocks a save. Close it by saving again with `intent`, or by setting the flow file’s `intentId` to an intent already in the ledger. Nothing here is ever derived from the flow name, the steps or the assertions: a guessed goal reads as the author’s own words.',
  );

export const FLOW_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.FLOW_SAVE,
    description:
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .reticle/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty, assertions, warning? } — `assertions.grade` is asserted | presence-only | assertion-free: a flow that only acts (or only checks element presence) will pass even if the feature breaks, so when grade is not "asserted" follow assertions.warning and add a consequence assertion via reticle_annotate (assert-signal / assert-net / success-state). `warning` is present when the recording left a page and returned to it: replay has no navigation steps, so the next click will look for a control on a page the tab is no longer on.',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z
        .string()
        .describe(
          'Which RECORDING to save — the name reticle_record{start} was called with. This is a lookup key, not the filename: pass `saveAs` to choose that.',
        ),
      saveAs: z
        .string()
        .optional()
        .describe(
          'Name for the flow file (.reticle/flows/<saveAs>.json), and the name reticle_flow{action:"load"} / reticle_flow_replay take. Omit to reuse the recording name.',
        ),
      intent: z
        .string()
        .optional()
        .describe(
          'What this flow is FOR, in prose: which user does what, and what should become true. Answer it here rather than in a second call. Without it the flow still saves, but the day it goes red the report can only name the step that broke, not the thing that stopped being true.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — scopes the saved flow to that app.'),
    },
    // Schema MUST match what the handler actually returns on BOTH paths: success
    // { name, stepCount, degraded, empty, assertions? } and error { error, code }. The prior schema
    // declared { saved, path } — fields the handler never returns — so a schema-validating MCP
    // client rejected every reticle_flow_save result ("expected boolean"). Unit tests call the handler
    // directly and bypass MCP output validation, so only a live MCP run caught it (cf. the same
    // class of bug fixed for FLOW_LIST above).
    outputSchema: {
      name: z.string().optional(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
      empty: z.boolean().optional(),
      assertions: z
        .object({
          grade: z.string().describe('asserted | presence-only | assertion-free'),
          hasConsequenceAssertion: z.boolean(),
          totalSteps: z.number(),
          consequenceSteps: z.number(),
          weakSteps: z.number(),
          warning: z.string().optional(),
        })
        .optional(),
      intentGap: INTENT_GAP_FIELD,
      warning: z
        .string()
        .optional()
        .describe(
          'Present when the recording left a page and returned to it. Replay has no navigation steps, so the next click will look for a control on a page the tab is no longer on.',
        ),
      error: z.string().optional(),
      code: z.string().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const name = asString(aliasParam(args, 'flowName', ['flow'])['flowName']) ?? '';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) {
        /*
         * Name what DOES exist.
         *
         * `flowName` here is the RECORDING's name, while every other flow tool reads it as the name
         * to save AS — so recording `default` and saving as `sign-in` looks obviously right and
         * answers "no compiled recording by that name". The old message then said "record one
         * first", which is advice to repeat the step that just succeeded. Cost a real investigation
         * before the names were compared.
         */
        const held = deps.recordings.compiled();
        return Promise.resolve({
          error:
            0 === held.length
              ? flowErrorMessage(FlowErrorCode.NO_RECORDING)
              : `no recording named '${name}'. This is the name the RECORDING was made under, not ` +
                `the name to save it as — stopped and ready to save: ${held.map((n) => `'${n}'`).join(', ')}.`,
          code: FlowErrorCode.NO_RECORDING,
        });
      }
      // The name to save AS, which is not the name looked up above.
      //
      // `flowName` selects the recording; a recording is named at `record{start}`, often `default`
      // or whatever the drive began as. Every other flow tool reads a flow name as the thing you
      // load and replay, so a caller naming their flow at save time had no way to do it and had to
      // `mv` the file on disk. The error message below already had to explain this ambiguity; that
      // it needed explaining is the bug (#698).
      const saveAs = asString(args['saveAs']);
      if (saveAs !== undefined && !isValidFlowName(saveAs)) {
        return Promise.resolve({
          error: `'${saveAs}' is not a usable flow name — it becomes a filename under .reticle/flows/.`,
          code: FlowErrorCode.INVALID_NAME,
        });
      }
      // fold any structured annotations (expect/dynamic/success/intent) onto the saved flow.
      // Keyed by the RECORDING name: annotations were left against the recording, not the file.
      const success = deps.annotations.success(name);
      // The inline argument wins over an annotation left from an earlier call: it is the more recent
      // statement, and it is the one the author just typed.
      const intent = asString(args['intent']) ?? deps.annotations.intent(name);
      const annotations: FlowAnnotations = {
        stepExpect: deps.annotations.stepExpect(name),
        dynamic: deps.annotations.dynamic(name),
        ...(success !== undefined ? { success } : {}),
        ...(intent !== undefined ? { intent } : {}),
      };
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      // A zero-step recording is not a flow. Saving it wrote a file the suite reports "unverifiable"
      // forever while telling the agent it had saved a regression test — see empty-flow.
      const emptyRefusal = emptyFlowRefusal(program.steps.length, name);
      if (emptyRefusal !== undefined) return Promise.resolve(emptyRefusal);
      const { flows, root } = flowsForSession(deps, projectId);
      const toSave = saveAs === undefined ? program : { ...program, name: saveAs };
      return flows.save(toSave, annotations, projectId).then(async (res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code, res.detail), code: res.code };
        deps.annotations.clear(name);
        // Grade the saved flow's assertions so the agent learns immediately if it just saved a flow
        // that asserts nothing observable (passes even when the feature is broken).
        const loaded = await flows.load(res.value.name, projectId);
        // The absolute path, always. A save that reports success and not WHERE cost a reporter a
        // `find` across their disk to discover it had landed in an unrelated repo. The name came
        // back from a save that succeeded, so the guard is a type narrowing rather than a doubt.
        const saved = res.value.name;
        const path = isValidFlowName(saved) ? flowPath(root, saved, projectId) : undefined;
        const backtrack = recordingBacktrackWarning(program.routes ?? []);
        return loaded.ok
          ? {
              ...res.value,
              ...(path === undefined ? {} : { path }),
              assertions: classifyFlowAssertions(loaded.value),
              ...(backtrack === undefined ? {} : { warning: backtrack }),
            }
          : {
              ...res.value,
              ...(path === undefined ? {} : { path }),
              ...(backtrack === undefined ? {} : { warning: backtrack }),
            };
      });
    },
  },
  {
    name: ReticleTool.FLOW_LIST,
    description:
      'List saved flow names under .reticle/flows (a fresh agent learns the demonstrated journeys ' +
      'without a browser). Scoped to the connected app: with a session it lists that project’s ' +
      'flows plus legacy untagged ones; with no browser it lists every flow in the repo.',
    inputSchema: {
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID — scopes the list to that app. Omit to list every saved flow.',
        ),
    },
    outputSchema: {
      flows: z.array(
        z.object({ name: z.string(), path: z.string(), createdAt: z.number().optional() }),
      ),
    },
    // Return {name, path} objects to MATCH the declared outputSchema. Returning bare name strings
    // (the prior bug) made schema-validating MCP clients reject the result ("expected object,
    // received string") — caught driving the live demo.
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      // The APP's flows, not the daemon's. Listing where the daemon was launched is what showed a
      // React dashboard a HUD full of Electron and Tauri flows from an unrelated checkout.
      const { flows: store, root } = flowsForSession(deps, projectId);
      return store.list(projectId).then((names) => ({
        // `list` deliberately returns invalid names so they are reported rather than silently
        // dropped — but the declared outputSchema requires `path` on EVERY entry, and omitting it made
        // a strict MCP client reject the whole listing (the agent then sees no flows at all, which is
        // worse than the bad path it replaced). So every entry keeps a string `path`; an invalid name
        // gets an explanatory marker instead of a joined filesystem path, which is what must never
        // happen for a traversal-shaped name.
        flows: names.map((name) =>
          isValidFlowName(name)
            ? { name, path: flowPath(root, name, projectId) }
            : { name, path: INVALID_FLOW_NAME_PATH },
        ),
      }));
    },
  },
  {
    name: ReticleTool.FLOW_LOAD,
    description:
      'Read + validate a saved flow by flowName from .reticle/flows/<flowName>.json. Returns the FlowFile (version, flowName, createdAt, anchored steps) or a structured { error, code }. Step `expect` (and flow `success`) accepts the same allOf grammar as reticle_act_and_wait; a parse failure names the step and key rather than calling the file malformed.',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow{action:"list"}.'),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — resolves the flow within that app’s scope.'),
    },
    outputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z.string(),
      steps: z.array(z.unknown()),
      createdAt: z.number().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows
        .load(asString(aliasParam(args, 'flowName', ['flow'])['flowName']) ?? '', projectId)
        .then((res) => {
          if (!res.ok) return { error: flowErrorMessage(res.code, res.detail), code: res.code };
          const { name, ...rest } = res.value;
          return { flowName: name, ...rest };
        });
    },
  },
  {
    name: ReticleTool.FLOW_DELETE,
    description:
      'Delete a saved flow file so a renamed/obsolete flow stops lingering in the replay list. Scoped ' +
      'to the connected app. Returns { deleted: true } or a structured { error, code } (code not_found ' +
      'when no such flow — deleting an absent flow is an error, not a silent no-op).',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow{action:"list"}.'),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — resolves the flow within that app’s scope.'),
    },
    outputSchema: {
      deleted: z.boolean().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows
        .remove(asString(aliasParam(args, 'flowName', ['flow'])['flowName']) ?? '', projectId)
        .then((res) => {
          if (!res.ok) return { error: flowErrorMessage(res.code, res.detail), code: res.code };
          return { deleted: true };
        });
    },
  },
  {
    name: ReticleTool.FLOW_REPLAY,
    description:
      "Replay a git-checked flow from .reticle/flows/<name>.json. RE-RESOLVES each step's semantic " +
      'anchor (testid via reticle_query; signal via predicate) against the LIVE DOM — never reuses a ' +
      'stale ref. On an anchor MISS returns legible DRIFT { step, anchor, drift:{ reasonKind, reason, ' +
      'nearest } } (the closest surviving testid) and stops — the "whose fault is it" contract. ' +
      'Returns { name, status: ok|drift|error, steps:[...] }; missing/malformed files and action ' +
      'failures are status:error with a structured code (distinct from contract-changed drift). ' +
      'An ok replay of a flow that asserts no consequence also carries unverifiable:{reason} — it ' +
      'would read ok even if the feature were broken, so do NOT treat that ok as proof.',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow{action:"list"}.'),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this replay only.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      // The flow's name — always present in FlowReplayResult (the description promises `{ name, … }`),
      // but omitted here, so a validating profile stripped it and a replay result arrived anonymous.
      name: z.string(),
      status: z.string().describe('ok | drift | error'),
      steps: z.array(z.unknown()),
      proposals: z.array(z.unknown()).optional(),
      deviation: z
        .unknown()
        .optional()
        .describe(
          'Push-default deviation report over the replay segments: ranked deviations vs the learned envelope + a nominal count, or a fall-back note below 3 runs.',
        ),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
      // Declared here or a validating profile strips it -- the same way `name` was stripped once.
      // A field the handler sets and the schema omits arrives as nothing, silently.
      unverifiable: z
        .object({ reason: z.string() })
        .optional()
        .describe(
          'Set on an ok replay that cannot fail: the flow asserts no observable consequence, so it passes even when the feature is broken. Same reason reticle_verify{action:"flows"} reports.',
        ),
      decision: z
        .object({
          verdict: z.string(),
          summary: z.string(),
          whatChanged: z.string().optional(),
          whereInSource: z.string().optional(),
          suggestedFix: z.string().optional(),
          nextAction: z.string(),
        })
        .optional()
        .describe('Autonomy envelope: verdict + what changed + where + fix + next action.'),
    },
    // The decision envelope is attached by replayNamedFlow only on drift/fail (clean pass stays
    // token-flat). Single-flow replay and whole-suite verify share that one implementation.
    handler: (deps: ToolDeps, args): Promise<FlowReplayResult> => replayNamedFlow(deps, args),
  },
  {
    name: ReticleTool.FLOW_VERIFY,
    description:
      'Replay EVERY saved flow (or a given subset) and return ONE consolidated suite verdict — the ' +
      'autonomous regression check to run after a build/change. Deterministic (no LLM per flow). ' +
      'Returns { status: pass|fail, total, passed, failed, summary, failures:[{ flow, verdict, ' +
      'whatChanged, whereInSource, nextAction }] } plus `flaky` (flows seen to pass AND fail on unchanged code) — passing flows are counted, only failures carry ' +
      'detail (the actionable fix). One call replaces N hand-driven replays.',
    inputSchema: {
      names: z
        .array(z.string())
        .optional()
        .describe('Flow names to verify. Omit to verify every saved flow.'),
      parallel: workerCountSchema
        .optional()
        .describe(
          'Run this many flows at once, each in its own isolated leased browser context (needs the browser pool). Clamped to the pool capacity and the flow count. Omit for the sequential single-tab run.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      status: z.string().describe('pass | fail'),
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      summary: z.string(),
      failures: z.array(z.unknown()),
      flaky: z
        .array(z.string())
        .optional()
        .describe(
          'Flows that have both passed and failed on UNCHANGED code — intermittent, not regressions. Omitted when none are known.',
        ),
      // Session-EXEMPT, so it does not inherit `sessionEnvelopeShape` — declare the one-shot human
      // feedback ask here or a validating profile strips it off the suite verdict.
      feedback_prompt: z.unknown().optional(),
    },
    handler: async (deps: ToolDeps, args): Promise<SuiteVerdict> => {
      const sessionId = asString(args['sessionId']);
      // "Replay all" means all of THIS app's flows (+ legacy), not every project's on a shared daemon.
      const projectId = sessionProjectId(deps, sessionId);
      const requested = Array.isArray(args['names'])
        ? args['names'].filter((n): n is string => 'string' === typeof n)
        : await flowsForSession(deps, projectId).flows.list(projectId);
      // verify:server — hand the whole suite to the hosted runner; it records the verification itself.
      const cloud = await resolveProjectCloud(deps.fs, deps.reticleRoot, homedir(), process.env);
      const server = await runServerVerify(deps, cloud, sessionId, requested);
      if (server !== null) return server;
      // PARALLEL: flows race the DOM only when they share ONE tab. Given the lease pool, each
      // flow gets its own isolated context, so a large suite finishes in interactive time. Opt-in via
      // `parallel`; a missing prerequisite (no pool, unknown app URL) falls back to the sequential path
      // rather than failing — a suite must always be runnable.
      //
      // NOTE: this applies even to a ONE-flow suite. Skipping leases for a single flow looked harmless
      // (no speedup to win) but silently downgraded an explicit `parallel` request to a shared-tab run,
      // so the flow inherited whatever state the previous run left behind — isolation is the point here,
      // not only concurrency.
      const parallelArg = asNumber(args['parallel']);
      const pool = deps.pool;
      const appUrl = leasableAppUrl(deps, sessionId);
      if (
        parallelArg !== undefined &&
        pool !== undefined &&
        appUrl !== undefined &&
        requested.length > 0
      ) {
        const concurrency = resolveConcurrency(requested.length, pool.capacity(), parallelArg);
        const outcomes = await mapWithConcurrency(requested, concurrency, async (flowName) => {
          const start = deps.now();
          const lease = await acquireLeasedSession(pool, deps.sessions, appUrl, projectId);
          try {
            const replay = await replayNamedFlow(deps, { flowName, sessionId: lease.sessionId });
            return { replay, durationMs: deps.now() - start };
          } finally {
            await lease.release().catch(() => undefined);
          }
        });
        const parallelRuns = await Promise.all(
          outcomes.map(async (o, i) => {
            const name = requested[i] ?? '';
            const replay =
              o.ok && o.value !== undefined ? o.value.replay : leaseFailureReplay(name, o.error);
            const loaded = await flowsForSession(deps, projectId)
              .flows.load(name, projectId)
              .catch(() => null);
            const flow = loaded !== null && loaded.ok ? loaded.value : undefined;
            return flow === undefined ? { replay } : { replay, flow };
          }),
        );
        const timed: TimedReplay[] = outcomes.map((o, i) => ({
          replay:
            o.ok && o.value !== undefined
              ? o.value.replay
              : leaseFailureReplay(requested[i] ?? '', o.error),
          durationMs: o.ok && o.value !== undefined ? o.value.durationMs : 0,
        }));
        const flaky = await recordSuiteFlakes(deps.fs, deps.reticleRoot, parallelRuns);
        await persistAndSyncVerificationRun(deps, timed, projectId);
        const verdict = buildSuiteVerdict(parallelRuns);
        return flaky.length > 0 ? { ...verdict, flaky: [...flaky] } : verdict;
      }
      // The flow FILE travels with each replay so the verdict can tell a green that verified
      // something from a green that could never have gone red. Without it the suite reported "all 1
      // flow pass" for a flow with no steps at all.
      const runs: { replay: FlowReplayResult; flow?: FlowFile }[] = [];
      const timed: TimedReplay[] = [];
      // Sequential default: every flow replays against the same live session, so they must not overlap.
      for (const flowName of requested) {
        const start = deps.now();
        const replay = await replayNamedFlow(deps, { flowName, sessionId });
        const loaded = await flowsForSession(deps, projectId)
          .flows.load(flowName, projectId)
          .catch(() => null);
        const flow = loaded !== null && loaded.ok ? loaded.value : undefined;
        runs.push(flow === undefined ? { replay } : { replay, flow });
        timed.push({ replay, durationMs: deps.now() - start });
      }
      // The flake ledger the CLI gate already keeps — see FlakeStore. It was only ever written by
      // `reticle flow` on the command line, so an AGENT running this tool a hundred times learned
      // nothing about which flows are intermittent. Same product, same ledger, two surfaces, and the
      // one an agent uses was the blind half.
      const flaky = await recordSuiteFlakes(deps.fs, deps.reticleRoot, runs);
      // Emit the consolidated run artifact (Runs tab) + best-effort cloud push. Never blocks the verdict.
      await persistAndSyncVerificationRun(deps, timed, projectId);
      const verdict = buildSuiteVerdict(runs);
      // A flow that has both passed and failed on UNCHANGED code is a different thing from a
      // regression, and an agent that cannot tell them apart either chases a ghost or ignores a real
      // break. Present only when the ledger has seen enough runs to say so.
      return flaky.length > 0 ? { ...verdict, flaky: [...flaky] } : verdict;
    },
  },
  {
    name: ReticleTool.FLOW_SAVE_RECORDED,
    description:
      'Persist the HUMAN-recorded flow from the live tab. The recorder toolbar compiles the ' +
      "human's real clicks/inputs into a semantically anchored FlowFile in-page and emits it; this " +
      'tool reads the LATEST recorded-flow from the session and writes it to .reticle/flows/<name>.json ' +
      '(no recompilation — the browser already resolved every anchor). Pass `name` to override the ' +
      'recorded name. Returns { name, stepCount, degraded, empty } or { error, code } (code ' +
      'flow_no_recorded when no recording is present).',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z
        .string()
        .optional()
        .describe(
          'Override the flow name embedded in the recorded flow. Omit to use the recorder-assigned name.',
        ),
      intent: z
        .string()
        .optional()
        .describe(
          'What this flow is FOR, in prose: which user does what, and what should become true. The recorder captures clicks, not goals, so this is the only place the goal can come from. Without it the flow still saves, but the day it goes red the report can only name the step that broke.',
        ),
      ...{
        sessionId: z
          .string()
          .optional()
          .describe(
            'Active session ID from reticle_sessions. Omit when only one browser session is open.',
          ),
      },
    },
    // Match the handler's actual return (SaveSummary { name, stepCount, degraded, empty } or
    // { error, code }) — the prior `flowName` key silently stripped the real `name`/`empty` fields.
    outputSchema: {
      name: z.string().optional(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
      empty: z.boolean().optional(),
      intentGap: INTENT_GAP_FIELD,
      error: z.string().optional(),
      code: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const recorded = latestRecordedFlow(session.eventsSince(0));
      if (recorded === undefined) {
        return {
          error: 'no human recording on this tab — start the recorder toolbar and click Stop first',
          code: RecordedSaveError.NO_RECORDED_FLOW,
        };
      }
      const override = asString(aliasParam(args, 'flowName', ['flow'])['flowName']);
      const intent = asString(args['intent']);
      const flow: FlowFile = {
        ...recorded.flow,
        ...(override === undefined ? {} : { name: override }),
        ...(intent === undefined ? {} : { intent }),
      };
      // The store stamps the project into the file AND routes it to the per-project subdir (a shared
      // daemon serves many apps), so location and content agree from one source of truth.
      const emptyRecorded = emptyFlowRefusal(flow.steps.length, flow.name);
      if (emptyRecorded !== undefined) return emptyRecorded;
      // Resolved like every other path now. This save used to go to the daemon's root while the
      // recorded-flow save resolved per session, so where a flow landed depended on which tool wrote
      // it — and the pair that disagreed were the two ways to save the same thing.
      const res = await flowsForSession(deps, session.projectId).flows.saveFlow(
        flow,
        session.projectId,
      );
      if (!res.ok) return { error: flowErrorMessage(res.code, res.detail), code: res.code };
      // If logged in to Reticle, mirror the saved flow to the team's regression suite. Best-effort
      // and non-blocking: the flow is already on disk, so a sync failure never fails the save.
      void syncSavedFlowToCloud(deps, flow, session.projectId);
      // Return the SaveSummary as-is ({ name, stepCount, degraded, empty }) — the outputSchema
      // declares `name`, so the old `flowName` key was silently stripped by schema-strict clients.
      return res.value;
    },
  },
  {
    name: ReticleTool.FLOW_HEAL,
    description:
      'Self-healing replay. Re-runs reticle_flow_replay; on testid DRIFT computes confidence-scored ' +
      'nearest-match rebind PROPOSALS. With apply:false (default) returns the proposed diff WITHOUT ' +
      'writing. With apply:true, writes the confident rebind(s) back into .reticle/flows/<name>.json and ' +
      'returns what changed — never silently. Before writing, apply re-replays the healed flow and ' +
      're-asserts its success consequence: if the rebound locator resolves but the consequence no ' +
      'longer fires, the write is REFUSED (status:consequence_broken) — it heals the locator, never ' +
      'the intent. A drift with no proposal above the confidence floor is status:unhealable (file ' +
      'untouched). Returns { name, status: healed|drift|unhealable|consequence_broken|' +
      'nothing_to_heal|error, applied, proposals[], changed[], message }.',
    inputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z.string().describe('Flow file name to heal (from reticle_flow{action:"list"}).'),
      apply: z.boolean().optional(),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this heal replay only.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      flow: z
        .string()
        .optional()
        .describe('Alias for `flowName` (the name reticle_annotate uses).'),
      flowName: z.string(),
      status: z.string(),
      applied: z.boolean(),
      proposals: z.array(z.unknown()),
      changed: z.array(z.unknown()),
      message: z.string(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    },
    handler: (deps: ToolDeps, args) =>
      healFlow(deps, args).then(({ name, ...rest }) => ({ flowName: name, ...rest })),
  },
];
