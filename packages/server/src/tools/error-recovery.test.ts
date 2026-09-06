import { describe, expect, it } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { FEEDBACK_ASK, RECOVERY, buildErrorPayload, recoveryFor } from './error-recovery.js';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { diagnoseNoSession } from '../session/no-session-diagnosis.js';

describe('recoveryFor — every known error carries an actionable next move', () => {
  it('maps the no-session footgun to a concrete recovery', () => {
    const hint = recoveryFor(
      'no browser session connected — is your app running with @reticlehq/browser enabled?',
    );
    expect(hint).toBe(RECOVERY.NO_SESSION);
    expect(hint).toMatch(/reticle status/);
  });

  it('maps multiple-sessions to "pass a sessionId from reticle_sessions"', () => {
    expect(recoveryFor('multiple sessions connected — pass sessionId to target one: a, b')).toBe(
      RECOVERY.MULTIPLE_SESSIONS,
    );
  });

  it('maps an unknown sessionId to "list ids and retry"', () => {
    expect(recoveryFor("no connected session with id 'ghost'")).toBe(RECOVERY.UNKNOWN_SESSION);
  });

  it('maps a throttled-tab refusal to the refocus / escape-hatch recovery', () => {
    expect(
      recoveryFor(
        'refusing to act: tab throttled; timer/rAF/pointer gestures may silently no-op — refocus before driving',
      ),
    ).toBe(RECOVERY.THROTTLED);
  });

  it('THROTTLED names the in-protocol route first and leaves the CLI to the human (#521)', () => {
    // Same defect COMMAND_TIMEOUT had: an MCP-only agent has no shell, so "run `reticle drive`"
    // sent it nowhere. The agent's own route is `reticle_run { tool: "reticle_lease" }`; the CLI
    // stays in the sentence as the human's equivalent.
    expect(RECOVERY.THROTTLED).toContain('reticle_run { tool: "reticle_lease"');
    expect(RECOVERY.THROTTLED.indexOf('reticle_run')).toBeLessThan(
      RECOVERY.THROTTLED.indexOf('reticle drive'),
    );
  });

  it('names reticle_lease through reticle_run, since it is unadvertised by default (#400)', () => {
    // The throttled-tab timeout recovery told the agent to "drive your own browser with
    // reticle_lease" — a tool the default profile does not advertise, so an agent that had not
    // already called reticle_tools could not call it and had no way to learn it goes through
    // reticle_run. The recovery now names the call that actually reaches it.
    expect(RECOVERY.COMMAND_TIMEOUT).toContain('reticle_run { tool: "reticle_lease"');
    expect(RECOVERY.COMMAND_TIMEOUT).not.toMatch(/with reticle_lease\b/);
  });

  it('maps a missing baseline / recording to the create-it-first hint', () => {
    expect(recoveryFor('no baseline named "home"')).toBe(RECOVERY.MISSING_BASELINE);
    expect(recoveryFor('no active recording named "ship"')).toBe(RECOVERY.MISSING_RECORDING);
    expect(recoveryFor('no compiled recording named "ship"')).toBe(RECOVERY.MISSING_RECORDING);
  });

  it('maps the pairing-token error to its config fix', () => {
    expect(
      recoveryFor('a pairing token is required when the Reticle bridge binds beyond localhost'),
    ).toBe(RECOVERY.TOKEN_REQUIRED);
  });

  it('returns undefined for an unrecognized error (never invents a hint)', () => {
    expect(recoveryFor('save failed: disk_full')).toBeUndefined();
    expect(recoveryFor('')).toBeUndefined();
  });
});

describe('buildErrorPayload — the MCP-boundary envelope', () => {
  it('adds recovery only when the error is recognized', () => {
    const known = buildErrorPayload('no browser session connected — is your app running?');
    expect(known).toEqual({
      error: 'no browser session connected — is your app running?',
      recovery: RECOVERY.NO_SESSION,
    });
    // An UNRECOGNIZED error gets no recovery hint — there is none to give — but it is also the case
    // most likely to be a defect in Reticle itself, so it carries the feedback ask instead. The two
    // are mutually exclusive on purpose: the agent always gets exactly one next move.
    const unknown = buildErrorPayload('save failed: disk_full');
    expect(unknown).toEqual({ error: 'save failed: disk_full', feedback: FEEDBACK_ASK });
    expect('recovery' in unknown).toBe(false);
  });
});

