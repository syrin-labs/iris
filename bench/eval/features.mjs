/**
 * Every Reticle feature that can be turned OFF for an A/B, in one file.
 *
 * The point is speed. Measuring a feature meant finding its seam, remembering its env variable, and
 * writing a bespoke two-arm script each time — so features shipped unmeasured, which is how this
 * repo ended up calling `verify_next` "the largest known lever on whether a session produces a
 * verdict at all" without ever checking whether an agent acts on it. It fires once in 118 calls.
 *
 * A flag here is a claim that the feature is separable. If turning it off needs a code change, it is
 * not listed — a half-suppressed feature measures two products at once.
 *
 * ## What a flag must satisfy to belong here
 *
 * 1. **One seam.** Suppression happens at a single site, so the arms differ by exactly the feature.
 * 2. **Cadence-preserving.** Counters still tick when suppressed. `verify_next` still TAKES its
 *    one-shot latch with the baton withheld — otherwise the control is "no baton AND a different
 *    nudge schedule", which is two changes wearing one name.
 * 3. **A stated hypothesis.** What should move, and in which direction. A flag without one produces
 *    a table nobody can read, and every direction looks like a win afterwards.
 */

/**
 * `id -> { env, hypothesis, measure }`.
 *
 * `env` is set to '1' to SUPPRESS. Suppression rather than enablement so the default build is the
 * one users get: an experiment that has to switch the feature ON is measuring a code path nobody
 * ships.
 */
export const FEATURES = {
  'verify-next-baton': {
    env: 'RETICLE_SUPPRESS_VERIFY_NEXT',
    what: 'the nudge that carries a ready-to-make verdict call after acts with no verdict',
    hypothesis: 'more verdict calls, fewer runs that end without one',
    measure: ['baton_turns', 'baton_followed', 'claimed'],
    // Measured 2026-08-25: 1 arrival in 118 calls, 0 followed. Not refuted — untested on the
    // population it targets, which is the session that drives and abandons. This harness never
    // produces one, because its agents interleave act and verify.
    status: 'inert in fix-and-verify work; untested where it aims',
  },
  'intent-instruction': {
    // Not a server flag: the manipulation is the INSTRUCTION, not the capability. Both arms can
    // reach reticle_intent and both get the same MCP instructions, so what is measured is whether
    // being told to declare the goal changes behaviour — the thing a project's CLAUDE.md controls.
    env: 'DV_NO_INTENT',
    what: 'telling the agent to state what a fix must make true, and pass it as `intent`',
    hypothesis: 'fewer false greens and fewer unreported successes; no change in works rate',
    measure: ['intent_declared', 'intent_discharged', 'false_green', 'unreported_success'],
    status:
      'first run: works identical (4/5 both), 0 vs 3 unreported, 0 vs 1 false green, -20% turns',
  },
  'flow-intent': {
    // The gap that fires when a flow is saved with nothing saying what it is for. Suppressible only
    // by not declaring — same shape as `intent-instruction`, one artifact later.
    env: 'DV_NO_FLOW_INTENT',
    what: 'the intentGap on a saved flow, and the prose a replay failure can quote months later',
    hypothesis:
      'no effect on whether a flow saves or replays; the difference should appear only when a saved flow later goes RED, which this suite does not yet reach',
    measure: ['flow_saved', 'flow_intent_present'],
    // Stated plainly rather than left blank: the harness saves no flows, so there is nothing to
    // measure yet. A feature listed with `status: unmeasured` is a debt; a feature not listed at all
    // is forgotten.
    // MEASURED 2026-08-25 by probing the seam directly, since the suite saves no flows:
    //   no intent      -> GAP no-flow-intent   (correct)
    //   prose intent   -> no gap               (correct)
    //   intentId only  -> no gap               (correct)
    //   intent "   "   -> no gap               (DEFECT, fixed — whitespace counted as a goal)
    // The behavioural half — whether a flow's intent makes a RED replay readable months later — is
    // still untested, and needs a suite that saves a flow and then breaks it.
    status:
      'MEASURED (mechanism): 3/4 correct, one defect found and fixed — a whitespace intent silenced the gap. Behavioural value on a red replay still untested',
  },
  'context-after-compaction': {
    env: 'DV_NO_CONTEXT_HINT',
    what: 'reticle_context returning what a run established, for an agent whose history was cut',
    hypothesis:
      'after a compaction the agent re-derives less: fewer snapshot/query calls before its next act, and a verdict still reached',
    measure: ['callsAfterCut', 'reachedVerdict'],
    // `bench/harness/long-horizon.mjs` performs a REAL cut of the message array at turn 2 and
    // refuses to report if the cut never fired. It has never been run against this release.
    // MEASURED 2026-08-25, real cut at turn 2 (cut confirmed fired: callsAfterCut=4).
    // remembers: 5 turns, 6 calls, 0 rediscovery, 49,752 tok.
    // compacted: 6 turns, 7 calls, 2 rediscovery, 56,454 tok. Both PASS.
    // usedContext=FALSE in both arms: an agent whose history was genuinely cut re-derived state by
    // hand rather than calling the tool built for exactly that moment.
    status:
      'MEASURED: compaction costs 2 rediscovery calls and ~13% tokens; reticle_context was NOT used, so the cost is unmitigated',
  },
  'lean-surface': {
    env: 'RETICLE_TOOL_PROFILE',
    suppressValue: 'lean',
    what: 'advertising ten tools instead of eighteen',
    hypothesis: 'fewer tokens per turn; the risk is fewer verdicts, so watch correctness first',
    measure: ['works', 'false_green', 'total_tokens'],
    status:
      'MEASURED AND REJECTED as a default: 3/5 fixed vs 5/5, and the first false green this repo produced',
  },
};

/** The env a run needs to suppress `id`. Throws on an unknown id rather than silently measuring nothing. */
export function suppressEnv(id) {
  const f = FEATURES[id];
  if (f === undefined)
    throw new Error(`no such feature flag: ${id} (have: ${Object.keys(FEATURES).join(', ')})`);
  return { [f.env]: f.suppressValue ?? '1' };
}

export function featureIds() {
  return Object.keys(FEATURES);
}
