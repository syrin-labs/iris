import { PredicateKind } from '@reticlehq/core';
/**
 * The assertion the agent MADE, in the shape a saved flow can keep.
 *
 * `reticle_act_and_wait { until }` is how agents assert — 12 of 14 calls in a day of telemetry
 * carried an `until`. `compileActStep` recorded only the ACTION, so a flow saved after an asserted
 * drive came back graded `assertion-free`: "performs actions but asserts no observable consequence —
 * it will pass even if the feature is broken." The agent had already said what success meant;
 * Reticle discarded it and then warned the agent that the flow asserts nothing.
 *
 * That is the regression-suite story failing at its last step. "Record once, verify forever" is only
 * worth anything if the recorded flow can go RED, and locally 32 of 39 saved flows cannot.
 *
 * The inverse of `successToPredicate`. Only the kinds FlowExpect can express are carried: `settled`
 * is a wait rather than a claim, and `route`/`animation`/`anyOf`/`not` have no representation at all.
 * Inventing one would write an assertion into the file that the agent never made, which is worse
 * than recording none — a flow that asserts something nobody chose is a false green with extra steps.
 */
import type { FlowExpect } from '@reticlehq/core';
import type { Predicate } from '../events/predicate.js';

/** Merge two partial expectations; later keys win only where the earlier one said nothing. */
function merge(into: FlowExpect, from: FlowExpect): FlowExpect {
  return { ...from, ...into };
}

export function predicateToExpect(predicate: Predicate): FlowExpect | undefined {
  switch (predicate.kind) {
    case PredicateKind.SIGNAL: {
      if (predicate.name === undefined) return undefined;
      const signal: FlowExpect = { signal: predicate.name };
      if (predicate.dataMatches !== undefined) signal.signalData = predicate.dataMatches;
      if (predicate.count !== undefined) signal.signalCount = predicate.count;
      return signal;
    }
    case PredicateKind.NET: {
      const net: NonNullable<FlowExpect['net']> = {};
      if (predicate.method !== undefined) net.method = predicate.method;
      if (predicate.urlContains !== undefined) net.urlContains = predicate.urlContains;
      if (predicate.status !== undefined) net.status = predicate.status;
      if (predicate.count !== undefined) net.count = predicate.count;
      return 0 === Object.keys(net).length ? undefined : { net };
    }
    case PredicateKind.CONSOLE: {
      // `contains` has no representation in FlowExpect.console (core keeps `level` and `absent`
      // and nothing else). Copying the rest through anyway would record an assertion the agent
      // never made: {console, level:'warn', contains:'no-op', absent:true} would save "no warn
      // entries at all", a false red on any unrelated warning, and in the presence direction it
      // saves a strictly weaker claim than the one chosen. This file's own rule applies: record
      // nothing rather than something different, so the flow stays assertion-free there instead.
      if (predicate.contains !== undefined) return undefined;
      const console_: NonNullable<FlowExpect['console']> = {};
      if (predicate.level !== undefined) console_.level = predicate.level;
      if (predicate.absent !== undefined) console_.absent = predicate.absent;
      return 0 === Object.keys(console_).length ? undefined : { console: console_ };
    }
    case PredicateKind.ELEMENT: {
      const element: NonNullable<FlowExpect['element']> = {};
      if (predicate.query.testid !== undefined) element.testid = predicate.query.testid;
      if (predicate.query.role !== undefined) element.role = predicate.query.role;
      if (predicate.query.name !== undefined) element.name = predicate.query.name;
      return 0 === Object.keys(element).length ? undefined : { element };
    }
    case PredicateKind.STATE: {
      const state: NonNullable<FlowExpect['state']> = { path: predicate.path };
      if (predicate.store !== undefined) state.store = predicate.store;
      if (predicate.equals !== undefined) state.equals = predicate.equals;
      return { state };
    }
    case PredicateKind.ALL_OF: {
      // `settled` members drop out on their own by returning undefined.
      let combined: FlowExpect | undefined;
      for (const part of predicate.predicates) {
        const expect = predicateToExpect(part);
        if (expect === undefined) continue;
        combined = combined === undefined ? expect : merge(combined, expect);
      }
      return combined;
    }
    default:
      // settled | route | animation | anyOf | not — nothing FlowExpect can say honestly.
      return undefined;
  }
}

/**
 * The subset a REPLAY actually enforces.
 *
 * The rule has never changed: never write an assertion into a flow file that nothing evaluates. A
 * flow reporting `grade: "asserted"` while its assertion is read by no one is a false green, in the
 * feature whose entire purpose is preventing them.
 *
 * What changed is the SET. This kept only `element.testid` and `state`, because for a long time
 * those were the only kinds replay checked — and the note here said lifting it "requires replay to
 * evaluate them per step". Replay now does exactly that: `assertStepExpect` compiles every
 * remaining kind through `successToPredicate` and waits on it. The condition was met and the filter
 * was not updated, so the two drifted.
 *
 * That drift had a cost, and it fell on the agent. `reticle_act_and_wait { until }` IS the agent
 * saying what success means, and `net` is overwhelmingly what it says. Every one of those was
 * discarded at capture, so an agent-recorded flow reached disk assertion-free BY CONSTRUCTION and
 * `reticle_verify` then correctly called it `unverifiable` — the record → save → verify path
 * completing all the way to a run that could never be a pass. Found by driving it.
 *
 * The list below is exactly what `successToPredicate` reads, including an element located by
 * role or name. A testid is also asserted directly against the DOM by the step runner. Anything
 * it cannot compile is still dropped.
 */
export function enforcedOnReplay(expect: FlowExpect | undefined): FlowExpect | undefined {
  if (expect === undefined) return undefined;
  const kept: FlowExpect = {};
  // The step runner asserts a testid against the live DOM before the predicate engine. Role and
  // name are not that path: successToPredicate compiles them, and dropping them here made a
  // recorded `until` by button name vanish so the saved flow could not go red.
  const element = expect.element;
  if (
    undefined !== element &&
    (undefined !== element.testid || undefined !== element.role || undefined !== element.name)
  ) {
    kept.element = element;
  }
  // Everything `successToPredicate` can compile. Replay evaluates EVERY kind of expect through it
  // (see assertStepExpect); this list is what that function actually reads.
  if (expect.state !== undefined) kept.state = expect.state;
  if (expect.signal !== undefined) kept.signal = expect.signal;
  if (expect.signalData !== undefined) kept.signalData = expect.signalData;
  if (expect.signalCount !== undefined) kept.signalCount = expect.signalCount;
  if (expect.net !== undefined) kept.net = expect.net;
  if (expect.console !== undefined) kept.console = expect.console;
  return 0 === Object.keys(kept).length ? undefined : kept;
}