/**
 * A recovery hint is only useful if the tool it names can actually be called.
 *
 * Two hints told the agent to call `reticle_record_start` and `reticle_baseline_list`. Both had been
 * folded into action-dispatched tools by MERGE_PLANS and are no longer advertised, so the one message
 * whose whole job is "here is the way out" pointed at a door that is not there. Nothing caught it:
 * the strings are prose, and prose is not type-checked.
 */
describe('every tool a recovery hint names must still be advertised', () => {
  // TOOLS is the underlying tool table; the two META-tools (reticle_run to dispatch, reticle_tools
  // to discover) are added by dynamic-tools.ts and are advertised under the default/hybrid profiles
  // — the very profiles these recovery hints are written for. A hint may name them to route to a
  // tool the profile does not advertise directly (e.g. reticle_run { tool: "reticle_lease" }), so
  // they count as reachable here. Under `full` every tool is advertised directly, so the routing
  // clause is merely redundant, not a dangling door.
  const advertised = new Set([
    ...TOOLS.map((tool) => tool.name),
    ReticleTool.RUN,
    ReticleTool.TOOLS,
  ]);

  it('actually reads tool names out of the hints', () => {
    // Two ways this group can check nothing: an empty RECOVERY registers zero cases
    // below, and hints that name no tool at all leave every inner loop with nothing to
    // assert. Counting mentions across the whole set covers both.
    //
    // Deliberately NOT a per-hint control: a recovery hint that mentions no tool is
    // legitimate, so requiring one from each would fail on a correct hint.
    expect(Object.keys(RECOVERY).length).toBeGreaterThan(0);
    const mentions = Object.values(RECOVERY).flatMap(
      (hint) => hint.match(/reticle_[a-z_]+/g) ?? [],
    );
    expect(mentions.length, 'no hint names a tool — the check below is vacuous').toBeGreaterThan(0);
  });

  it.each(Object.entries(RECOVERY))('%s names only reachable tools', (_name, hint) => {
    for (const mentioned of hint.match(/reticle_[a-z_]+/g) ?? []) {
      expect(
        advertised,
        `${mentioned} is named by a recovery hint but is not advertised`,
      ).toContain(mentioned);
    }
  });
});

/**
 * The commonest event in an agent loop, and it was classified as "possibly a Reticle defect".
 *
 * `reticle_act` invalidates refs whenever the DOM re-renders — a click that navigates, a list that
 * re-sorts, a modal that opens. The browser throws `ref 'e6' no longer resolves to an element`,
 * which is Reticle working correctly: it refuses rather than clicking whatever now occupies that
 * slot, and refusing is the whole point.
 *
 * But the message was not in RULES, so it got FEEDBACK_ASK — "this error is not one Reticle
 * recognizes, which means it may be a defect in Reticle". Measured against a real `reticle mcp`
 * process: three tool calls in one sweep, every one of them told the agent to consider filing a bug
 * about the single most ordinary thing that happens after a successful click. That costs the agent a
 * turn it should have spent re-querying, and fills the maintainers' feedback with a non-bug.
 */
describe('a stale ref is a recognized, recoverable condition — not an unknown defect', () => {
  it('maps the stale-ref throw to "query again for a fresh ref"', () => {
    const hint = recoveryFor("ref 'e6' no longer resolves to an element");
    expect(hint).toBe(RECOVERY.STALE_REF);
    expect(String(hint)).toContain('reticle_query');
  });

  it('names the CAUSE, so the agent stops reusing refs across a re-render', () => {
    expect(String(RECOVERY.STALE_REF)).toMatch(/re-render|changed the page|navigat/i);
  });

  it('and it is recognized, so no feedback ask is attached', () => {
    expect(recoveryFor("ref 'e12' no longer resolves to an element")).toBeDefined();
  });
});

/**
 * Reticle's OWN argument-validation errors were being reported as unknown failures.
 *
 * `reticle_lease{action:"acquire"} requires a url` is a message this codebase authored, about its
 * own API, naming the exact tool and argument at fault. It is the opposite of an unanticipated
 * failure — and it was getting FEEDBACK_ASK: "this error is not one Reticle recognizes, which means
 * it may be a defect in Reticle rather than in your app."
 *
 * Two costs. The agent is pushed toward filing a report instead of fixing its call, and the
 * maintainers' feedback fills with reports about callers passing the wrong arguments. Measured
 * against real `reticle mcp` processes driving bench-app, atlas and next-smoke: the same error, the
 * same wrong classification, in all three.
 *
 * A message that names a `reticle_*` tool is by definition one we wrote. Treat it as recognized.
 */
