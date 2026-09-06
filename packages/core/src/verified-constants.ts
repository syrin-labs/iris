/**
 * The ONE field an agent reads to decide whether a change is verified.
 *
 * An action result carries eight trust dimensions — dispatched, settled, ok, grade, attribution,
 * coverage, integrity, and the assertion verdict — and until now no rule for combining them. Driving
 * this surface produced `settled:false, settleReason:"timeout"` on a fill, and there was no way to
 * tell whether that was a bug or noise; the honest answer was "I could not tell", and the honest
 * answer was unavailable. Eight judgment calls per action is eight chances to guess wrong.
 *
 * UNKNOWN is load-bearing and must never collapse into NO. "The capture was truncated so I could not
 * see" and "the app is broken" lead an agent to opposite next moves: one says look again with better
 * coverage, the other says go fix something. Merging them manufactures both false alarms and false
 * confidence, which is the entire failure class this project exists to remove.
 */
export const Verified = {
  /** Proved: the assertion held, at a real grade, over a clean capture, with no channel disagreeing. */
  YES: 'yes',
  /** Disproved: the assertion failed, or the channels contradict each other. Go look. */
  NO: 'no',
  /** Not determinable from this evidence — vacuous grade, dirty capture, or never settled. */
  UNKNOWN: 'unknown',
  /**
   * The engine saw the whole window, ran every oracle, and found nothing wrong — but nothing was
   * declared to prove, so this is not verification.
   *
   * Distinct from `unknown`, which used to carry both this and "I could not see". The two need
   * opposite responses: this one says ASSERT SOMETHING, the other says LOOK AGAIN WITH BETTER
   * COVERAGE, and collapsing them into one word sent people to fix the wrong thing.
   *
   * Two properties keep it honest, and both are enforced rather than documented: it requires a
   * SETTLED window, so it cannot be earned by returning early, and it is never `yes`, so it cannot be
   * mistaken for proof. Without the first it would be the green-forever button that an
   * always-available "nothing was wrong" always becomes.
   */
  NO_FAULT: 'no-fault',
} as const;
export type Verified = (typeof Verified)[keyof typeof Verified];

/**
 * WHY a verdict came out the way it did — the deciding clause of the rule, named.
 *
 * `Verified` has three values and the rule has eleven clauses, so the wire collapsed opposite facts
 * into one string. Measured over a real session: `unknown` covered "the agent malformed the call",
 * "the app answered 202 and has not finished", and "Reticle could not see the capture" — three
 * owners needing three opposite responses, one bar on a dashboard. `no` was no better: "channels
 * disagree" (Reticle earning its keep) and "the agent's predicate failed" read identically.
 *
 * This is the SINGLE list. `decideVerified` returns a member from each clause, and the telemetry
 * schema narrows to `z.nativeEnum` of this — so a new clause cannot ship without a member here, and
 * a member cannot exist without a clause producing it (`verified.test.ts` asserts the two sets are
 * equal). Nothing anywhere re-lists these.
 */
