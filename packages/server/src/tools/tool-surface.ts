import { ReticleTool } from './tool-names.js';
import type { ToolDef } from './tools.js';

/**
 * There is ONE tool surface. This is not a menu.
 *
 * The advertised tool DEFINITIONS are re-sent to the model on every turn, so the surface is a
 * per-turn cost that compounds across a loop, and fewer tools also makes the model wander less.
 * What ships is the verify loop (navigate→look→act→observe→assert, with direct network + console +
 * state) advertised directly, plus two meta-tools — `reticle_tools` to discover and `reticle_run` to
 * invoke — that keep every other tool exactly one call away. Nothing is unreachable; the cold tail
 * just is not re-sent every turn.
 *
 * Five profiles were tried. Four are gone, each for a measured reason rather than a taste:
 *
 * `core` was BYTE-IDENTICAL to the default — 16 tools, 18,183 bytes, the same list. One behaviour
 * behind two names is how "I set it and nothing changed" becomes a support question with no answer.
 *
 * `standard` advertised 17 more tools directly for ~3,500 extra tokens EVERY TURN, buying only the
 * removal of an occasional `reticle_run` hop. Nothing about that was characterisable as a use case.
 *
 * `dynamic` advertised the 2 meta-tools and nothing else. Not one harness, app or bench ever
 * selected it, and this repo's own measurement (bench/agent-loop-and-replay.md) says a pure
 * on-demand surface does NOT hold accuracy with a generic model: "it needs the hot-set schemas.
 * On-demand is for the cold tail, not the hot path." An option that is unused and measured-worse is
 * a trap, not a choice — it looks like a 4,000-token saving and costs correctness.
 *
 * ALL is what remains, and it is deliberately NOT a profile: it is a verification switch. It is the
 * only mode that advertises `outputSchema`, which is what makes the MCP layer validate tool OUTPUT —
 * the check that caught `reticle_verify_change` returning a payload its own schema rejected. It
 * cannot be folded into the default: measured, carrying output schemas on the 16-tool surface costs
 * 18,183 -> 41,117 bytes, 2.26x, +5,733 tokens per turn. And it cannot simply be deleted without
 * losing that defect class. So it stays, named for what it is, and no user is asked to pick it.
 *
 * Sizes are NOT restated here — not as a current figure, not as a historical one. Four generations
 * of this comment got them wrong. They live in surface-sizes.test.ts, which reads them off the real
 * surface. (The numbers above are the two measurements that JUSTIFY a decision, which is a different
 * job from documenting the current size; both were taken with a fresh daemon per reading.)
 */