describe("Reticle's own validation errors are recognized, not reported as unknown defects", () => {
  it('maps a tool argument-validation error to "check the schema and retry"', () => {
    const hint = recoveryFor('reticle_lease{action:"acquire"} requires a url');
    expect(hint).toBe(RECOVERY.BAD_ARGUMENTS);
    // Deliberately names no tool: `reticle_tools` is advertised under the default hybrid profile
    // but NOT under `full`, so pointing at it would be dead advice for exactly the callers who
    // opted into the larger surface. The failing tool's own name is already in the message.
    expect(String(hint)).toContain('not a Reticle defect');
  });

  it('recognizes the shape generally, not just that one tool', () => {
    expect(recoveryFor('reticle_flow{action:"save"} requires a flowName')).toBe(
      RECOVERY.BAD_ARGUMENTS,
    );
  });

  it('still returns undefined for a genuinely unknown failure, so real defects keep the ask', () => {
    expect(recoveryFor('Cannot read properties of undefined (reading foo)')).toBeUndefined();
    expect(recoveryFor('ECONNRESET')).toBeUndefined();
  });
});

/**
 * The whole browser-side action-validation family was classified as an unknown Reticle defect.
 *
 * Measured over real MCP against bench-app: `reticle_act { action: 'frobnicate' }` came back with
 * "unknown action 'frobnicate' — expected one of: click, dblclick, …" — a message Reticle wrote,
 * listing the valid answers — and then "This error is not one Reticle recognizes, which means it
 * may be a defect in Reticle". Same for `cannot fill a <button>`.
 *
 * These are every guard in executeAction: the wrong element for the action, a disabled or readonly
 * field, a valueless fill, an unknown action, and the destructive-action block — which is a
 * DELIBERATE refusal carrying its own retry instruction, and was still telling the agent Reticle
 * might be broken. The prior rule only caught server-authored messages that named a `reticle_*`
 * tool, so none of these matched.
 */
describe('browser-side action guards are recognized refusals, not unknown defects', () => {
  // Without this, every expectation below reads `expect(undefined).toBe(undefined)` while the
  // constant is missing — a suite that passes with the bug fully present. Assert the hints EXIST
  // before asserting anything maps to them.
  it('the hints these map to are real strings', () => {
    for (const key of [
      'WRONG_TARGET',
      'NOT_EDITABLE',
      'CONFIRM_DANGEROUS',
      'UNSUPPORTED_SURFACE',
      'HOVER_NEEDS_POINTER',
    ] as const) {
      expect(typeof RECOVERY[key], key).toBe('string');
    }
  });

  it('an unknown action is a bad call — the message already lists the valid ones', () => {
    expect(
      recoveryFor("unknown action 'frobnicate' — expected one of: click, dblclick, hover"),
    ).toBe(RECOVERY.BAD_ARGUMENTS);
  });

  it('a missing value/text is a bad call', () => {
    expect(
      recoveryFor('fill requires a string `value` — pass it nested, as args: { value: … }'),
    ).toBe(RECOVERY.BAD_ARGUMENTS);
    expect(
      recoveryFor('type requires a string `text` — pass it nested, as args: { text: … }'),
    ).toBe(RECOVERY.BAD_ARGUMENTS);
  });

  it('the wrong element for the action points at re-querying, not at a bug report', () => {
    for (const msg of [
      'cannot fill a <button>',
      'cannot type into a <div>',
      'cannot clear a <span>',
      'cannot select on a <input>',
      'cannot (un)check a <div>',
      'no form to submit',
      'upload target must be a <input type="file">',
      "ref 'e12' is not an HTMLElement",
    ]) {
      expect(recoveryFor(msg), msg).toBe(RECOVERY.WRONG_TARGET);
    }
  });

  it('a disabled or readonly field is the app refusing, not Reticle failing', () => {
    expect(recoveryFor('cannot fill a disabled <input> — a user could not edit it')).toBe(
      RECOVERY.NOT_EDITABLE,
    );
    expect(recoveryFor('cannot type a readonly <textarea> — a user could not edit it')).toBe(
      RECOVERY.NOT_EDITABLE,
    );
  });

  it('the destructive-action block carries its own retry, and must never read as a defect', () => {
    expect(
      recoveryFor('potentially destructive action blocked; retry with args.confirmDangerous=true'),
    ).toBe(RECOVERY.CONFIRM_DANGEROUS);
  });

  it('an unsupported surface is named as unsupported, not as a possible bug', () => {
    expect(
      recoveryFor(
        'cannot fill a contenteditable element — rich-text editors keep their own document model',
      ),
    ).toBe(RECOVERY.UNSUPPORTED_SURFACE);
  });

  it('a hover without a real pointer is a named refusal, not a possible bug', () => {
    expect(
      recoveryFor(
        'cannot hover without a real pointer — CSS :hover only applies to a native mouse move, never to a synthetic mouseover',
      ),
    ).toBe(RECOVERY.HOVER_NEEDS_POINTER);
    expect(RECOVERY.HOVER_NEEDS_POINTER).toContain('reticle_run { tool: "reticle_lease"');
    expect(RECOVERY.HOVER_NEEDS_POINTER.indexOf('reticle_run')).toBeLessThan(
      RECOVERY.HOVER_NEEDS_POINTER.indexOf('reticle drive'),
    );
  });
});