export const VerifiedReason = {
  /** The assertion was never EVALUATED — under-specified call, or nothing instrumented to read. */
  INCONCLUSIVE: 'inconclusive',
  /**
   * The tab went away mid-wait, so the action's outcome was never observed. NOT a failure.
   *
   * This existed as a fact and had nowhere to go. `waitForPredicate` finishes a disconnected wait
   * with `{ pass: false, failureReason: 'session disconnected' }`, and the only clause that took a
   * false `pass` said ASSERTION_FAILED — so a reload during a wait produced, verbatim:
   *
   *   verified: "no", verifiedReason: "assertion_failed",
   *   because: "the declared consequence did not hold", source: "src/components/Counter.tsx:18"
   *
   * The app was fine; the observer left. An agent reading that goes and edits Counter.tsx. Every
   * other clause in this rule is tuned to avoid claiming more than was observed, and the absence of
   * this member made the nearest available answer a false claim in the opposite direction — a false
   * RED, from the layer whose entire job is not to produce one.
   */
  OBSERVATION_LOST: 'observation_lost',
  /**
   * The request the assertion named was still in flight when the window closed, so a miss is not a
   * failure — the consequence had not finished. NEVER `"no"`.
   *
   * Measured: `act_and_wait` returned `verified: "no"` / `assertion_failed` while the same result's
   * contradictions named the matching POST as still in flight. The request completed 200 half a
   * second after the window; a warm backend on the same assertion came back `yes`. A red that flips
   * green when the backend warms up teaches the agent to loosen checks — the behaviour the docs
   * forbid. See #669.
   */
  WINDOW_CLOSED_EARLY: 'window_closed_early',
  /** The declared consequence did not hold. */
  ASSERTION_FAILED: 'assertion_failed',
  /** Channels disagreed about the action — the false green this product exists to catch. */
  CONTRADICTED: 'contradicted',
  /** The consequence was already true beforehand, so it proves nothing about the action. */
  ALREADY_TRUE: 'already_true',
  /** The capture was not clean, so a green would only describe what happened to be observed. */
  UNCLEAN_CAPTURE: 'unclean_capture',
  /**
   * Nothing was asserted at a real grade — the assertion could not have failed — AND the window did
   * not settle, so the engine cannot even say it looked at the whole thing.
   */
  VACUOUS_GRADE: 'vacuous_grade',
  /** Nothing was asserted at a real grade, but the window settled and no channel reported a problem. */
  NOTHING_DECLARED: 'nothing_declared',
  /** A write answered 202 Accepted: the outcome does not exist yet. */
  OUTCOME_PENDING: 'outcome_pending',
  /** A 2xx whose body was never recorded, so the one channel that could disagree was closed. */
  OUTCOME_UNREAD: 'outcome_unread',
  /** The page never settled, so the reaction window may have closed early. */
  UNSETTLED: 'unsettled',
  /**
   * The assertion held, but a channel's outcome had not been observed when the window closed — an
   * ABSENCE-derived finding (see ABSENCE_DERIVED_CONTRADICTIONS), not evidence against the action.
   *
   * Split out of UNSETTLED because that word is a claim about idle, and this clause fires
   * independently of whether the page went idle. One field report was, verbatim, "internally
   * contradictory": `verifiedReason: "unsettled"` beside `settled: true`, a passing nested verdict,
   * the requested POST at 200 and a clean console. Both halves came from this rule, and a verdict
   * whose own evidence block denies its stated reason is a verdict nobody can act on.
   */
  EVIDENCE_INCOMPLETE: 'evidence_incomplete',
  /** Held at a real grade over a clean capture with no channel disagreeing. */
  PROVED: 'proved',
  /** A passing absence assertion targeted a region Reticle could not observe. */
  ABSENCE_BLIND_SPOT: 'absence_blind_spot',
} as const;
export type VerifiedReason = (typeof VerifiedReason)[keyof typeof VerifiedReason];

/**
 * WHAT made a capture unclean — the closed vocabulary behind `UNCLEAN_CAPTURE`.
 *
 * `unclean_capture` names three losses that belong to three different owners and need three
 * different fixes: our server buffer, our browser transport, and a boundary in the page that nobody
 * can see through. Until this existed they arrived as one value on a dashboard and as one sentence
 * of free prose in `integrity.issues`, which is not something a query can group by.
 *
 * That cost real time. `unclean_capture` became a large share of all `unknown` verdicts in the
 * field, and answering "which of the three?" took reading the eviction policy, because the data
 * could not say. It was the first one, and it was a false alarm.
 */
export const CaptureLoss = {
  /** The server ring buffer evicted scarce evidence that belonged to the observation window. */
  BUFFER_LOSS: 'buffer_loss',
  /** The browser-side queue overflowed, so part of the window never reached the daemon at all. */
  TRANSPORT_GAP: 'transport_gap',
  /** A region the SDK cannot see through — a cross-origin frame, a closed shadow root. */
  BLIND_SPOT: 'blind_spot',
  /** A loss we have not classified. A classifier that cannot say "I don't know" lies instead. */
  OTHER: 'other',
} as const;
export type CaptureLoss = (typeof CaptureLoss)[keyof typeof CaptureLoss];

/**
 * Actionable companion to NO_PROVIDER for the tools that genuinely intercept or capture through CDP
 * — network mocking and viewport control — which is NOT "visual capture".
 *
 * They used to return VISUAL_NO_PROVIDER_RECOMMENDATION verbatim, so asking to stub a request was
 * answered with "visual capture needs a driven browser". An agent reading that concludes it asked
 * the wrong KIND of question and goes looking for a screenshot tool, when the requirement is simply
 * a driven browser.
 */
/**
 * The machine-readable half of the same correction.
 *
 * `network_mock` and `viewport` returned `reason: "no-visual-provider"`, so an agent gating on the
 * code — the field that exists precisely to be matched on — was gating on a false statement: neither
 * tool captures anything visual. Fixing only the human-readable recommendation would have left the
 * lie in the part machines read, which is the wrong half to leave wrong.
 *
 * Safe to introduce: nothing outside this repo matches the old code, and the visual tools keep it.
 */
export const CDP_NO_PROVIDER_REASON = 'no-cdp-provider';

export const CDP_NO_PROVIDER_RECOMMENDATION =
  'this needs a Reticle-driven browser (it is applied through CDP, which the always-on SDK cannot do) — start with `reticle drive <url>` or set RETICLE_CDP_URL';