export const TOOL_SURFACE = {
  /** What every user gets: the verify loop, plus the 2 meta-tools that reach everything else. */
  DEFAULT: 'default',
  /** Every tool advertised directly, WITH output schemas. A verification switch — see above. */
  ALL: 'all',
  /**
   * The smallest surface that can still produce a VERDICT. Not a profile — a cost switch.
   *
   * Measured on the wire: a verification that names its own target costs one `act_and_wait` call,
   * and 5,480 of its 5,909 tokens are the advertised surface re-sent for that single turn. The
   * answers cost 430. So on the path where the caller already knows what to assert, almost the
   * entire bill is the menu, and the menu is the thing to cut.
   *
   * Deliberately NOT the default, and now MEASURED rather than inherited. Run over the same 30-bug
   * set that the default surface scores 23/27 detection and 2/29 false alarms on:
   *
   *   detection      24/28   (held)
   *   FALSE ALARMS   7/30    (was 2/29 — TRIPLED)
   *   tokens         113,599 per run (was 179,959 — 37% cheaper)
   *
   * The five new false alarms are not scattered. They are `mutation-leak` and
   * `generate-blast-filter` (state), `kpi-deploys-tamper` (business-logic), `debounce-broken`
   * (timing) and `route-stuck-deployments` (routing) — precisely the classes whose evidence lives in
   * `reticle_state`, `reticle_network` and `reticle_observe`, which this surface does not advertise.
   * Strip the observation tools and the model stops observing: it reaches for the verdict without
   * the evidence and calls a healthy build broken.
   *
   * So the retired `dynamic` finding is confirmed, with a sharper mechanism than "accuracy drops".
   * 37% of the tokens is not worth trading for the one metric this product actually wins on, and
   * this must not become the default on the strength of the token number alone.
   *
   * It remains correct for a caller who has ALREADY decided what to assert — there the assertion
   * supplies the evidence the surface would otherwise have to go and find.
   */
  VERIFY: 'verify',
  /**
   * EXPERIMENTAL, opt-in, and UNDER MEASUREMENT. Not a recommendation, and not on a path to becoming
   * the default until it has a number of its own.
   *
   * It exists because of the finding recorded on VERIFY above, read forwards instead of backwards.
   * That surface cut the bill 37% and TRIPLED false alarms, and the five new false alarms were not
   * scattered: every one of them was a defect whose evidence lives in `reticle_state`,
   * `reticle_network` or `reticle_observe`. So the token saving and the accuracy loss came from two
   * different cuts, and only one of them has to be paid for. `lean` keeps every observation tool and
   * cuts the rest.
   *
   * What stays, and why each one is not a candidate for removal:
   *   SNAPSHOT / QUERY   look. Without them the agent cannot name an element it did not already know.
   *   STATE / NETWORK / CONSOLE / OBSERVE   the four evidence tools. Dropping these is the MEASURED
   *                      cause of the tripled false-alarm rate. They are the point of the profile.
   *   ACT_AND_WAIT       the only tool that acts AND returns a verdict. Omitting `until` makes it
   *                      act-then-settle, which is what `reticle_act` does, so `act` is redundant here.
   *   ASSERT             the only way to get a verdict WITHOUT acting. `act_and_wait` requires an
   *                      `action`, so this is a capability it genuinely cannot express, not a synonym.
   *
   * What goes, and what it costs (one `reticle_run` hop each — `unadvertisedToolHelp` hands the agent
   * the exact call, so a dropped name never comes back as "not found"):
   *   ACT                subsumed: `act_and_wait` with `until` omitted is act-then-settle.
   *   WAIT_FOR           subsumed: `act_and_wait { until }` takes the same PredicateSchema.
   *   ACT_SEQUENCE       batching is a cost optimisation on top of a surface built to be cheap.
   *   NAVIGATE           once per run, not once per turn — the wrong thing to pay for every turn.
   *   SESSIONS           the CLI answers this (`reticle status`) without spending any turn budget.
   *   INSPECT            fix-side, not verdict-side: it is called once a bug is FOUND, so its hop is
   *                      paid once per finding rather than once per turn. Nothing else maps a node to
   *                      a source file, which is why it is a hop and not a deletion.
   *   SESSION            the lease block and the pause hint name it in prose, which is what made it
   *                      load-bearing on the default surface. Under a trimmed surface the
   *                      unadvertised-tool help turns that into a working `reticle_run` call.
   *   FEEDBACK           the one drop with a KNOWN CEILING: an unadvertised feedback channel collects
   *                      little to nothing, so a long-lived profile must not ship without it. Acceptable
   *                      only because this profile is opt-in and short-lived by construction; if it
   *                      ever stops being an experiment, feedback comes back first.
   */
  LEAN: 'lean',
} as const;
export type ToolSurface = (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE];

/**
 * The switch that turns on the full, output-schema-carrying surface. A boolean, not a menu.
 *
 * Named for what it does rather than which "profile" it selects, because the previous name invited
 * users to shop among alternatives that did not meaningfully differ.
 */
export const ADVERTISE_ALL_ENV = 'RETICLE_ADVERTISE_ALL_TOOLS';

/** Opt into the smallest verdict-capable surface. Read by the DAEMON at startup, like the others. */
const VERIFY_SURFACE_ENV = 'RETICLE_VERIFY_SURFACE';