/**
 * The no-session diagnosis inspects the machine and says which of three causes this actually is.
 * Pairing it with the generic hint produced a result that contradicted itself — the error saying a
 * server IS listening, the recovery saying to go start one — and suppressing only the recovery then
 * dropped it into the feedback ask, telling the agent that a condition Reticle had just diagnosed
 * might be a defect in Reticle. A message that recovers itself gets nothing appended.
 */
describe('a self-diagnosing message is left alone', () => {
  const diagnosis = diagnoseNoSession({
    everConnected: false,
    initialized: true,
    listening: [5173],
    port: 4400,
  });

  it('gets no second, generic recovery', () => {
    expect(recoveryFor(diagnosis)).toBeUndefined();
  });

  it('and is NOT reported as a possible Reticle defect', () => {
    const payload = buildErrorPayload(diagnosis);
    expect(payload.recovery).toBeUndefined();
    expect(payload.feedback).toBeUndefined();
    expect(payload.error).toBe(diagnosis);
  });

  it('while the plain static message still gets its hint', () => {
    expect(recoveryFor('no browser session connected. Two things to check')).toBe(
      RECOVERY.NO_SESSION,
    );
  });
});

/**
 * A schema rejection is the agent's argument to fix, not evidence of a Reticle defect.
 *
 * Reported from the field: a clean `unrecognized_keys: ["value"]` rejection came back wrapped in
 * "This error is not one Reticle recognizes, which means it may be a defect in Reticle". Nothing
 * misbehaved — the call named a parameter that does not exist, and the schema said so precisely.
 * Inviting a bug report there spends the agent's turn and fills the feedback channel with reports
 * about calls that were simply wrong, which is the fastest way to make real reports unfindable.
 */
describe('argument rejections are not Reticle defects', () => {
  it.each([
    ['an unknown key', "Unrecognized key(s) in object: 'value'"],
    ['a zod code', 'invalid_type: expected string, received number at path ["by"]'],
    [
      'the MCP wrapper',
      'Invalid arguments for tool reticle_query: Expected string, received number',
    ],
    ['a missing required arg', 'Required at path ["action"]'],
  ])('%s gets a recovery, never the defect ask', (_label, message) => {
    const payload = buildErrorPayload(message);
    expect(payload.feedback, message).toBeUndefined();
    expect(payload.recovery, message).toBeDefined();
  });

  /**
   * Found by the tool fuzz: `reticle_screenshot { name: <100KB> }` was answered with "this error is
   * not one Reticle recognizes, which means it may be a defect in Reticle". Reticle wrote that
   * validator. The caller's name was invalid — a rejected ARGUMENT, and the one class of error we
   * already decided never to blame on ourselves.
   *
   * These get their own recovery rather than the generic schema one: the parameter exists and the
   * types are right, so "re-read the tool's parameters" is the wrong advice. What the caller needs
   * is the shape a name must have.
   */
  it.each([
    ['a baseline name', 'invalid visual baseline name: ../etc/passwd'],
    ['a diff name', 'invalid visual diff name: has spaces'],
  ])("%s is the caller's to fix, not a Reticle defect", (_label, message) => {
    const payload = buildErrorPayload(message);
    expect(payload.feedback, message).toBeUndefined();
    expect(payload.recovery, message).toBe(RECOVERY.INVALID_NAME);
  });

  it('the invalid-name recovery states the shape a name must have', () => {
    // A recovery that does not say what "valid" means costs the agent a guessing turn.
    expect(RECOVERY.INVALID_NAME).toMatch(/letters|a-z/i);
    expect(RECOVERY.INVALID_NAME).toMatch(/64/);
  });

  it('a genuinely unrecognized failure still asks for feedback', () => {
    // The ask must keep working, or this fix trades one silence for another.
    const payload = buildErrorPayload('ECONNRESET while flushing the observer queue');
    expect(payload.feedback).toBeDefined();
  });
});

