/**
 * What a Stop hook shows the human when the gate blocks.
 *
 * A hook runs at the moment an agent says it is finished, and whatever it prints is the last thing
 * anybody reads. The gate's normal output is one long JSON line built for CI to parse; pasted into
 * a terminal at the end of a session it is a wall of names with no instruction attached.
 *
 * So the hook path gets prose. It has to answer three things in the order a person asks them: what
 * is not verified, why that matters right now, and what to do about it — including how to proceed
 * anyway, because a gate with no honest escape hatch gets disabled entirely and then protects
 * nothing.
 */

import { GateExit } from './gate-exit.js';

/** Named so a reader of the hook output knows the flag is real and not a suggestion. */
export const GATE_SKIP_ENV = 'RETICLE_SKIP_GATE';

const MAX_NAMED = 5;

interface GateHookInput {
  /** Flows the changed files touch that have no passing artifact. */
  uncovered: readonly string[];
  /** Flows held back as flaky — reported, never counted as a pass. */
  quarantined: readonly string[];
  /** Assertions that dropped from a real consequence to a fakeable one. */
  downgraded: readonly string[];
  /** Flows whose coverage was deleted while their files changed. */
  deleted: readonly string[];
}

/** A short list, then a count — a hook that prints forty names is a hook people turn off. */
function name(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMED).join(', ');
  return list.length > MAX_NAMED ? `${shown} (+${String(list.length - MAX_NAMED)} more)` : shown;
}

/**
 * The message, or undefined when there is nothing to say.
 *
 * `NOTHING_TO_CHECK` returns undefined on purpose: a project that has not recorded a flow yet is
 * every project on its first day, and blocking there would make the first experience of Reticle an
 * agent that cannot stop. The gate still reports it — this decides only whether a HUMAN is
 * interrupted.
 */
export function gateHookMessage(exit: number, input: GateHookInput): string | undefined {
  if (GateExit.FAIL !== exit) return undefined;
  const lines: string[] = ['Reticle: this change is not verified.'];
  if (input.uncovered.length > 0) lines.push(`  no passing run covers: ${name(input.uncovered)}`);
  if (input.downgraded.length > 0)
    lines.push(
      `  assertions weakened to something fakeable: ${name(input.downgraded)} — a check that cannot fail is not a check`,
    );
  if (input.deleted.length > 0)
    lines.push(`  coverage deleted while its files changed: ${name(input.deleted)}`);
  if (input.quarantined.length > 0)
    lines.push(`  held back as flaky, so proving nothing: ${name(input.quarantined)}`);
  lines.push('');
  lines.push('  Replay them: npx @reticlehq/server verify <your app url>');
  lines.push(`  Or proceed anyway: ${GATE_SKIP_ENV}=1 — it is recorded, not silent.`);
  return lines.join('\n');
}