/**
 * The retired setting, still read so nobody's shell profile breaks.
 *
 * Every value it ever accepted resolves to something sensible: `full` to the ALL surface, everything
 * else to the default. Silently honouring them would repeat the original sin, so `describeToolSurface`
 * says the setting retired and what was used instead.
 */
export const TOOL_PROFILE_ENV = 'RETICLE_TOOL_PROFILE';
const RETIRED_PROFILE_VALUES: Readonly<Record<string, ToolSurface>> = {
  full: TOOL_SURFACE.ALL,
  hybrid: TOOL_SURFACE.DEFAULT,
  core: TOOL_SURFACE.DEFAULT,
  standard: TOOL_SURFACE.DEFAULT,
  dynamic: TOOL_SURFACE.DEFAULT,
};

// The set an agent needs to verify a change end-to-end. Tool DEFINITIONS are re-sent every turn, so
// this set is a per-turn cost, and every name in it has to earn its place.
//
// MEASURED per-turn `tools/list` cost, off the real wire (spawn `mcp`, read tools/list, measure the
// serialized result), with a FRESH DAEMON per reading — the setting is read by the daemon at startup,
// so a loop that reuses one daemon measures the first surface every time and looks like proof that
// the setting does nothing. That happened while taking this very reading.
//
//   default    18,183 B  ~4,546 tok/turn    16 tools
//   all       127,903 B ~31,976 tok/turn    48 tools
//
// Treat these as the SHAPE of the gap and re-measure before quoting one; counts are asserted in
// surface-sizes.test.ts, never from this comment.
//
// Where the cost sits on the default surface: inputSchema is 76% of the payload (parameter
// descriptions are half of that), tool descriptions are 12%, outputSchema ~0 because it is dropped.
// So the next real saving is in parameter prose, not in dropping more tools.
//
// There is a floor, though: an 8-tool cut (dropping act/navigate/wait_for/sessions) was MEASURED to
// regress real-agent accuracy 5/5 -> 3/5, because the model loses scaffolding and wanders on harder
// flows. Direct network/console stay (far more discoverable than observe-with-filters -> fewer turns,
// better verdicts).
//
// Evidence status: the 5/5 figure came from a single gpt-4o run and is STALE as a justification.
// Current-model evidence is indirect but real — the cost-delta run (bench/fix-loop/COST-DELTA.md)
// drove this surface on a current model and fixed 4/4 cells with ~25% FEWER tool calls than the
// baseline. A formal A/B against a leaner surface on a current model is still UNRUN.
// See bench/agent-loop-and-replay.md.
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SESSIONS,
  ReticleTool.NAVIGATE,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  // ACT_SEQUENCE is here because its absence was measurably CAUSING the biggest loop in the data.
  //
  // In the field `reticle_act` is called overwhelmingly more often than `reticle_act_sequence`, and
  // `act` leads the repeat table by a wide margin — inside those sessions the repeated calls are
  // clicks and fills, a login form driven one round trip at a time, which is exactly the antipattern
  // SKILL.md warns about and exactly what this tool exists to collapse.
  //
  // The repeats are NOT retries: looping sessions have a LOWER error rate than non-looping ones. The
  // calls succeed and get repeated, because the batching tool was reachable only through
  // `reticle_run` — so an agent had to already know it existed to use it, and essentially nobody
  // did. A tool an agent must already know about is a tool that never gets called; the same argument
  // that put INSPECT and FEEDBACK here.
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.STATE,
  // INSPECT is what turns a finding into an EDIT: it maps a DOM node to `src/App.tsx:104`. Finding a
  // bug is half the job; knowing which file to open is the half that makes the agent useful, and it
  // is the one capability here with no substitute in any other verification tool. It sat in
  // `standard`, so under the default profile an agent had to already know it existed and reach it
  // through reticle_run — which, observed over a drive of the whole surface, means it never gets called.
  // The measured floor that justifies a lean core was about CUTTING to 8 (accuracy 5/5 → 3/5), not
  // about holding at 12; one tool of schema tax to close the find→fix loop is the right trade.
  ReticleTool.INSPECT,
  // FEEDBACK is in every profile for the same reason INSPECT is: a tool an agent has to already know
  // about, and reach through reticle_run, is a tool that never gets called. That is fatal here in a way
  // it is not elsewhere — an unadvertised feedback channel collects nothing, which is indistinguishable
  // from not having built one. It is also the cheapest tool on the surface to carry (three params) and
  // the only one whose whole purpose is telling us which of the other fifteen are failing.
  ReticleTool.FEEDBACK,
  // SESSION is here because the product ORDERS the agent to call it. The session lease block is
  // spliced onto the first result of every session ("call reticle_session {action:'yield'}"), and
  // the pause hint is spliced onto every refusal while a human has the session paused, where
  // {action:"resume"} is the only exit. Both were naming a tool the default surface did not
  // advertise: an agent that obeyed got `unknown tool`, and an agent that did not left the panel
  // reading "live" after it had stopped driving — which is the state the whole handback protocol
  // exists to prevent.
  //
  // Measured cost: ~1.3 KB of prose (455 B description + ~780 B of parameter descriptions) on a
  // surface whose prose is ~23.7 KB, so roughly +5%, a few hundred tokens a turn. The alternative —
  // deleting the instruction from the lease and the pause hint — deletes the handback protocol,
  // because there is nowhere else those two calls are ever named.
  ReticleTool.SESSION,
]);