/**
 * A tool error must never hand the agent back its own argument at full size.
 *
 * Found by fuzzing all 48 tools with a 100KB string in their first string parameter.
 * `reticle_screenshot { name: 'x'.repeat(100_000) }` answered with a **100,392-byte** tool result:
 * the whole argument, echoed inside "invalid visual baseline name: …". In a library that sells
 * token efficiency, a caller's typo should not be able to bill them for 25k tokens — and the same
 * echo is how an unbounded value reaches a log, a terminal, or a transcript.
 *
 * Capping is not enough on its own: the classifier keys off substrings that usually sit at the END
 * of the message ("… no longer resolves to an element"), so a plain head-truncation severs exactly
 * the part that makes the error recognizable and turns a known condition into "may be a defect in
 * Reticle". That is not hypothetical — it is the second half of what the fuzz reported. So the cap
 * elides the MIDDLE and keeps both ends.
 */
describe('error messages are bounded before they reach the agent', () => {
  const huge = 'x'.repeat(100_000);

  it('caps a message that echoes a huge argument', () => {
    const payload = buildErrorPayload(`invalid visual baseline name: ${huge}`);
    expect(payload.error.length).toBeLessThanOrEqual(TRANSPORT_LIMITS.MAX_ERROR_LENGTH);
  });

  it('keeps the head, so the caller still learns what was wrong', () => {
    const payload = buildErrorPayload(`invalid visual baseline name: ${huge}`);
    expect(payload.error).toMatch(/^invalid visual baseline name: x+/);
  });

  it('keeps the TAIL, so a known error is still recognized after capping', () => {
    // Head-only truncation loses "no longer resolves to an element" and the stale-ref recovery with
    // it — the agent is then told its own stale ref may be a Reticle bug.
    const payload = buildErrorPayload(`ref '${huge}' no longer resolves to an element`);
    expect(payload.recovery).toBe(RECOVERY.STALE_REF);
    expect(payload.feedback).toBeUndefined();
  });

  it('says that it elided, rather than silently presenting a partial value', () => {
    const payload = buildErrorPayload(`invalid visual baseline name: ${huge}`);
    expect(payload.error).toMatch(/elided/i);
  });

  it('leaves an ordinary message untouched', () => {
    const message = 'no browser session connected — is your app running?';
    expect(buildErrorPayload(message).error).toBe(message);
  });
});

/**
 * The sweep the e2e tool-surface spec does over a live daemon, done in the fast gate over the real
 * thrown strings instead.
 *
 * `tool-surface-sweep-test.mjs` asserts ONE property — no response carries "not one Reticle
 * recognizes" for a condition Reticle itself authored — but it can only see the conditions a single
 * drive happens to provoke. A scope mismatch needs two projects, a mid-call disconnect needs a tab
 * closing at the right instant, and a command timeout needs a wedged page: none of those occur in a
 * sweep, so all three shipped with the defect ask attached while the spec stayed green.
 *
 * So the same property is asserted here against messages COPIED from the throw sites (each case
 * names its source), which is the only part of the check that does not need a browser.
 */
