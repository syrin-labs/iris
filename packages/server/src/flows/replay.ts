import { REDACTED_FILL } from './flows.js';
import {
  DANGEROUS_ACTION_CONFIRM_ARG,
  ReticleCommand,
  QueryBy,
  type CommandResult,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { predicateToExpect, enforcedOnReplay } from './predicate-to-expect.js';
import { PredicateSchema } from '../events/predicate.js';
import type { RecordedStep, CompiledProgram } from './recordings.js';
import type { Session } from '../session/session.js';
import { asString, asRecord } from '../tools/tools-helpers.js';

/**
 * The note attached when a testid resolves to multiple live elements (the first match is used).
 * Shared by BOTH replay engines (replayProgram + flow-replay's step runner) so the phrasing — which
 * an agent reads to judge a brittle locator — can never drift between them.
 */
export function ambiguousTestidNote(value: string): string {
  return `ambiguous testid '${value}', used first match`;
}

/**
 * The live element refs a QUERY resolved to (empty when it failed or matched nothing). Shared by BOTH
 * replay engines (replayProgram + flow-replay's step runner) so element extraction — the core of anchor
 * resolution — can't drift between them.
 */
export function queryRefs(result: CommandResult): string[] {
  if (!result.ok) return [];
  const payload = asRecord(result.result);
  const elements = Array.isArray(payload['elements']) ? payload['elements'] : [];
  return elements.map((e) => asString(asRecord(e)['ref']) ?? '').filter((r) => r.length > 0);
}

/**
 * The environment variable that supplies one redacted field.
 *
 * Named after the field so it is guessable from the flow alone: `auth-password` is read from
 * `RETICLE_SECRET_AUTH_PASSWORD`. A scheme requiring a lookup table would mean the flow says a
 * value is missing and cannot say what to set.
 */
const secretEnvKey = (field: string): string =>
  `RETICLE_SECRET_${field.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;

/**
 * A destructive-action confirmation is one-shot and must never persist into a recording.
 *
 * This is also where a REDACTED fill is supplied back. Stripping credentials out of a git-checked
 * flow is only half a fix: sign-in still has to replay, and a flow that drifts at step two forever
 * because its own password was removed is a flow nobody keeps — along with everything behind the
 * login it guards. The value comes from the environment, the one place a secret can live that is
 * neither the customer's repository nor our database.
 *
 * Left as the PLACEHOLDER when nothing supplies it, rather than blanked. The replay then fails at
 * the login form with `<redacted: supply at replay>` visible in the field, which names its own fix;
 * an empty box fails identically and tells the reader nothing.
 */
export function replayActionArgs(
  value: unknown,
  confirmDangerous = false,
  field?: string,
): Record<string, unknown> {
  const args = { ...asRecord(value) };
  delete args[DANGEROUS_ACTION_CONFIRM_ARG];
  if (confirmDangerous) args[DANGEROUS_ACTION_CONFIRM_ARG] = true;
  if (REDACTED_FILL === args['value'] && field !== undefined) {
    const supplied = process.env[secretEnvKey(field)];
    if (supplied !== undefined && supplied.length > 0) args['value'] = supplied;
  }
  return args;
}

/** The element's source location from an action result, when the framework stamped one. */
function sourceFromResult(res: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = asRecord(res['source']);
  if (typeof source['file'] !== 'string' || typeof source['line'] !== 'number') return undefined;
  const out: Record<string, unknown> = { file: source['file'], line: source['line'] };
  if ('number' === typeof source['column']) out['column'] = source['column'];
  return out;
}

/**
 * Capture an act into every in-flight recording, or do nothing when none is running.
 *
 * Every tool that drives the page must call this. reticle_act_and_wait did not, which is the tool
 * the documented agent recipe drives with — so "record start -> drive -> record stop -> flow_save"
 * saved a flow with zero steps.
 */
export function captureAct(
  recordings: { active: () => string[]; capture: (step: RecordedStep) => void },
  args: Record<string, unknown>,
  res: unknown,
): void {
  if (0 === recordings.active().length) return;
  const step = compileActStep(args, res);
  // Keep the assertion the agent actually made. `act_and_wait { until }` IS the agent saying what
  // success means — 12 of 14 calls in a day carried one — and dropping it produced a flow graded
  // "assertion-free: it will pass even if the feature is broken", which is the regression-suite
  // story failing at its last step. Only kinds FlowExpect can express survive; see
  // predicate-to-expect.ts.
  const until = args['until'] ?? args['predicate'];
  if (until !== undefined) {
    const parsed = PredicateSchema.safeParse(until);
    // Only what a replay actually CHECKS — recording an unenforced assertion would grade the flow
    // "asserted" while nothing verifies it, which is a false green in the feature built to prevent
    // them. See enforcedOnReplay.
    const expect = parsed.success ? enforcedOnReplay(predicateToExpect(parsed.data)) : undefined;
    if (expect !== undefined) step.expect = expect;
  }
  recordings.capture(step);
}

/**
 * Compile a single reticle_act invocation into a normalized RecordedStep using the action result. Anchor
 * priority mirrors synthesizeAnchor: a data-testid is the gold standard; failing that, the element's
 * component identity / source location (the AUTO-ANCHOR) keeps the step STABLE instead of degrading to
 * a volatile ref. Only when neither is available is the step ref-bound (in-session only).
 */
export function compileActStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const { args: compiled, stable } = compileAnchorArgs(
    asRecord(res),
    asString(args['ref']) ?? '',
    asString(args['action']) ?? '',
    replayActionArgs(args['args']),
  );
  return { tool: ReticleTool.ACT, stable, args: compiled };
}

/**
 * The ONE anchor chooser: testid (gold) > role+name (identifies an instance) > component/source
 * (the JSX site) > a volatile ref (in-session only).
 *
 * It is shared because it was not: `compileSequenceStep` understood only a testid, so every
 * act_sequence sub-step on a testid-less app compiled to a ref, saved as the degraded `unresolved`
 * sentinel, and drifted on every replay — while a single act on the very same element compiled a
 * perfectly stable anchor.
 */
function compileAnchorArgs(
  r: Record<string, unknown>,
  ref: string,
  action: string,
  actArgs: Record<string, unknown>,
): { args: Record<string, unknown>; stable: boolean } {
  const testid = asString(r['testid']);
  const source = sourceFromResult(r);
  if (testid !== undefined) {
    // The testid anchors the step; source rides along purely so a failure can name a file. Carrying
    // both was the point of separating anchor from provenance at capture time.
    const testidArgs: Record<string, unknown> = {
      by: QueryBy.TESTID,
      value: testid,
      action,
      args: actArgs,
    };
    if (source !== undefined) testidArgs['source'] = source;
    return { args: testidArgs, stable: true };
  }
  // Role + NAME before component: a component/source anchor names the JSX site, so every row's copy
  // of the same control collapses onto it. The accessible name separates them, and it is also the
  // only stable anchor an app with no testids has. Measured: three rows' checkboxes compiled to one
  // identical component anchor and replayed onto a single element.
  const role = asString(r['role']);
  const name = asString(r['name']);
  if (role !== undefined && name !== undefined) {
    const roleArgs: Record<string, unknown> = {
      by: QueryBy.ROLE,
      value: role,
      name,
      action,
      args: actArgs,
    };
    if (source !== undefined) roleArgs['source'] = source;
    return { args: roleArgs, stable: true };
  }
  const component = asString(r['component']);
  if (component !== undefined || source !== undefined) {
    const componentArgs: Record<string, unknown> = { by: QueryBy.COMPONENT, action, args: actArgs };
    if (component !== undefined) componentArgs['component'] = component;
    if (source !== undefined) componentArgs['source'] = source;
    return { args: componentArgs, stable: true };
  }
  return { args: { ref, action, args: actArgs }, stable: false };
}

/**
 * Compile an reticle_act_sequence invocation, normalizing each sub-step through the SAME anchor
 * priority a single act uses (see compileAnchorArgs) — not testid-or-nothing, which is what made
 * every sequence unreplayable on an app without testids.
 */
export function compileSequenceStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
  const resolved = Array.isArray(asRecord(res)['steps'])
    ? (asRecord(res)['steps'] as unknown[])
    : [];
  let stable = inputSteps.length > 0;
  const subSteps = inputSteps.map((raw, i) => {
    const step = asRecord(raw);
    const compiled = compileAnchorArgs(
      asRecord(resolved[i]),
      asString(step['ref']) ?? '',
      asString(step['action']) ?? '',
      replayActionArgs(step['args']),
    );
    if (!compiled.stable) stable = false;
    return compiled.args;
  });
  return { tool: ReticleTool.ACT_SEQUENCE, stable, args: { steps: subSteps } };
}

/**
 * Resolve a recorded step's element to a live ref, by whichever anchor the compiler chose.
 *
 * Every anchor the compiler can EMIT must be resolvable here. It could not be: `compileActStep`
 * emits `by: component` steps (and marks them `stable: true`), and this function only understood
 * `testid` — so every component-anchored step failed with "no testid or ref to resolve", and the
 * `stable` flag on it was a claim the replayer could not honour. Measured on a console with 5 steps:
 * the 2 with testids replayed, the 3 without were unreplayable, and the flow reported ok:false at
 * the first of them.
 */
async function resolveRef(
  session: Session,
  step: {
    by?: unknown;
    value?: unknown;
    ref?: unknown;
    name?: unknown;
    component?: unknown;
    source?: unknown;
  },
): Promise<{ ref: string; note?: string }> {
  const by = asString(step.by);
  const value = asString(step.value);
  if (by === QueryBy.TESTID && value !== undefined) {
    const result = await session.command(ReticleCommand.QUERY, { by, value });
    if (!result.ok) throw new Error(result.error ?? 'query failed');
    const refs = queryRefs(result);
    const ref = refs[0];
    if (ref === undefined) throw new Error(`testid '${value}' did not resolve in current page`);
    return refs.length > 1 ? { ref, note: ambiguousTestidNote(value) } : { ref };
  }
  // Role + accessible NAME: the anchor that distinguishes one row's control from another's, which
  // neither a testid-less app nor a shared JSX source location can do.
  if (by === QueryBy.ROLE && value !== undefined) {
    const name = asString(step.name);
    const query: Record<string, unknown> = { by, value, ...(name === undefined ? {} : { name }) };
    const result = await session.command(ReticleCommand.QUERY, query);
    if (!result.ok) throw new Error(result.error ?? 'query failed');
    const ref = queryRefs(result)[0];
    if (ref === undefined) {
      throw new Error(`${value} named '${String(name)}' did not resolve in current page`);
    }
    return { ref };
  }
  if (by === QueryBy.COMPONENT) {
    const component = asString(step.component);
    const source = step.source;
    const query: Record<string, unknown> = {
      by,
      ...(component === undefined ? {} : { component, value: component }),
      ...(source === undefined ? {} : { source }),
    };
    const result = await session.command(ReticleCommand.QUERY, query);
    if (!result.ok) throw new Error(result.error ?? 'query failed');
    const refs = queryRefs(result);
    const ref = refs[0];
    if (ref === undefined) {
      throw new Error(`component '${String(component)}' did not resolve in current page`);
    }
    // A source location identifies a JSX SITE, not an instance: one `<input>` inside a row renders
    // once per row and every one of them shares this anchor. Saying so is the difference between a
    // replay that repeated itself and a replay that reports it might have.
    return refs.length > 1
      ? {
          ref,
          note: `component anchor matched ${String(refs.length)} elements — replayed the first`,
        }
      : { ref };
  }
  const ref = asString(step.ref);
  if (ref === undefined || 0 === ref.length) {
    throw new Error('step has no resolvable anchor (testid, role+name, component) and no ref');
  }
  return { ref, note: 'replayed by stale ref (not portable across sessions)' };
}

interface ReplayStepResult {
  tool: string;
  ok: boolean;
  error?: string;
  note?: string;
}

/** Re-execute every step of a compiled program in order, stopping at the first failure. */
export async function replayProgram(
  session: Session,
  program: CompiledProgram,
  confirmDangerous = false,
): Promise<ReplayStepResult[]> {
  const results: ReplayStepResult[] = [];
  for (const step of program.steps) {
    try {
      if (step.tool === ReticleTool.ACT_SEQUENCE) {
        const subs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
        const notes: string[] = [];
        const liveSteps: { ref: string; action: string; args: Record<string, unknown> }[] = [];
        for (const raw of subs) {
          const sub = asRecord(raw);
          const { ref, note } = await resolveRef(session, sub);
          if (note !== undefined) notes.push(note);
          liveSteps.push({
            ref,
            action: asString(sub['action']) ?? '',
            args: replayActionArgs(sub['args'], confirmDangerous),
          });
        }
        // Attribute the step's effects to the step: unattributed effects are learned as ambient
        // churn on the regions the flow exercises, which teaches the settle oracle to ignore them.
        session.beginAction(ReticleTool.REPLAY, { steps: liveSteps.length });
        let r;
        try {
          // DIVERGENCE: replay sends one batched ACT_SEQUENCE command to the browser;
          // live (tools/act-tools.ts) sends N individual ACT commands for per-step timeout +
          // progress. A bug in either is invisible from the other.
          r = await session.command(ReticleCommand.ACT_SEQUENCE, { steps: liveSteps });
        } finally {
          session.finishAction();
        }
        results.push(buildResult(step.tool, r.ok, r.error, notes));
        if (!r.ok) break;
      } else {
        const { ref, note } = await resolveRef(session, step.args);
        session.beginAction(ReticleTool.REPLAY, { ref });
        let r;
        try {
          r = await session.command(ReticleCommand.ACT, {
            ref,
            action: asString(step.args['action']) ?? '',
            args: replayActionArgs(step.args['args'], confirmDangerous),
          });
        } finally {
          session.finishAction();
        }
        results.push(buildResult(step.tool, r.ok, r.error, note !== undefined ? [note] : []));
        if (!r.ok) break;
      }
    } catch (e) {
      results.push({
        tool: step.tool,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
  }
  return results;
}

function buildResult(
  tool: string,
  ok: boolean,
  error: string | undefined,
  notes: string[],
): ReplayStepResult {
  const base: ReplayStepResult = { tool, ok };
  if (!ok) base.error = error ?? 'command failed';
  if (notes.length > 0) base.note = notes.join('; ');
  return base;
}