/**
 * A region the SDK cannot see into — surfaced (never hidden) so a result's coverage reads honestly.
 * Crosses the wire in a BLIND_SPOT event's `kind`, so it lives in core (the contract), not the server.
 */
export const BlindSpotKind = {
  CLOSED_SHADOW_ROOT: 'closed-shadow-root',
  /**
   * The bridge sampled: events arrived faster than its per-second cap, so some were dropped.
   *
   * This replaces DISCONNECTING, which is the one thing an observability layer must not do when it
   * sees too much. Measured: every network request emits two messages (pending + settled), so the cap
   * binds at ~500 requests/second — reachable by a dashboard burst and continuous for a streaming app.
   * Going blind there meant the biggest, most complex apps were exactly the ones Reticle could not
   * watch, and the failure was silent.
   *
   * Reported like any other blind spot, so a verdict over a sampled window says `coverage: partial`
   * instead of implying it saw everything.
   */
  RATE_LIMITED: 'rate-limited',
  CROSS_ORIGIN_IFRAME: 'cross-origin-iframe',
  /**
   * A SAME-ORIGIN frame, whose DOM is observed but whose NETWORK is not.
   *
   * A frame's `fetch`/`XMLHttpRequest` live in the frame's own realm, and the top realm's patch never
   * sees them. Declared rather than half-instrumented: a request channel that is partly seen produces
   * a `settled` that can be true while a frame request is still in flight, which is a false green.
   */
  UNINSTRUMENTED_FRAME: 'uninstrumented-frame',
  VIRTUALIZED_UNMOUNTED: 'virtualized-unmounted',
  /**
   * Something wrapped `fetch` before we did, so the request we record is not necessarily the request
   * that leaves. Wrappers chain outermost-first: anything installed EARLIER sits below us and mutates
   * after we have read `init.body`. An interceptor initialised before connect(), or a polyfill, does
   * exactly that. Unfixable from inside the page — there is no "patch last" primitive — so it is
   * declared instead, and a verdict over it reports partial coverage rather than implying we saw the wire.
   */
  WRAPPED_NETWORK: 'wrapped-network',
  /**
   * An Electron renderer with no preload shim installed: every `ipcRenderer.invoke` is invisible.
   *
   * A desktop app reaches its backend over IPC, not HTTP, so without the shim `reticle_network`
   * reports NOTHING — which reads as "this app makes no backend calls" rather than "you are blind to
   * all of them", and makes `assert { net }` vacuously true. The SDK can tell the difference (it is
   * running in Electron and the preload global is absent), so it says so instead of letting the
   * silence pass for a clean result. `reticle doctor` names the one-line fix.
   */
  UNOBSERVED_IPC: 'unobserved-ipc',
  /**
   * A one-way IPC `send` in this window: dispatched, with NO verdict to observe.
   *
   * `ipcRenderer.send` returns immediately and the renderer never learns whether the main process
   * handled it, so there is nothing to assert on. This is not a failure — it is an outcome that is
   * structurally unobservable, and it has to read that way. Without it a fire-and-forget send lands
   * as a clean green ("the UI said Marked as seen, no channel disagreed"), which is a false green the
   * evidence cannot rule out, while treating it as a failure is a false red on a healthy app. So it
   * is declared, and the verdict over it reports partial coverage.
   */
  VERDICTLESS_SEND: 'verdictless-send',
  /**
   * No SUBSCRIBABLE store is registered, so the app's own state is unobservable.
   *
   * Without it, "the store did not change" and "nothing was watching the store" are the same empty
   * `stateDiffs` — and the first reading is a confident wrong answer. It is the common case, not an
   * exotic one: `init` writes a capabilities file that registers nothing until someone edits it, and
   * a store passed as a bare getter is readable but silent, so an app can hold state, change it on
   * every click, and report an empty state channel forever with no error anywhere.
   *
   * BOUNDING, never impeaching (see `impeachesCapture`): what WAS observed — DOM, network, console,
   * storage — is observed completely. Only the state channel is dark, and it lights up the moment a
   * subscribable store registers, which is when the SDK emits this kind with count 0.
   */
  UNWATCHED_STATE: 'unwatched-state',
} as const;
export type BlindSpotKind = (typeof BlindSpotKind)[keyof typeof BlindSpotKind];

/**
 * Blind spots that only exist in an Electron renderer.
 *
 * Presence in the vocabulary is not evidence the page is a desktop app — a web session can still
 * carry these kinds if the SDK keyed off a user-agent substring. Gate them on the session runtime
 * (which the page already reports) rather than on the kind existing.
 */
export function isDesktopBlindSpot(kind: BlindSpotKind): boolean {
  return kind === BlindSpotKind.UNOBSERVED_IPC || kind === BlindSpotKind.VERDICTLESS_SEND;
}