describe('no condition Reticle itself authored is reported as a possible Reticle defect', () => {
  it.each([
    // session-manager.ts — scopeMissError
    [
      'a scope mismatch',
      "no browser session for project 'shop', but 1 session(s) ARE connected under a different " +
        "project: 'atlas' (http://localhost:4310/, sessionId 's1'). The daemon scopes to the " +
        '.reticle.json of the directory it was started in, so this is a scope mismatch, not a dead ' +
        "app. Pass the sessionId above to target one, or restart the daemon from that app's directory.",
      RECOVERY.SCOPE_MISMATCH,
    ],
    // session-manager.ts — remove() rejects every in-flight command with this exact reason
    ['a session that disconnected mid-call', 'session disconnected', RECOVERY.SESSION_GONE],
    // command-timeout.ts — the bare form, and both forms that already carry advice
    ['a command timeout', "command 'snapshot' timed out after 8000ms", RECOVERY.COMMAND_TIMEOUT],
    [
      'an act timeout',
      "command 'act' timed out after 8000ms. The page is ALIVE — the SDK last reported to the " +
        'bridge 200ms ago — but it is not answering commands.',
      RECOVERY.COMMAND_TIMEOUT,
    ],
    // act-danger.ts — the two destructive blocks the existing rule did not cover
    [
      'a blocked WebMCP tool',
      'potentially destructive WebMCP tool blocked; retry with confirmDangerous=true',
      RECOVERY.CONFIRM_DANGEROUS,
    ],
    [
      'a blocked native action',
      'potentially destructive native action blocked; retry with args.confirmDangerous=true',
      RECOVERY.CONFIRM_DANGEROUS,
    ],
    // query-strategy.ts
    [
      'an unsupported query strategy',
      "unsupported query strategy 'colour' — use one of: role, text, testid",
      RECOVERY.BAD_ARGUMENTS,
    ],
    // flows/replay.ts — a recorded step whose anchor is gone
    [
      'a flow anchor that no longer resolves',
      "testid 'save-button' did not resolve in current page",
      RECOVERY.FLOW_STEP_MISSING,
    ],
    // lease-tools.ts / playwright-launcher.ts — the pool is simply not there
    [
      'an unavailable browser pool',
      'browser pool unavailable — the lease tools need the daemon-managed pool (start Reticle via `reticle mcp`).',
      RECOVERY.NO_POOL,
    ],
    [
      'a missing Chromium',
      'Chromium is not installed for Playwright. Run: npx playwright install chromium',
      RECOVERY.NO_POOL,
    ],
    [
      'a hover without a real pointer',
      'cannot hover without a real pointer — CSS :hover only applies to a native mouse move, never to a synthetic mouseover',
      RECOVERY.HOVER_NEEDS_POINTER,
    ],
    [
      'a sequence that names two sessions',
      "reticle_act_sequence steps name different sessionIds ('lease-1' and 'tab-old'). " +
        'Pass one sessionId at the top level to target a tab. Nothing was acted on.',
      RECOVERY.BAD_ARGUMENTS,
    ],
  ])('%s is recognized', (_label, message, expected) => {
    const payload = buildErrorPayload(message);
    expect(payload.feedback, message).toBeUndefined();
    expect(payload.recovery, message).toBe(expected);
  });

  /**
   * act-danger.ts prescribes the exact retry ("use reticle_act { args: { native: true } } …"), so a
   * second, more generic hint would only argue with it — but it must not collect the defect ask.
   */
  it('a refusal that already prescribes its own retry gets neither a hint nor the ask', () => {
    const payload = buildErrorPayload(
      'reticle_act_and_wait cannot drive native input, so args.native would be ignored. Use ' +
        'reticle_act { args: { native: true } } for the trusted click, then assert the consequence.',
    );
    expect(payload.feedback).toBeUndefined();
    expect(payload.recovery).toBeUndefined();
  });
});

/**
 * A refused select must arrive as an invalid call, not as a possible Reticle defect — and the
 * recovery has to warn that option VALUES are not the visible labels, which is the mistake that
 * produces this error most often.
 */
describe("a select with no such option is the caller's to fix", () => {
  it('gets the option recovery, never the defect ask', () => {
    const payload = buildErrorPayload(
      "no <option> with value 'English' — available: en (English), fr (French)",
    );
    expect(payload.feedback).toBeUndefined();
    expect(payload.recovery).toBe(RECOVERY.NO_SUCH_OPTION);
  });

  it('warns that values are not labels', () => {
    expect(RECOVERY.NO_SUCH_OPTION).toMatch(/label/i);
  });
});

/**
 * The unknown-session refusal now names the live ids inline (see `SessionManager` — one agent
 * looped twelve times against a dead id, 21% of a whole day's tool errors). Appending "call
 * reticle_sessions for the current ids" to a message that just listed them is not merely redundant:
 * it contradicts the shorter path the message offers, and a contradicted instruction is how the
 * loop started.
 */
describe('a refusal that already lists the live sessions is left alone', () => {
  it('adds no generic hint when the message names connected sessions', () => {
    const message =
      "no connected session with id 'ghost'. Connected right now: 'a' (http://localhost:3000/). " +
      'Retry with one of those, or omit sessionId entirely and let Reticle scope to your project.';
    expect(recoveryFor(message)).toBeUndefined();
  });

  it('still helps when the id is unknown and the message carries no list', () => {
    expect(recoveryFor("no connected session with id 'ghost'")).toBe(RECOVERY.UNKNOWN_SESSION);
  });
});

