/**
 * `reticle_act_sequence` — several actions compiled into one round trip.
 *
 * Split out of `act-tools.ts` when that file passed the 1000-line backstop. A tool seam rather than
 * an arbitrary one: its two neighbours drive ONE action and grade its consequence, while this one
 * compiles a list of steps and runs them inside a single action window, reporting per step.
 *
 * It keeps its own `beginAction` — the dispatch and the attribution window that must wrap it stay in
 * the same file, which is the property `dispatch-attribution.test.ts` enforces. An earlier attempt
 * split the shared `actCommand` helper out instead, which separated the two and that guard caught it.
 */

import { z } from 'zod';
import { timeoutMsSchema } from './numeric-bounds.js';
import { compileSequenceStep } from '../flows/replay.js';
import { ReticleTool } from './tool-names.js';
import { healthEnvelope } from '../session/session-health.js';
import { pausedShortCircuit, pausedOutputShape, withControl } from '../session/control-envelope.js';
import { asRecord, sessionIdFromArgs } from './tools-helpers.js';
import { describeStepResult, runStepWithStaleRetry } from './act-sequence-retry.js';
import { assertSequenceSteps } from './act-preflight.js';
import { type ToolDef, sessionIdShape } from './tool-kit.js';
import { actCommand } from './act-tools.js';
// resolveActTarget moved out of act-tools into its own module on this branch; #706 was written
// against the older layout where act-tools re-exported it.
import { resolveActTarget } from './act-target.js';

export const ACT_SEQUENCE_TOOL: ToolDef = {
  name: ReticleTool.ACT_SEQUENCE,
  // The example is required for a core tool, and this one carries weight: the measured loop it
  // replaces is literally a login form driven as three separate reticle_act calls (98 clicks and
  // 21 fills inside looping sessions, 2026-08-10/11). Showing fill -> fill -> click is showing the
  // exact shape an agent otherwise spends three round trips on.
  example: {
    steps: [
      { ref: 'e12', action: 'fill', args: { value: 'a@b.com' } },
      { ref: 'e13', action: 'fill', args: { value: 'hunter2' } },
      { ref: 'e14', action: 'click' },
    ],
  },
  description:
    'Run multiple actions in order (fill -> fill -> submit) in ONE round-trip. Prefer this over repeating reticle_act for a multi-step journey, then assert its consequence once. Returns per-step effects[] (see reticle_act).',
  inputSchema: {
    steps: z
      .array(z.record(z.unknown()))
      .describe(
        'Ordered list of { ref | target, action, args? } objects. Each step is equivalent to one reticle_act call — give `ref` from a snapshot/query, or `target` ({ testid } | { label } | { role, name } | { text }) to resolve in this call. Put confirmDangerous:true in a destructive step args object.',
      ),
    timeout_ms: timeoutMsSchema
      .optional()
      .describe(
        'Per-step timeout in milliseconds. Default: 8000. Each step gets this budget independently.',
      ),
    ...sessionIdShape,
  },
  outputSchema: {
    since: z.number(),
    dispatched: z.boolean(),
    completed: z.number(),
    stalled_at: z.number().optional(),
    steps: z.array(z.record(z.unknown())).optional(),
    result: z.unknown().optional(),
    session: z
      .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
      .optional(),
    // Short-circuits to pausedShortCircuit while paused — declare its fields (drained-once guidance).
    ...pausedOutputShape,
  },
  handler: async (deps, args) => {
    const session = deps.sessions.resolve(sessionIdFromArgs(args));
    const paused = pausedShortCircuit(session);
    if (paused !== undefined) return paused;
    const since = session.elapsed();
    session.beginAction(ReticleTool.ACT_SEQUENCE, asRecord(args));
    try {
      const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
      assertSequenceSteps(inputSteps);
      const perStepTimeout = 'number' === typeof args['timeout_ms'] ? args['timeout_ms'] : 8000;
      const stepResults: Record<string, unknown>[] = [];
      let stalledAt: number | undefined;

      // DIVERGENCE: live sends N individual ACT commands (for per-step timeout + progress);
      // replay sends one batched ACT_SEQUENCE command (flows/replay.ts:294). A bug in either is
      // invisible from the other — cover both when changing sequence semantics.
      for (let i = 0; i < inputSteps.length; i++) {
        const step = asRecord(inputSteps[i]);
        try {
          // One retry when the ref went stale under a re-render — see act-sequence-retry.ts.
          // Resolve `target` with the same helper reticle_act uses, then dispatch by ref. Passing
          // the unresolved step through used to send `ref: undefined` and the browser blamed a
          // stale empty ref — the caller went looking for a re-render instead of a missing locator.
          const outcome = await runStepWithStaleRetry(
            async () => {
              const resolved = await resolveActTarget(session, step);
              if ('error' === resolved.kind) return { ok: false, error: resolved.message };
              return actCommand(
                deps,
                session,
                { ref: resolved.ref, action: step['action'], args: step['args'] ?? {} },
                perStepTimeout,
              );
            },
            session,
            since,
            perStepTimeout,
          );
          if (!outcome.ok) {
            stalledAt = i;
            stepResults.push({
              ref: step['ref'],
              action: step['action'],
              dispatched: false,
              error: outcome.error ?? 'step failed',
            });
            break;
          }
          stepResults.push(describeStepResult(step, asRecord(outcome.result)));
        } catch (err: unknown) {
          stalledAt = i;
          stepResults.push({
            ref: step['ref'],
            action: step['action'],
            dispatched: null,
            timedOut: true,
            error: err instanceof Error ? err.message : 'step timed out',
          });
          break;
        }
      }

      const completed = stalledAt ?? inputSteps.length;
      if (completed > 0) {
        session.lastAct.markActed(since, undefined, undefined);
      }
      if (deps.recordings.active().length > 0 && stalledAt === undefined) {
        deps.recordings.capture(
          compileSequenceStep(args, { count: inputSteps.length, steps: stepResults }),
        );
      }
      return withControl(session, {
        since,
        dispatched: completed > 0,
        completed,
        ...(stalledAt !== undefined ? { stalled_at: stalledAt } : {}),
        steps: stepResults,
        ...healthEnvelope(session),
      });
    } finally {
      session.finishAction();
    }
  },
};
