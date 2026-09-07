/**
 * WHERE did the turns go? Asked of a recorded call sequence, mechanically.
 *
 * Every cost fix this release was found the same way: read a call sequence by hand, notice a shape,
 * write one sentence at the point of decision, measure. That found the assert tail (three, three
 * and NINE consecutive `reticle_assert` calls on a healthy app) and it found the looking tail
 * (`snapshot x5 + query x5` where a competitor spent three). Both were real and both halved
 * something. Neither scales: it needs somebody to stare at the right run on the right day.
 *
 * Turns are the dominant cost term — 2x the turns against 1.45x the per-turn schema — so the thing
 * worth automating is not "how big is the payload" but "which turns did not need to happen".
 *
 * These are SHAPES, not verdicts. A run of identical calls can be a poll the app forced; looking
 * three times can be three different questions. The output names candidates and counts them; it
 * never says a call was wasted, because only the transcript can say that and this reads names.
 */

/** Reads as a look rather than a change. Arm-agnostic: matched on shape, not on our vocabulary. */
const LOOKS =
  /snapshot|query|read|inspect|observe|state|console|network|screenshot|evaluate|list_files/i;
/** Produces a verdict or moves the app. */
const ACTS =
  /act|click|type|fill|press|submit|navigate|wait_for|write_file|assert|run_agent_browser/i;
/** The agent went back to the catalogue mid-run — it was looking for a capability, not using one. */
const DISCOVERY = /tools$|skills/i;

/** Longest run of the same tool name, and every run of 3+. */
function repeats(calls) {
  const runs = [];
  let i = 0;
  while (i < calls.length) {
    let j = i;
    while (j + 1 < calls.length && calls[j + 1] === calls[i]) j++;
    if (j - i + 1 >= 3) runs.push({ tool: calls[i], length: j - i + 1 });
    i = j + 1;
  }
  return runs;
}

/** Stretches of consecutive looking with no act between them. */
function lookStreaks(calls) {
  const streaks = [];
  let run = 0;
  for (const c of calls) {
    if (LOOKS.test(c) && !ACTS.test(c)) run++;
    else {
      if (run >= 3) streaks.push(run);
      run = 0;
    }
  }
  if (run >= 3) streaks.push(run);
  return streaks;
}

/**
 * `{ calls, patterns, recoverable }`.
 *
 * `recoverable` is the count of turns these shapes COULD account for if each collapsed to one call.
 * Deliberately named as a ceiling rather than a saving: it is what the shapes are worth if every
 * one of them was redundant, which is the optimistic end and not a claim.
 */
export function turnWaste(calls) {
  const rep = repeats(calls);
  const streaks = lookStreaks(calls);
  const discovery = calls.filter((c) => DISCOVERY.test(c)).length;
  const fromRepeats = rep.reduce((n, r) => n + (r.length - 1), 0);
  const fromStreaks = streaks.reduce((n, s) => n + (s - 1), 0);
  return {
    calls: calls.length,
    patterns: {
      repeatRuns: rep,
      lookStreaks: streaks,
      discoveryMidRun: discovery,
    },
    // The two overlap — a run of identical LOOKS is both — so the ceiling takes the larger, never
    // the sum. Adding them would let one stretch of calls be counted twice and inflate every report.
    recoverable: Math.max(fromRepeats, fromStreaks),
  };
}

/** One line per arm, widest first. */
export function report(rows) {
  const out = [];
  for (const r of rows) {
    const w = turnWaste(r.tool_calls ?? []);
    out.push({
      arm: r.arm,
      turns: r.turns,
      calls: w.calls,
      recoverable: w.recoverable,
      share: 0 === w.calls ? 0 : Number(((w.recoverable / w.calls) * 100).toFixed(0)),
      longestRepeat: w.patterns.repeatRuns.sort((a, b) => b.length - a.length)[0] ?? null,
      longestLookStreak: Math.max(0, ...w.patterns.lookStreaks),
      discoveryMidRun: w.patterns.discoveryMidRun,
    });
  }
  return out.sort((a, b) => b.recoverable - a.recoverable);
}