/**
 * A malformed predicate is the AGENT'S mistake, and must never be dressed as a Reticle defect.
 *
 * `ARGUMENT_REJECTION` keys on the shapes our validators produce. When `parsePredicate` replaced the
 * raw zod array with a sentence, it removed the very codes (`invalid_type`, `unrecognized_keys`)
 * that pattern matched — so a bad predicate fell through to the generic branch and came back as
 * "may be a defect in Reticle", with a request for a bug report.
 *
 * That is worse than the dump it replaced: it spends the agent's turn and pollutes the feedback
 * channel with reports about malformed calls. The e2e battery caught it — `no bad argument is
 * blamed on Reticle`, on `reticle_wait_for/empty` and `reticle_assert/empty` — after a full unit
 * gate had passed. This is that check, in the gate that runs in seconds.
 */
describe('a predicate that did not parse is the agent to fix, not a Reticle bug', () => {
  const REAL_MESSAGE =
    'that predicate did not parse (kind "route"): unknown field pathnmae. Nothing ran — the ' +
    'predicate was not evaluated, so no verdict was produced.';

  it('gets the schema-rejection recovery', () => {
    const payload = buildErrorPayload(REAL_MESSAGE);
    expect(String(payload.recovery)).toContain("did not match the tool's schema");
    expect(String(payload.recovery)).toContain('Nothing ran');
  });

  it("does not invite a bug report about the agent's own call", () => {
    expect(JSON.stringify(buildErrorPayload(REAL_MESSAGE))).not.toMatch(
      /defect in Reticle|report this/i,
    );
  });
});

/**
 * The SDK's own schema rejection arrives as a serialized zod ARRAY, and this is the one boundary
 * every agent-visible failure crosses — so it is where the array stops being the error text.
 *
 * `parsePredicate` fixed this for the three predicate tools by never producing the array. It cannot
 * help anywhere else: `action` on a merged tool is validated by the MCP SDK BEFORE our handler runs,
 * so the friendly "unknown action … expected: [tune, yield, …]" the handler already builds is
 * unreachable for the commonest mistake of all, calling `reticle_session` with no action. What the
 * agent got instead was the raw array. Driven live against the shipped daemon on `reticle_assert`.
 *
 * Fixing it HERE rather than per-tool is the point: one boundary, every tool, including ones nobody
 * has written yet.
 */
describe('a serialized zod array is rendered as a sentence', () => {
  const ZOD_ARRAY = JSON.stringify([
    {
      code: 'invalid_type',
      expected: 'string',
      received: 'undefined',
      path: ['action'],
      message: 'Required',
    },
    {
      code: 'unrecognized_keys',
      keys: ['mode'],
      path: [],
      message: "Unrecognized key(s) in object: 'mode'",
    },
  ]);

  it('names the parameter instead of dumping the array', () => {
    const payload = buildErrorPayload(ZOD_ARRAY);
    expect(payload.error).toContain('action: Required');
    expect(payload.error).toContain('unknown field mode');
    expect(payload.error).not.toContain('invalid_type');
    expect(payload.error).not.toContain('[{');
  });

  it('still classifies as the agent to fix, not a Reticle defect', () => {
    const payload = buildErrorPayload(ZOD_ARRAY);
    expect(String(payload.recovery)).toContain("did not match the tool's schema");
    expect(JSON.stringify(payload)).not.toMatch(/defect in Reticle|report this/i);
  });

  it('leaves an ordinary message alone — this only rewrites the array shape', () => {
    const plain = 'ref e42 no longer resolves to an element';
    expect(buildErrorPayload(plain).error).toBe(plain);
  });

  it('leaves JSON that is not a zod issue array alone', () => {
    // A tool legitimately returning a JSON array must not be reworded into a schema complaint.
    const notIssues = JSON.stringify([{ url: '/api/x', status: 500 }]);
    expect(buildErrorPayload(notIssues).error).toBe(notIssues);
  });
});