/**
 * The extended surface: what `all` advertises BEYOND the default set.
 *
 * `all` used to mean "every tool in the registry", and that is no longer allowed to be true. Cursor
 * enforces a limit of 40 tools across every connected MCP server COMBINED, so a server advertising
 * 48 by itself can push a user's other servers out or be dropped wholesale. The budget is a count,
 * so no amount of trimming parameter prose buys anything back — only advertising fewer names does.
 *
 * That is true of the COUNT cap and false of everything else, which is worth separating here before
 * somebody reads it as "prose is free". Measured against two competitor MCP servers on the same
 * agent loop: this server advertises the FEWEST tools of the three and ships the HEAVIEST schema
 * block, and 83% of that weight is parameter descriptions, not tool descriptions. The block is
 * re-sent every turn, so it is multiplied by turn count before one byte of evidence is counted, and
 * it was most of the gap in that run.
 *
 * Which does NOT license trimming by eye. Those descriptions are what make a tool get called
 * correctly, and one malformed call costs a whole extra turn — more than the bytes saved. The
 * outcome to measure is turn count and error rate, not size.
 *
 * Everything omitted stays in the registry, stays catalogued by `reticle_tools`, and stays callable
 * by name through `reticle_run { tool, args }`. The cost is one discovery hop on the cold tail, which
 * is the same trade the default surface has always made, applied one level further out.
 *
 * What it costs that is NOT free: `all` is the only surface that carries `outputSchema`, which is
 * what makes the MCP layer validate tool OUTPUT — the check that once caught `reticle_verify_change`
 * returning a payload its own schema rejected. The tools left off this list no longer get that
 * validation from the wire. That defect class is now uncovered for them, and it is written down here
 * rather than discovered later.
 *
 * Chosen as the capabilities an agent plausibly reaches for once the verify loop is not enough:
 * orientation, the record/replay flow loop, visual evidence, and the three fault-injection controls.
 */
export const EXTENDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Demoted from the default set to make room under the cap. It was added as an explicit bet that
  // orientation replaces exploratory snapshots, and the measurement that would have settled that
  // bet was never run — so when the budget became a hard count, the unproven entry is the one that
  // gives way. Still one `reticle_run` hop from any agent that wants it.
  ReticleTool.CAPABILITIES,
  ReticleTool.FLOW_SAVE,
  ReticleTool.FLOW_REPLAY,
  // New and unproven, so it does not take a default-surface slot under the cap. Same terms the
  // capabilities demotion set: reachable in one reticle_run hop by any agent that wants it.
  ReticleTool.INTENT,
  // Same terms again, plus one argument specific to it: its caller is BY CONSTRUCTION an agent that
  // just lost its context and is re-reading the tool list, so the discovery hop it costs is a call
  // that caller was already going to make. See context-tools.ts for the full argument.
  ReticleTool.CONTEXT,
  ReticleTool.RECORD,
  ReticleTool.SCREENSHOT,
  ReticleTool.VISUAL_DIFF,
  ReticleTool.CLOCK,
  ReticleTool.NETWORK_MOCK,
  ReticleTool.STORAGE,
  // Merged change/flows/affected/coverage/crawl — one name where three of these used to sit.
  ReticleTool.VERIFY,
]);