/**
 * A validation sentence produced UPSTREAM must not be read as an unrecognized Reticle failure.
 *
 * `ARGUMENT_REJECTION` keys on the shapes our validators produce, and it has now been widened twice
 * for the same reason: every time a layer replaces a raw zod dump with prose, the codes this pattern
 * matched (`invalid_type`, `unrecognized_keys`) disappear with it, and the rejection falls through
 * to "may be a defect in Reticle" — which asks a contributor for a bug report about the agent's own
 * malformed call.
 *
 * Third time. The trigger here is PR #182, which formats the MCP SDK's validation error at the arg
 * boundary into "Missing required parameter for reticle_session: action (one of: …). Nothing ran."
 * That is strictly better prose than the field-level sentence produced downstream — it names the
 * TOOL and the allowed VALUES — and it was authored before the downstream formatter existed. It
 * should not be punished for arriving first.
 */
describe('an upstream validation sentence is still the caller to fix', () => {
  const MISSING =
    'Missing required parameter for reticle_session: action ' +
    '(one of: tune, yield, end, resume, messages, review, narrate). Nothing ran.';
  const INVALID = 'Invalid parameter for reticle_act: action (Invalid enum value). Nothing ran.';

  it('a missing-parameter sentence gets the schema recovery, not a bug-report ask', () => {
    const payload = buildErrorPayload(MISSING);
    expect(String(payload.recovery)).toContain("did not match the tool's schema");
    expect(JSON.stringify(payload)).not.toMatch(/defect in Reticle|report this/i);
  });

  it('an invalid-parameter sentence is treated the same way', () => {
    const payload = buildErrorPayload(INVALID);
    expect(String(payload.recovery)).toContain("did not match the tool's schema");
    expect(JSON.stringify(payload)).not.toMatch(/defect in Reticle/i);
  });

  it('still asks for a report on an error it genuinely does not recognize', () => {
    // The control. Widening the pattern until everything looks like the caller's fault would
    // silence the feedback channel this project depends on.
    const payload = buildErrorPayload('the presenter pool exploded');
    expect(JSON.stringify(payload)).toMatch(/defect in Reticle/i);
  });
});

describe('a selector that missed is not a malformed call', () => {
  /**
   * Measured live, driving the bench app: `target: { testid: "new-deploy" }` on a view that had not
   * rendered yet returned "target matched no element … take a reticle_snapshot", and the recovery
   * appended was *"That call did not match the tool's schema — re-read that tool's parameters"*.
   *
   * The call matched the schema perfectly. The element was not on the page. Sending an agent to
   * re-read arguments that were already correct costs it a turn on the commonest refusal there is —
   * and it was the catch-all rule that claimed it, because the error's OWN advice names
   * `reticle_snapshot`, which is exactly what that rule keys on.
   */
  const missed =
    'target matched no element. Nothing was acted on and no verdict is possible — widen the ' +
    'query, or take a reticle_snapshot to see what is actually on the page.';

  it('does not tell the caller its arguments were wrong', () => {
    const hint = recoveryFor(missed);
    expect(hint).toBeDefined();
    expect(hint).not.toMatch(/did not match the tool's schema/);
    expect(hint).not.toMatch(/re-read that tool's parameters/);
  });

  it('says the call was valid and nothing was acted on', () => {
    const hint = recoveryFor(missed) ?? '';
    expect(hint).toMatch(/valid/i);
    expect(hint).toMatch(/nothing was.*acted on/i);
  });

  /** An unmatched message collects the feedback ask, which is how agents get pushed to report a miss. */
  it('is still matched, so it never collects a defect report', () => {
    expect(recoveryFor(missed)).toBeDefined();
  });
});

describe('the destructive-control refusal names the argument it wants', () => {
  /**
   * A benchmark run spent its ENTIRE 25-turn budget here. The refusal said "retry with
   * args.confirmDangerous=true"; the agent looked for a top-level parameter by that name, did not
   * find one, and went back to re-read the tool list instead of retrying. The flag is documented —
   * inside the `args` object's own description — so the dotted path was pointing at something that
   * is not a parameter.
   */
  const blocked =
    'potentially destructive native action blocked; retry with args.confirmDangerous=true';

  it('shows the argument object rather than a dotted path', () => {
    const hint = recoveryFor(blocked) ?? '';
    expect(hint).toMatch(/args: \{ confirmDangerous: true \}/);
    expect(hint).toMatch(/inside the `args` object/);
  });

  /**
   * The classifier matches `deploy` and `publish`, so an ordinary "New deploy" button trips it.
   * Listing only delete/remove/revoke made the refusal read as a malfunction on an app where
   * nothing was being destroyed.
   */
  it('names a trigger word that is not destruction', () => {
    expect(recoveryFor(blocked) ?? '').toMatch(/deploy|publish/);
  });
});