/**
 * The verify surface: one acting tool that returns a verdict, plus the two meta-tools that reach
 * everything else. `act_and_wait` can resolve its own target, so no query tool is needed to name an
 * element — that round trip was half the token cost of a verification.
 */
const VERIFY_TOOL_NAMES: ReadonlySet<string> = new Set([ReticleTool.ACT_AND_WAIT]);

/**
 * The lean surface: look, observe, act-with-a-verdict, assert. Pinned by lean-surface.test.ts,
 * because an experiment whose independent variable drifts mid-flight measures nothing. Every
 * inclusion and every exclusion is argued at TOOL_SURFACE.LEAN.
 *
 * ## MEASURED: it is cheaper and less correct. Do not promote it to the default.
 *
 * Run as its own arm of the fix-and-verify benchmark — same five bugs, same model, same budget, the
 * full surface as its control:
 *
 * | | full surface | lean |
 * |---|---|---|
 * | bugs fixed | **5/5** | **3/5** |
 * | FALSE GREENS | **0** | **1** |
 *
 * The false green is the finding, and it is the first this benchmark has ever produced. On
 * `broken-form-validation` the lean agent finished in SIX turns and 62k tokens — the cheapest cell
 * of the whole run, a fifth of what the full surface spent — edited the file, took one snapshot,
 * and ended with a hypothetical walkthrough: "Enter spaces + valid name -> spaces are trimmed,
 * valid part is used. VERDICT: FIXED". The submit button was still enabled for a whitespace-only
 * service. It reasoned about what its own code would now do instead of driving it, which is exactly
 * the failure this product exists to catch, produced by our own surface.
 *
 * The other loss has the same root from the other side. On `cross-component-regression` the agent
 * called `reticle_tools` three times and `reticle_run` eight, saying "since Reticle isn't
 * connecting, let me see what reticle_tools offers" — it spent the run hunting for capabilities
 * this surface does not advertise instead of using them, and never fixed the bug.
 *
 * That is the same result the `verify` surface already recorded — dropping the observation tools
 * TRIPLED false alarms — arriving from the other direction: strip the surface and the agent stops
 * verifying, then claims anyway. The known ceiling written here was that `reticle_feedback` goes
 * uncollected. This is a bigger one and it was not predicted.
 *
 * It stays opt-in and it stays measured. The one thing it genuinely bought — the ceiling-bound cell
 * halved, 30 turns to 14 — is not worth a verdict that lies, because the product is the verdict.
 */
export const LEAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ASSERT,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.STATE,
]);

/** Is the truthy form of a boolean env var set? `1`, `true`, `yes` — anything else is off. */
function envFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return '1' === value || 'true' === value || 'yes' === value || 'on' === value;
}

/**
 * Which surface is live.
 *
 * `explicit` is the programmatic override (tests, `advertisedTools` callers). Otherwise the ALL
 * switch decides, and the retired setting is honoured last so an old shell profile still works.
 */
export function resolveToolSurface(explicit?: string): ToolSurface {
  if (explicit === TOOL_SURFACE.LEAN) return TOOL_SURFACE.LEAN;
  if (explicit === TOOL_SURFACE.VERIFY) return TOOL_SURFACE.VERIFY;
  if (explicit === TOOL_SURFACE.ALL) return TOOL_SURFACE.ALL;
  if (explicit === TOOL_SURFACE.DEFAULT) return TOOL_SURFACE.DEFAULT;
  const retiredExplicit = explicit === undefined ? undefined : RETIRED_PROFILE_VALUES[explicit];
  if (retiredExplicit !== undefined) return retiredExplicit;
  // The one LIVE value of the otherwise-retired setting. It rides there rather than on a switch of
  // its own because the experiment is an A/B between two surfaces, and a boolean cannot name an arm.
  if (TOOL_SURFACE.LEAN === process.env[TOOL_PROFILE_ENV]?.trim().toLowerCase()) {
    return TOOL_SURFACE.LEAN;
  }
  if (envFlagOn(process.env[VERIFY_SURFACE_ENV])) return TOOL_SURFACE.VERIFY;
  if (envFlagOn(process.env[ADVERTISE_ALL_ENV])) return TOOL_SURFACE.ALL;
  const retiredEnv = RETIRED_PROFILE_VALUES[process.env[TOOL_PROFILE_ENV] ?? ''];
  return retiredEnv ?? TOOL_SURFACE.DEFAULT;
}

/** The live surface plus what chose it — see describeToolSurface. */
export interface ToolSurfaceOrigin {
  active: ToolSurface;
  source: string;
}

/**
 * Which surface is live, and what chose it.
 *
 * These settings are read by the DAEMON at startup, never by the client, so exporting one in an
 * agent's environment while a daemon is already running changes nothing at all — which is exactly
 * the observation that produced a "standard and full advertise the same tools" report. Documenting
 * that was not enough; the setting failing to take has to be VISIBLE, so this rides along in the
 * reticle_tools catalog.
 */
export function describeToolSurface(active: ToolSurface, requested?: string): ToolSurfaceOrigin {
  const retired = requested ?? process.env[TOOL_PROFILE_ENV];
  // `lean` is the one value of this setting that is NOT retired. Reporting it as retired would tell
  // an agent its arm did not take, which on an A/B is worse than saying nothing.
  if (TOOL_SURFACE.LEAN === active) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV}=${TOOL_SURFACE.LEAN} — an EXPERIMENTAL surface under measurement; unadvertised tools stay callable via ${ReticleTool.RUN}`,
    };
  }
  if (retired !== undefined && retired in RETIRED_PROFILE_VALUES) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV}=${retired} is RETIRED — there is one tool surface now; using '${active}' (set ${ADVERTISE_ALL_ENV}=1 for the full, schema-carrying surface)`,
    };
  }
  if (retired !== undefined && 0 < retired.length) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV} is RETIRED and '${retired}' was never one of its values; using '${active}'`,
    };
  }
  const flag = process.env[ADVERTISE_ALL_ENV];
  if (envFlagOn(flag)) {
    return { active, source: `${ADVERTISE_ALL_ENV} set in the DAEMON's environment at startup` };
  }
  // "unset" and "set to 0" are different facts, and only one of them means "you did not ask for it".
  // Reporting the second as the first is how somebody spends an afternoon on a switch that IS being
  // read and is simply off.
  return flag === undefined || 0 === flag.length
    ? {
        active,
        source: `the one tool surface (${ADVERTISE_ALL_ENV} unset when the daemon started)`,
      }
    : { active, source: `the one tool surface (${ADVERTISE_ALL_ENV}='${flag}' is off)` };
}

export function filterTools(tools: ToolDef[], surface: ToolSurface): ToolDef[] {
  // CORE_TOOL_NAMES is what it always really was: the set advertised directly. It was never the
  // interesting thing about the `core` PROFILE, whose only distinction was a second name for this.
  if (surface === TOOL_SURFACE.VERIFY) return tools.filter((t) => VERIFY_TOOL_NAMES.has(t.name));
  if (surface === TOOL_SURFACE.LEAN) return tools.filter((t) => LEAN_TOOL_NAMES.has(t.name));
  if (surface === TOOL_SURFACE.DEFAULT) return tools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  // `all` is the extended surface, not the whole registry — the cap is a hard budget shared with
  // every other MCP server the user has connected. surface-sizes.test.ts enforces it.
  return tools.filter((t) => CORE_TOOL_NAMES.has(t.name) || EXTENDED_TOOL_NAMES.has(t.name));
}
