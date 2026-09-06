---
title: Complete usage guide
description: 'The full reference and cookbook: every tool, flag, and workflow, with worked examples.'
icon: book
---

Every Reticle drive is the same four steps: **look** (`reticle_snapshot` / `reticle_query`), **act** (`reticle_act` / `reticle_act_sequence`), **observe** (`reticle_observe` / `reticle_network` / `reticle_state`), **assert** (`reticle_assert`). Only `reticle_act_and_wait` and `reticle_assert` produce a verdict, so a run that ends anywhere else proved nothing. This page is the full reference for every tool, predicate, action and flag in that loop.

If you haven't set up Reticle yet, start with [Getting Started](getting-started.md).

> **Start here instead, unless you want the long form.** This page predates the focused reference and still holds the fullest single narrative, but almost everything in it now has a page of its own that is shorter, searchable and verified against a running app:
>
> | Looking for                                | Go to                                   |
> | ------------------------------------------ | --------------------------------------- |
> | One tool, with a real request and response | [Tools reference](/tools-overview)      |
> | The predicate grammar                      | [Predicates](/predicates)               |
> | Every action and its arguments             | [Actions](/actions)                     |
> | Worked examples for real situations        | [Recipes](/recipes)                     |
> | Baselines, clock, crawl, mocking, flows    | [Beyond the verify loop](/capabilities) |
> | Habits that make a verdict trustworthy     | [Best practices](/best-practices)       |
> | Common questions                           | [FAQ](/faq)                             |
>
> What is still only here: turning existing test cases into agent checks (§11), the security and privacy detail (§15), and real input mode (§18).

> **On the notation.** Examples here are written as `reticle_act({ ref, action })`, which is shorthand for "call that tool with these arguments". Over MCP you do not write JavaScript; your client sends the tool name and an arguments object. The shorthand is shorter to read, and the argument shapes are identical either way.
>
> If you want examples in the exact JSON your client sends, [Recipes](/recipes) has them, and every response on that page was captured from a running app.

**Contents**

1. [How Reticle helps you](#1-how-reticle-helps-you)
2. [Core concepts](#2-core-concepts)
3. [The tools: full reference](#3-the-tools-full-reference)
4. [The predicate DSL: full reference](#4-the-predicate-dsl-full-reference)
5. [Actions: full list](#5-actions-full-list)
6. [Snapshot modes & scoping](#6-snapshot-modes--scoping)
7. [Cookbook: real situations](#7-cookbook-real-situations)
8. [Regression: baselines & diff](#8-regression-baselines--diff)
9. [Recording a flow](#9-recording-a-flow)
10. [Autonomous exploration](#10-autonomous-exploration)
11. [Turning your test cases into agent checks](#11-turning-your-test-cases-into-agent-checks)
12. [Token discipline](#12-token-discipline)
13. [Best practices & gotchas](#13-best-practices--gotchas)
14. [FAQ](#14-faq)
15. [Security & privacy](#15-security--privacy)
16. [Presenter mode, narration & fake clock](#16-presenter-mode-narration--fake-clock-watch--control)
17. [Evidence-of-effect, act+await, state, capabilities, replay](#17-evidence-of-effect-actawait-state-capabilities-replay)
18. [Real input mode: native hover & drag](#18-real-input-mode-native-hover--drag)

---

## 1. How Reticle helps you

You mostly **talk to your agent in plain English**: "add X and verify it works." The agent uses Reticle under the hood. Here's the value, by situation:

- **You stop being the agent's eyes.** Today you build a feature, then _you_ click through the browser to check it. With Reticle the agent checks its own work and only comes back when it's actually verified, or with a precise reason it failed.
- **Silent breakage gets caught.** A console error, a 500 on one locale, a button that quietly disappeared after a refactor: humans skim past these; Reticle asserts on them.
- **The fix loop closes.** When something's wrong, Reticle reports the _evidence_: the failing network call, the console stack, and (on React) the **source file:line** to edit.
- **It's cheap enough to run constantly.** ~100 tokens per verified interaction means the agent can verify on _every_ edit, not just at the end (see [token-efficiency](token-efficiency.md)).
- **Your manual QA becomes automated.** The checklist you never turned into Playwright tests? Your agent runs it now (see [§11](#11-turning-your-test-cases-into-agent-checks)).

Who benefits most: anyone shipping **dashboards, internal tools, SaaS apps**. Behavior-heavy UIs with lots of forms, lists, modals, and API calls that change often.

---

## 2. Core concepts

**The loop: look → act → observe → assert.**

1. **Look** with `reticle_snapshot` (what's on screen) or `reticle_query` (find a specific thing).
2. **Act** with `reticle_act` (click/fill/…). It returns a `since` cursor, a timestamp marker.
3. **Observe** with `reticle_observe({ since })`: everything the app did _after_ that action.
4. **Assert** with `reticle_assert({ predicate })`. Verify it, get evidence.

**Refs.** Elements are addressed by stable handles like `e7`. You get them from `snapshot` or `query`, then pass them to `act`/`inspect`. A ref re-resolves to its element across re-renders; if the element is gone, you get a clear error.

**Evidence, not prose.** Every tool returns structured data (counts, the matching network call, the snapshot delta) so the agent reasons over facts, not a vibe.

**Sessions.** Each connected browser tab is a session (named via `reticle.connect({ session })`). With one tab open you never specify it; with several, pass `sessionId`.

---

## 3. The tools: full reference

### `reticle_sessions`

List connected tabs. → `{ sessions: [{ sessionId, url, title, lastSeenMs, hidden, focused, throttled }] }`. `lastSeenMs` is the silence since the tab last reported (not time-since-connect); `throttled` is `true` when the tab is hidden or has gone quiet, and a throttled tab silently no-ops timers/rAF/pointer.

### `reticle_snapshot`

A semantic, accessibility-tree view of the page.

- **args:** `mode?: 'full' | 'interactive' | 'status'` (default `full`), `scope?` (CSS selector or ref), `diff?: boolean`, `sessionId?`.
- **returns:** `{ tree, status: { route, title, visibleDialogs, overlayHidingPage }, nodes, truncated, cost: { bytes, tokens } }`.
- **`diff: true`** returns only what changed since your last snapshot of the same scope/mode: `{ mode: 'delta', delta: { added, removed, addedCount, removedCount } }` or `{ mode: 'unchanged' }` (no full tree). The first call (and any call after a route change) still returns the full tree. ~99% fewer tokens to re-look after an action; see [token-efficiency.md](token-efficiency.md).
- **`cost`** is an estimated size of the result. Re-scope (`mode`/`scope`) before reading if large.

```jsonc
reticle_snapshot({ mode: "interactive" })
// - tab "Overview" (ref=e2)
// - button "Add item" (ref=e5)
// status: { route: "/dashboard", visibleDialogs: [] }

reticle_snapshot({ diff: true }) // after an action: only the change set
// { mode: "delta", delta: { added: ['- alert "Saved!"'], removed: [], addedCount: 1, removedCount: 0 } }
```

### `reticle_query`

Find elements (Testing-Library semantics).

- **args:** `by: 'role'|'text'|'label'|'placeholder'|'testid'|'alt'`, `value`, `name?` (for role), `scope?`, `sessionId?`.
- **returns:** `{ elements: [{ ref, role, name, value?, states, visible, text? }] }`.

```jsonc
reticle_query({ by: "role", value: "button", name: "Save" })   // → ref + descriptor
```

### `reticle_inspect`

Deep detail on one element, including the signals a snapshot/a11y tree omits, so you can tell "present" from "actually usable / on-theme".

- **args:** `ref`, `sessionId?`.
- **returns:** descriptor + `tag` + `box` + `occluded` (another element covers its center: a z-index/overlay bug) + `styles { color, backgroundColor, opacity, cursor, display, visibility }` + `theme { colorToken, colorTokens, backgroundToken, backgroundTokens, offTheme, tokenCount, themeScope }` (compliance vs the app's design tokens, where `offTheme:true` flags an off-palette color; the plural fields list every token sharing that colour and the singular ones are `null` when several do, and `themeScope` names the theme active at capture) + `component { componentStack, source?: { file, line, column } }` (with `@reticlehq/react`).
- Use it to catch present-but-broken UI: `opacity:0` / `box` 0×0 / `occluded:true` (invisible or unclickable), `cursor` not `pointer` (dead control), `offTheme:true` (off-design-token color).

### `reticle_act` / `reticle_act_sequence`

Perform one action / several in order.

- **`reticle_act` args:** `ref`, `action`, `args?`, `refuseWhenThrottled?`, `sessionId?`. → `{ since, dispatched, settled, settleReason, result, session, warning? }` where `result = { ok, ref, action, dispatched, settled, settleReason, effect }`. The `session` block `{ lastSeenMs, throttled, focused }` reports tab health on every act; when `throttled` is true a `warning` string is also attached. Pass `refuseWhenThrottled: true` to hard-fail instead of warning (opt-in; default is warn-only so background testing never breaks).
- **`reticle_act_sequence` args:** `steps: [{ ref | target, action, args? }]`. Each step takes `ref` (from a snapshot/query) or `target` (`{ testid }` / `{ label }` / `{ role, name }` / `{ text }`). That is the same locator `reticle_act` accepts. → `{ since, dispatched, result }` where `result = { ok, count, effects: [...], steps: [...] }` (one `effect` per step; each step carries its own `dispatched`/`settled`/`settleReason`).
- See [§5](#5-actions-full-list) for the action list.

**Dispatch vs settle.** The action is two phases: the **dispatch** (the synchronous click/fill, which is what can fail) and the **settle** (waiting one animation frame so React's commit lands before we return). The settle is **bounded** (~200ms): in a throttled/background tab `requestAnimationFrame` never fires, so Reticle falls back to a timer and resolves anyway. A settle timeout is therefore **never an error**: `reticle_act` resolves with `settled:false, settleReason:"timeout"` and the dispatch (the click) has still landed. Only a real dispatch failure (stale ref, wrong element type) throws.

| top-level field | meaning |
| --- | --- |
| `dispatched` | the action dispatched without throwing (mirror of `effect.dispatched`) |
| `settled` | a real animation frame flushed within the budget; `false` = the fallback timer fired |
| `settleReason` | `"timeout"` when the fallback fired (throttled tab), else `null` |

**`result.effect`: best-effort evidence the action landed.** All probes are cheap and capture only the _immediate_ effect (one microtask + one rAF after dispatch); async, network-driven re-renders show up in `reticle_observe`, not here.

| field | meaning |
| --- | --- |
| `dispatched` | always `true` (if we couldn't dispatch, the tool throws instead) |
| `targetMatched` | the ref still resolved to a connected element |
| `visible` | element was visible at the start of the action |
| `enabled` | element was not disabled / aria-disabled at the start |
| `defaultPrevented` | a handler called `preventDefault()` on the primary cancelable event. Only meaningful for `click`/`dblclick`/`hover`/`fill`/`type`/`clear`/`press`/`upload`/`drag`; always `false` for non-cancelable events (`focus`/`blur`/`select`/`check`/`uncheck`/`submit`/`scrollIntoView`) |
| `focusMoved` | `"<prevRef>-><newRef>"` if `document.activeElement` changed, else `null` (body counts as `null`) |
| `valueChanged` | `fill`/`type`/`clear` only: input value before !== after; otherwise `false` |
| `domMutatedWithin` | count of MutationObserver records seen in the window |
| `occluded` | `click`/`dblclick` only: the click point hit-tested to a _foreign_ element (an overlay is on top). Synthetic dispatch still delivered the event, but **a real user could not click it**, so treat the target as visually blocked. `false` when not click-like or not hit-testable |
| `occludedBy` | the ref of the element actually on top at the click point when `occluded`, else `null` |
| `scrolledIntoView` | `click`/`dblclick` only: the target was off-viewport, so Reticle scrolled it into view before dispatch |

Use it to distinguish failure modes: `visible:false`/`enabled:false`/`targetMatched:false` → your action missed; the tool throwing → it never dispatched; `occluded:true` → the control is covered by something (a real user is blocked even though the synthetic event landed); `defaultPrevented:true` or all of `valueChanged:false`/`focusMoved:null`/`domMutatedWithin:0` → the app didn't react.

**Clicks run the code, they don't push pixels.** A `click`/`dblclick` fires the full `pointerdown → mousedown → focus → pointerup → mouseup → click` sequence directly on the resolved element, so pointer- and focus-gated handlers fire the way they do for a real user, with no coordinate gesture to be intercepted by the presenter HUD or missed off-screen. This is the **default even when native CDP real input is configured** (`inputMode:"synthetic"`, `inputModeReason:"synthetic-click-preferred"`). Before dispatch Reticle hit-tests the click point (`occluded`) and scrolls an off-screen target in (`scrolledIntoView`), so a blocked or off-viewport target is reported, never silently "successful". For the rare case that needs a **trusted** native click (a native file picker, clipboard, or an `isTrusted`-gated handler), pass `args:{ native:true }` to drive it through CDP. `hover`/`drag` still use native pointer input (they need real hit-testing).

**Cookbook: "Did my action even land?"**

```ts
const { result } = reticle_act({ ref: saveBtn, action: 'click' });
if (result.effect.defaultPrevented) {
  // a handler blocked the default, so the click was swallowed
} else if (result.effect.domMutatedWithin === 0) {
  // dispatched cleanly but the app rendered nothing: likely a dead control
}
```

### `reticle_observe`

The timeline + summary of what happened.

- **args:** `window_ms?` (default 2000) **or** `since?` (cursor from an act), `filters?` (event-type names), `max_events?` (cap the timeline to the most recent N), `sessionId?`.
- **returns:** `{ window_ms, events: [...], summary: { network, domAdded, domRemoved, routeChanges, consoleErrors, animations, signals }, cost: { events, bytes, droppedOldest? } }`.
- **Output budget.** Every result carries a `cost:{ events, bytes }` hint so you can self-budget your next call. When `max_events` truncates the timeline, the dropped count is surfaced as `cost.droppedOldest`, never a silent cap. (The presenter HUD's own animations are filtered out of the timeline automatically, so `observe` shows the app, not the instrument.)

### `reticle_act_and_wait`

Act, then wait for a predicate: the whole act→observe→assert loop in one hop.

- **args:** `ref`, `action`, `args?`, `until: <predicate>`, `timeout_ms?` (default 4000; 0 = evaluate once), `refuseWhenThrottled?`, `intent?`, `sessionId?`.
- **returns:** `{ effect, verdict, trace, session, warning? }`. `effect` is the action result (`{ ok, ref, action }`), `verdict` is `{ pass, evidence?, failureReason? }`, `trace` is the reaction report of everything the app did after the action, and `session` is the tab-health block `{ lastSeenMs, throttled, focused }` (with a `warning` when throttled). A failing `verdict` still returns `effect` + `trace` so you can see what _did_ happen. The predicate is automatically floored at this act's cursor, so it only matches events the action actually caused.

### `reticle_wait_for`

Block until a predicate holds (or time out). Looks both backward (recent buffer) and forward.

- **args:** `predicate`, `timeout_ms?` (default 4000), `since?`, `sessionId?`.
- **No stale-signal false passes.** By default the evaluation window is floored at your **last act's cursor**, so a signal/network/console/animation event buffered _before_ the action can never satisfy the predicate (the report's "validation 68 == 68 was a lie" footgun). Pass an explicit `since` (an act/observe cursor) to widen or narrow the window deliberately. Element/text predicates query the live DOM and are unaffected by `since`.

### `reticle_assert`

Verify a predicate; optionally wait for it.

- **args:** `predicate`, `timeout_ms?` (0 = evaluate once), `since?`, `intent?`, `sessionId?`.
- Same `since` default as `reticle_wait_for`: scoped to your last act so a stale buffered event can't fake a pass; override with an explicit `since`.
- **returns:** `{ verified, because, pass, evidence, contradictions?, coverage?, failureReason?, session, warning? }`. On failure includes a **near-miss** (e.g. "found the dialog but not visible", or "no button named 'Submit'; saw: Cancel"). The `session` block `{ lastSeenMs, throttled, focused }` reports tab health on every assert; when throttled a `warning` is attached so you never assert against a tab that is silently no-oping.
- **`intent` declares what the change was FOR, inline.** Pass a sentence in your own words and it lands in `.reticle/intent.json`, the same git-checked ledger `reticle_intent` writes, before the verdict is drawn; a green verdict then marks it proved and names itself as the proof. Pass the **id** of an intent you already declared instead, to point several verdicts at one statement rather than restating it. `reticle_act_and_wait` takes the same argument. Omit it and nothing is written.
- **Read `verified`, not `pass`.** `pass` says the predicate held; `verified` says whether that means anything. It is `"no"` when a channel contradicts the assertion (a failed write under a green screen, a batch whose body reports per-item failures, a request still in flight), and `"unknown"` when the outcome could not be known yet: a `202 Accepted` that has not reconciled, or a write whose response body was never recorded. `because` names the deciding evidence in one sentence.

### `reticle_reconcile`

Compare what the API **returned** against what the page **renders**.

- **args:** `since?`, `urlContains?`, `sessionId?`.
- **returns:** `{ mismatches, compared, note? }`.
- Catches the class no status code and no assertion can reach: a `USD 7997` amount rendered as `₹79.97`, or a record the API calls `on_hold` displayed as `"pending"`. Both sides agree on the digits; only the meaning differs, so every other channel reports success.
- Needs response bodies: `connect({ captureNetworkBodies: true })`. When nothing could be compared it says so in `note` rather than returning an empty, clean-looking result over data it never read.

### `reticle_network` / `reticle_console` / `reticle_animations`

Fast targeted lookups without a full timeline.

- `reticle_network({ since?, method?, urlContains?, status?, bodies? })` → `{ calls }`. Pass `bodies: false` for a body-free listing (method/url/status/timing only); bodies dominate the payload, so the common "did POST /x return 200?" read gets much cheaper.
- `reticle_console({ level?, since? })` → `{ logs }`
- `reticle_animations()` → running/recent animations.

### `reticle_capabilities`

The app-advertised testable surface (registered via `reticle.describe`). Call this first to learn what to assert on without reading source.

- `reticle_capabilities({ sessionId? })` → `{ testids, signals, stores, flows }`

`reticle_sessions` also surfaces a `hasCapabilities` flag per session so you know when it's worth calling. Returns empty arrays (never errors) if the app advertised nothing.

### `reticle_domain`

Read the app's domain model **before testing**: a synthesis of every saved flow + the registered capabilities. Tells you what to test and where the real risk is without crawling the app. Reads `.reticle/flows/` + `.reticle/contract.json`, no browser needed.

- `reticle_domain({})` → `{ flowCount, flows: [{ name, steps, grade, asserts, signals, testids, warning?, risk? }], declared: { testids, signals, stores }, coverage: { asserted, presenceOnly, assertionFree }, gaps: { unassertedFlows, declaredUntestedSignals, declaredUntestedTestids }, riskRanked, summary }`
- **`gaps`** is the point: `declaredUntestedSignals` are intents the app emits that **no flow asserts** (untested behavior); `unassertedFlows` act but verify no consequence. Close them with a flow + a consequence assertion (`reticle_annotate`).
- **`riskRanked`** orders flow names worst-first by combining run history (`.reticle/project.json`: recently failed/drifted, or passed-with-errors) with assertion quality (a green assertion-free flow is still risky). **Test these first.** Each flow's `risk` carries `{ level, reason, lastStatus? }`.

### `reticle_state`

Read live framework/store state directly instead of inferring it from the DOM. See [§17](#17-evidence-of-effect-actawait-state-capabilities-replay).

- `reticle_state({ store?, ref?, path?, depth?, sessionId? })` → `{ stores, component? }`, or `{ store, path, found, value, availableKeys?, storeNames }` when `path`/`depth` is given.

Store reads are the reliable path. The `ref` component read is best-effort and bounded: when the component state can't be read it returns `component: { ok: false, reason: "component-state-unavailable" }` rather than hanging.

**Scope big stores so you don't pay for them.** A whole store can be tens of KB. Narrow the read:

- `path` extracts a dot-path sub-tree relative to the named `store` (numeric segments index arrays), e.g. `reticle_state({ store:"workspace", path:"captionCache.v3.0.text" })`.
- `depth` collapses anything deeper than N levels to a compact size marker (`{…7 keys}`, `[Array(120)]`) so you can skim a store's _shape_ before drilling in.
- A wrong `path` returns `{ found:false, availableKeys:[...] }`, the keys that _were_ present where the walk stopped, so a mistyped path is self-correcting, not a bare `null`.

### Detecting wasted re-renders (React)

A page can be **thrashing**, committing many React renders a second, while the DOM stays visually identical. The DOM/screenshot tools see an idle page; only a tool inside the runtime sees the commit rate. Reticle exposes it as a registered store you read with `reticle_state`:

```ts
// app entry. MUST run before react-dom loads, so import it FIRST (React reads the devtools hook
// at renderer-inject time). It augments a real React DevTools hook if present; host-safe (no-ops on
// any failure, never breaks the app).
import { installRenderMeter } from '@reticlehq/react';
installRenderMeter();
```

```jsonc
reticle_state({ store: "__reticle_renders", path: "commits" })   // → total React commits (monotonic)
// read it, do an action (or wait a window), read again → the delta is the commit count for that span.
```

A render storm shows up as a commit count that climbs with no corresponding DOM mutation: a perf regression invisible to any outside-the-page tool.

### `reticle_session {action:"narrate"}` / `reticle_clock`

Show the agent's intent on the page, and control time (toasts/debounces/auto-dismiss). See [§16](#16-presenter-mode-narration--fake-clock-watch--control).

### `reticle_baseline {action:"save"}` / `reticle_baseline {action:"list"}` / `reticle_baseline {action:"diff"}`

Regression detection. See [§8](#8-regression-baselines--diff).

### `reticle_record {action:"start"}` / `reticle_record {action:"stop"}` / `reticle_replay`

Capture a flow's reaction report and compile it into a replayable program. See [§9](#9-recording-a-flow). `reticle_record {action:"stop"}` also returns a `cost:{ events, bytes }` hint alongside the reaction report so you can gauge the recording's size.

### `reticle_explore`

List interactive elements + console-error count for autonomous exploration. See [§10](#10-autonomous-exploration).

### Flows, recorder & self-healing (`.reticle/`)

`reticle_contract_save`, `reticle_flow_save` / `reticle_flow_save_recorded` / `reticle_flow {action:"list"}` / `reticle_flow {action:"load"}` / `reticle_flow_replay` / `reticle_verify {action:"flows"}`, `reticle_flow_heal`, `reticle_annotate`: record once, replay forever (anchored on testid/signal, or on an auto-derived component/source anchor when there's no testid), with legible drift + self-heal. Full guide: [Flows, the recorder & self-healing](flows.md).

- **`reticle_verify({ action: "flows", names?, sessionId? })`** is the regression-suite call: it replays EVERY saved flow (or a subset) deterministically and returns one verdict `{ status, passed, failed, failures: [{ flow, verdict, whatChanged, whereInSource, nextAction }] }`. Passing flows are counted; only failures carry detail. Run it after any change: one call, no LLM per flow.
- **Decision envelope:** on a drift/fail, `reticle_flow_replay` (and each `reticle_verify {action:"flows"}` failure) returns the actionable fix: `whatChanged`, `whereInSource` (`file:line`), and a one-line `nextAction` (e.g. "rebind the anchor to 'new-deploy', or update the flow if intended").

### Human-in-the-loop control

`reticle_session {action:"end"}`, `reticle_session {action:"resume"}`, `reticle_session {action:"messages"}`: the human can pause the agent, send it a correction, or end the session from the floating panel; the agent receives guidance on its next tool call. Full guide: [Human-in-the-loop control](human-control.md).

### `reticle_session {action:"review"}`: drain the bugs the human flagged on the page

The dev clicks **"Flag a bug"** in the running app, points at the element that looks wrong, and types what's wrong (⌘/Ctrl+Enter to send). Each flag becomes a **mark** the agent drains:

```
reticle_session {action:"review"}({ sessionId })
→ { marks: [{ id: "m1", note: "this button is misaligned", label: "button \"Pay\"",
              source: { file: "src/Checkout.tsx", line: 42 },
              fix: "Open src/Checkout.tsx:42 and fix: this button is misaligned. Then reticle_session {action:"review"} { resolve: \"m1\" }" }],
    pendingCount: 1 }
```

Each pending mark carries the human note, the element label, the source **`file:line`** (when the framework stamped one), and a ready-to-act `fix` hint. Open the file, apply the fix, then `reticle_session {action:"review"}({ resolve: "m1" })`. The human watching the panel sees **"✓ fixed: …"** land. Reading never consumes a mark, so you can list → fix → verify → resolve. `reticle_sessions` also reports `pendingMarks` so you notice flagged bugs during normal orientation.

### `reticle_network_mock`: stub the network for error-state testing

On a page Reticle drives (`reticle drive`) or a leased Playwright tab (`reticle_lease acquire`), make a request return a 500, force it offline, or delay it, so testing error/edge states is one declared rule, no backend changes:

```
reticle_network_mock({ mocks: [{ urlContains: "/api/pay", method: "POST", status: 500 }] })
→ { applied: true, count: 1 }      // now the checkout POST returns 500; verify the failure UI
reticle_network_mock({ mocks: [{ urlContains: "/api/feed", abort: true }] })   // simulate offline
reticle_network_mock({ clear: true }) // turn mocking off
```

First matching rule wins (`urlContains` + optional case-insensitive `method`). Needs a driven or leased browser; without one it returns a `recommendation` pointing at `reticle drive`.

### `reticle_viewport`: reproducible visual baselines (driven mode)

Pin the driven page to a fixed viewport so a screenshot baseline is reproducible across machines:

```
reticle_viewport({ width: 1280, height: 800 })   // set once, before reticle_screenshot / reticle_visual_diff
→ { applied: true, width: 1280, height: 800 }
```

This is one of three knobs for **CI-stable visual regression**. Set them together:

1. **`reticle_viewport({ width, height })`** gives the same dimensions on every machine.
2. **`reticle_clock({ freeze: true })`** kills animation/time jitter so the pixels are stable.
3. **`reticle_visual_diff({ baseline, masks: [{ x, y, width, height }] })`** neutralizes volatile regions (clocks, avatars, ids) so only real changes fail.

---

## 4. The predicate DSL: full reference

A **predicate** declares what should be true. `reticle_assert` / `reticle_wait_for` evaluate it against the live DOM + the event buffer.

### Leaf predicates

```jsonc
// An element exists / is in a state
{ "kind": "element", "query": { "role": "dialog", "name": "Confirm" }, "state": "visible" }
// query supports: role, name, text, label, placeholder, testid, alt, scope
// state: visible | hidden | enabled | disabled | checked | expanded | focused | present | inViewport
// inViewport asserts the element is in the viewport NOW (not just in the DOM), so a scrollIntoView is gradeable
// add "absent": true to assert it is NOT there (regression / removal)

// Visible text: page-wide, or `scope` it to a subtree (CSS selector or ref) so a match
// in a background tab can't satisfy an assertion about the dialog that just opened
{ "kind": "text", "contains": "Saved successfully", "visible": true }
{ "kind": "text", "contains": "Floor 3", "scope": "[role=dialog]" }

// A network call happened
{ "kind": "net", "method": "POST", "urlContains": "/api/order", "status": 200, "since": 1820 }

// Navigation
{ "kind": "route", "pathname": "/success" }          // or: "contains": "/success"

// Console / errors
{ "kind": "console", "level": "error", "absent": true }   // "no errors during this flow"

// Animation
{ "kind": "animation", "name": "dialog-in", "completed": true }

// An app-emitted signal (webhook/websocket/store change you surfaced via reticle.signal)
{ "kind": "signal", "name": "webhook:received", "dataMatches": { "provider": "stripe", "id": "*" } }

// A registered store's VALUE: the source of truth no DOM/network read can reach. Walks a dot-path
// (numeric array indices) and matches `equals`: a literal, omitted = presence, or a
// { $gte | $lte | $gt | $lt | $contains | $length } operator pattern. Catches a UI-vs-store desync
// (a deploy that only LOOKS shipped) deterministically, in one call, with no LLM and no DOM scraping.
{ "kind": "state", "store": "app", "path": "deployments.0.status", "equals": "live" }
```

A `state` assertion is graded as a **consequence** (a wrong element or stale render cannot fake it), and is usable the same three ways anywhere predicates flow: ad-hoc (`reticle_assert` / `reticle_act_and_wait` `until`), as a flow step invariant (`reticle_annotate { kind: "assert-state", statePath, store?, equals? }`), and as a flow's golden end-condition (`reticle_annotate { kind: "success-state", statePath, … }`). On a miss it names the real store value and the keys that were available: legible, not a blind fail.

### Combinators

```jsonc
{ "kind": "allOf", "predicates": [ <predicate>, <predicate>, … ] }  // every one must hold
{ "kind": "anyOf", "predicates": [ <predicate>, … ] }              // at least one
{ "kind": "not", "predicate": <predicate> }
```

### Timing

- `timeout_ms` (on `assert`/`wait_for`): wait up to N ms for it to become true.
- `since` (on `net`/`console` leaves): only consider events after this cursor (from `act`).

`dataMatches` uses shallow JSON matching; `*` means "present, any value".

---

## 5. Actions: full list

`reticle_act({ ref, action, args })`:

| action | args | notes |
| --- | --- | --- |
| `click` / `dblclick` | n/a | dispatches a real click |
| `hover` | n/a | `mouseover`+`mouseenter` (triggers JS hover state) |
| `focus` / `blur` | n/a |  |
| `fill` | `{ value }` | sets value via React-safe native setter + `input`/`change` |
| `type` | `{ text }` | appends to current value |
| `clear` | n/a | empties an input |
| `select` | `{ value }` | `<select>` option |
| `check` / `uncheck` | n/a | checkbox/radio |
| `submit` | n/a | submits the element's `<form>` |
| `press` | `{ key, modifiers? }` | keydown/up (default `Enter`); `modifiers`: an array of `Meta` / `Control` / `Shift` / `Alt` for Cmd+K-style shortcuts |
| `scrollIntoView` | n/a |  |
| `upload` | `{ name, content?, type? }` | sets a file on `<input type=file>` |
| `drag` | `{ toRef }` | pointer-based drag (dnd-kit / rbd) + HTML5 DnD |
| `webmcp` | `{ tool, params }` | calls a `navigator.modelContext` tool if the site exposes one |

---

## 6. Snapshot modes & scoping

`reticle_snapshot` has three modes. Pick the cheapest that answers your question:

- **`status`** (~30 tokens): route, visible dialogs, counters. "Where am I, is a modal open?"
- **`interactive`** (~100 tokens): only actionable elements (buttons, inputs, tabs…). "What can I click?" Non-interactive content (e.g. 1,000 list rows) is skipped.
- **`full`**: the whole semantic tree. Use only when you truly need everything.

**`scope`** narrows any snapshot or query to a subtree, either a CSS selector (`scope: "[data-testid=item-list]"`) or a ref. This is the main lever for keeping payloads small and queries unambiguous on big pages.

---

## 7. Cookbook: real situations

Each is phrased as the situation you're in, then how the agent verifies it.

### "I told the AI to add an icon button that opens a modal"

```jsonc
const { since } = reticle_act({ ref: iconBtn, action: "click" })
reticle_assert({ timeout_ms: 2000, predicate: { kind: "allOf", predicates: [
  { kind: "element", query: { role: "dialog" }, state: "visible" },
  { kind: "console", level: "error", absent: true }
]}})
```

### "I changed an API call: did it fire correctly and update the UI?"

```jsonc
const { since } = reticle_act({ ref: saveBtn, action: "click" })
reticle_assert({ timeout_ms: 3000, predicate: { kind: "allOf", predicates: [
  { kind: "net", method: "PUT", urlContains: "/api/profile", status: 200, since },
  { kind: "text", contains: "Saved", visible: true }
]}})
```

### "I clicked a button and it should add an element on another page/section"

Act in section A, navigate to B, assert there:

```jsonc
reticle_act({ ref: notifyBtn, action: "click" })            // in "Items"
reticle_act({ ref: notificationsTab, action: "click" })     // go to "Notifications"
reticle_assert({ timeout_ms: 2000,
  predicate: { kind: "text", contains: "New item queued", visible: true } })
```

### "Data shows up only after ~30s (eventual consistency): how to refresh and see it"

```jsonc
const { since } = reticle_act({ ref: addBtn, action: "click" })
reticle_assert({ predicate: { kind: "net", urlContains: "/api/items", status: 202, since } }) // accepted
reticle_assert({ predicate: { kind: "element",
  query: { text: name, scope: "[data-testid=item-list]" }, absent: true } })               // not yet
// …later: click your Refresh button, then wait for it…
reticle_act({ ref: refreshBtn, action: "click" })
reticle_wait_for({ timeout_ms: 5000, predicate: { kind: "element",
  query: { text: name, scope: "[data-testid=item-list]" }, state: "visible" } })
```

### "The list has 100s/1000s of rows: was my item actually added?"

Don't scroll and eyeball. Query finds it regardless of position:

```jsonc
reticle_assert({ timeout_ms: 3000, predicate: { kind: "element",
  query: { text: "Invoice #4821", scope: "[data-testid=item-list]" }, state: "visible" } })
```

> Note: if your list is **virtualized** (react-window/virtuoso), an off-screen row is not in the DOM at all, so `reticle_query` correctly finds nothing. Use **`reticle_scroll_to`** to scroll the windowed container until the row renders, then query it: `reticle_scroll_to({ by: "text", value: "Invoice #4821", container: "[data-testid=item-list]" })`. Asserting against the data with `reticle.signal` or `reticle_state` also works and is cheaper.

### "Login form: does it actually authorize?"

```jsonc
reticle_act({ ref: emailRef, action: "fill", args: { value: "admin@acme.com" } })
reticle_act({ ref: pwRef, action: "fill", args: { value: "•••••••" } })
const { since } = reticle_act({ ref: submitRef, action: "click" })
reticle_assert({ timeout_ms: 3000, predicate: { kind: "allOf", predicates: [
  { kind: "net", method: "POST", urlContains: "/api/login", status: 200, since },
  { kind: "element", query: { role: "heading", name: "Dashboard" }, state: "visible" }
]}})
// And the failure path:
reticle_assert({ predicate: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/login", status: 401 },
  { kind: "element", query: { role: "alert" }, state: "visible" }
]}})
```

### "Make sure there are NO console errors"

```jsonc
reticle_assert({ predicate: { kind: "console", level: "error", absent: true } })
```

### "A real LLM call generates a script: is it happening and rendering?"

```jsonc
const { since } = reticle_act({ ref: generateBtn, action: "click" })
reticle_assert({ timeout_ms: 15000, predicate: { kind: "allOf", predicates: [
  { kind: "net", method: "POST", urlContains: "/api/generate", status: 200, since },
  { kind: "element", query: { testid: "script-output" }, state: "visible" }
]}})
```

### "Upload a file → it calls an LLM → a modal shows a score"

```jsonc
reticle_act({ ref: fileInput, action: "upload", args: { name: "pitch.mp4", type: "video/mp4" } })
const { since } = reticle_act({ ref: analyzeBtn, action: "click" })
reticle_assert({ timeout_ms: 15000, predicate: { kind: "allOf", predicates: [
  { kind: "net", method: "POST", urlContains: "/api/score", status: 200, since },
  { kind: "element", query: { role: "dialog", name: "Score result" }, state: "visible" },
  { kind: "text", contains: "/ 100", visible: true }
]}})
```

### "A button's color should change on hover"

```jsonc
const before = reticle_inspect({ ref }).styles.backgroundColor
reticle_act({ ref, action: "hover" })
const after  = reticle_inspect({ ref }).styles.backgroundColor
// assert before !== after
```

> Pure CSS `:hover` styling needs a real pointer; drive hover effects from JS state (or use a Playwright real-hover) if you need pixel-exact `:hover`. Reticle reads computed style after the JS state change.

### "Something off-DOM happened: a webhook arrived, a store changed"

Surface it from your app, then assert on it:

```ts
// in your app
reticle.signal('webhook:received', { provider: 'stripe', event: 'payment_intent.succeeded' });
reticle.state('cart', { items: 3 });

// Advertise your testable surface at init so the agent learns it without reading source.
// Call this once at module load (before connect); it merges idempotently across HMR reloads.
reticle.describe({
  testids: ['cart-badge', 'toast'],
  signals: ['webhook:received'],
  stores: ['cart'],
  flows: [{ name: 'checkout', steps: ['fill address', 'pay', 'see confirmation'] }],
});
```

The agent reads this back with `reticle_capabilities()`; see [§3](#3-the-tools-full-reference).

```jsonc
reticle_assert({ timeout_ms: 30000, predicate: {
  kind: "signal", name: "webhook:received", dataMatches: { provider: "stripe" } } })
```

#### Keeping signals from drifting (lint)

Signals only help if you actually emit one whenever user-visible state changes. The `@reticlehq/eslint-plugin` package ships `reticle/require-signal-on-mutation`, which flags any function that calls a configured store **mutator** but never fires the **signal callee** in the same body, so the signal map can't silently fall behind the store. (The package also ships `reticle/no-internal-tags`; both are on in its `recommended` config.)

```js
// eslint.config.mjs
import reticle from '@reticlehq/eslint-plugin';

export default [
  {
    plugins: { reticle },
    rules: {
      'reticle/require-signal-on-mutation': [
        'error',
        { mutators: ['set', 'reorderSections', 'addSection'], signalCallee: 'reticleSignal' },
      ],
    },
  },
];
```

`mutators` lists the callee names that change state; `signalCallee` (default `['reticleSignal', 'signal']`) is the name that counts as firing a signal. See [`packages/eslint-plugin/README.md`](../packages/eslint-plugin/README.md) for scoping and matching details.

---

## 8. Regression: baselines & diff

The "did anything silently break/disappear?" workflow.

```jsonc
// after you've confirmed a screen is good:
reticle_baseline {action:"save"}({ name: "checkout-ok" })

// later, after a change:
reticle_baseline {action:"diff"}({ baseline: "checkout-ok" })
// → { removed: ["- button \"Export\""], added: ["- alert \"Card declined\""],
//     consoleErrors: 2, routeChanged: false }
```

`diff` ignores volatile ref ids and compares the semantic structure, so you get real ADDED/REMOVED elements plus the current console-error count. Great as a guardrail the agent runs after each edit: _"diff against `checkout-ok`; fail if anything interactive was removed or console errors increased."_

### Pixel-perfect visual regression that's stable in CI (driven mode)

The semantic `reticle_baseline {action:"diff"}` above never flakes. For an actual **pixel** diff (`reticle_screenshot` + `reticle_visual_diff`, driven mode), three knobs make it CI-stable instead of flaky:

```jsonc
reticle_viewport({ width: 1280, height: 800 }) // 1. same size on every machine
reticle_clock({ freeze: true })                // 2. no animation/time jitter
reticle_screenshot({ name: "checkout-ok" })    //    capture the baseline
// …later, after a change, at the same viewport + frozen clock:
reticle_visual_diff({ baseline: "checkout-ok", masks: [{ x: 0, y: 0, width: 200, height: 24 }] })
// → { matched: false, changedPixels, ratio, region, diffPath }   // 3. masks ignore volatile regions
```

Without all three, a pixel diff fails on a different window size, a mid-animation frame, or a live clock/avatar: the classic reasons teams give up on screenshot tests. With them, only a real visual change fails.

---

## 9. Recording a flow

Capture everything that happens across a span. Useful for "run my whole checkout flow and tell me what happened," or to keep a known-good trace.

```jsonc
reticle_record {action:"start"}({ recordingName: "checkout" })
// …agent performs the flow (reticle_act / reticle_act_sequence)…
reticle_record {action:"stop"}({ recordingName: "checkout" })
// → {
//     recordingName,
//     program: { version, steps: [{ tool, args: { by:"testid", value, action, args }, stable }] },
//     events: [...ordered timeline...],
//     summary: { network, domAdded, … },
//     warning?  // present when some steps could not be bound to a testid
//   }
```

`reticle_record {action:"stop"}` returns a compiled, replayable `program`: the agent's `reticle_act` / `reticle_act_sequence` invocations captured during the span, with each ref normalized to its element's `data-testid` where resolvable. Re-run it later:

```jsonc
reticle_replay({ recordingName: "checkout" })
// re-resolves each step by testid and re-runs the actions in order
// → { recordingName, ok, steps: [{ tool, ok, error?, note? }] }   // stops at the first failure
```

**Limitation.** Normalization to a stable testid only works for elements that have a `data-testid`. A step whose element has none is stored in ref form (`stable: false`) and `reticle_record {action:"stop"}` returns a `warning`; replay best-effort re-uses the stored ref, which is only valid within the same live session and is not portable across reloads. Add `data-testid` to the elements you want replay-stable.

---

## 10. Autonomous exploration

Have the agent crawl and stress a screen without a script:

```jsonc
reticle_explore({ scope: "main" })
// → { interactive: [ { ref, desc }, … ], consoleErrors, hint }
```

The agent then acts on each ref, observes the reaction, and reports anomalies (failed requests, console errors, dead controls). Good for "click everything on this page and tell me what breaks."

---

## 11. Turning your test cases into agent checks

If you already have test cases (a QA checklist, acceptance criteria, a spreadsheet, manual steps), you can hand them to your agent and have it run + verify each against the live app. Each case becomes a predicate:

| Test case (English) | Reticle check |
| --- | --- |
| Login with valid creds lands on the dashboard | `allOf[ net /api/login 200, element heading "Dashboard" visible ]` |
| Submitting the form shows a success toast | `text "Saved" visible` (+ `net … 200`) |
| Deleting an item removes it from the list | `element {text, scope:list}` `absent: true` |
| No console errors on the checkout page | `console level:error absent:true` |
| Export button visible for admins, hidden for viewers | `element {role:button, name:Export}` `visible` / `absent` |
| Clicking a row opens the detail drawer | `element {role:dialog}` `visible` |

A practical workflow:

> "Here are our 12 dashboard test cases. For each, drive the app with Reticle and tell me pass/fail with evidence. For any failure, show the source file to fix."

This is the sweet spot: the **manual cases you never automated** become things the agent runs in seconds, on every change. It **complements** your CI Playwright/Cypress suite (which gates releases); Reticle is the in-loop checklist while you build.

---

## 12. Token discipline

Reticle is cheap by design ([benchmark](token-efficiency.md)), but keep it that way:

- Prefer **`reticle_query` + `reticle_assert`** (~30 tokens each) over snapshots inside the loop.
- Use **`mode: "interactive"`** or **`"status"`**, not `"full"`.
- Use **`scope`** to look at just the relevant subtree.
- Reach for `mode: "full"` only when you truly need the whole page.

---

## 13. Best practices & gotchas

- **Accessibility = legibility.** Real `role`s, labels, and `data-testid`s make queries precise and stable. It's also just good a11y.
- **Stable handles for controls.** Prefer `data-testid` over names that include dynamic counts (e.g. "Notifications (3)"); the count changes the accessible name.
- **Always thread `since`.** Pass the cursor from `reticle_act` into `observe`/`assert` so you only consider what happened _after_ the action.
- **Use `timeout_ms` for async.** Don't assert instantly on something that arrives over the network or after a re-render.
- **Watch `session.throttled`.** Background tabs throttle timers/rAF/pointer gestures, so an act can silently no-op. Every `reticle_act` / `reticle_assert` / `reticle_act_and_wait` result carries `session: { lastSeenMs, throttled, focused }` and, when throttled, a `warning`. Refocus the tab (or run it foregrounded) before driving; pass `refuseWhenThrottled: true` to hard-fail instead.
- **Scope big pages.** On dashboards with hundreds of elements, scope queries to the panel you care about.
- **Never breaks your app.** Observers are additive and reversible (`reticle.disconnect()` restores patched globals). It won't interfere with your app's behavior.

---

## 14. FAQ

### Does this run in production?

No. Keep `reticle.connect()` behind a dev guard. The SDK is side-effect-free and tree-shakes out of prod builds.

### Do I have to change my components?

No, for basic look/act/observe. You'll get better results by adding `data-testid`s and labels where the agent needs precision.

### Does it work without React?

The core (DOM/network/route/console/animation/snapshot/actions) is framework-agnostic and is gated against a vanilla-TS app. React, Next.js, Remix and Astro each have an app and a CI gate. SvelteKit is wired end-to-end. `reticle init` writes the client hook and the Vite plugin, and the plugin stamps `data-reticle-source` into `.svelte` components so verdicts carry `file:line`. But there is still no SvelteKit app in CI, so it is unverified rather than supported. Vue has a Pinia store adapter and nothing else: no detection, no `.vue` stamping, no gate. See [what Svelte support is and is not](getting-started.md#what-svelte-support-is-and-what-it-is-not).

### Can it judge whether my UI looks good?

No. Reticle verifies behavior, not aesthetics. Visual/pixel correctness and "does it feel right" remain human (or a visual-diff tool).

### Does it replace Playwright/Cypress?

No. Those are your scripted CI suite. Reticle is for in-loop verification while the agent codes, and for the cases you never automated. They compose.

### How does it compare to Playwright MCP / Chrome DevTools MCP?

Those let an agent drive/ inspect a _separate_ browser; Reticle verifies your _own running app_ (real session/auth) with assertions + regression as first-class, far more cheaply. See [Reticle vs Playwright MCP](vs-playwright-mcp.mdx) and [Reticle vs Chrome DevTools MCP](vs-chrome-devtools-mcp.mdx).

### Multiple tabs/apps?

Each is a session; pass `sessionId` to any tool when more than one is connected (`reticle_sessions` lists them).

---

## 15. Security & privacy

- **Dev-only, localhost-only by default.** The bridge binds `127.0.0.1`; the SDK is meant for dev builds.
- **No app data leaves your machine.** Baselines/recordings are local. The CLI sends anonymous, opt-out usage metrics only (random id + event names, no code and no PII; see [telemetry](telemetry.md)); opt out with `reticle telemetry disable`, `RETICLE_TELEMETRY=0`, or `DO_NOT_TRACK=1`. Feedback you or your agent deliberately send (`reticle feedback` / `reticle_feedback`) is the only free text that ever leaves the machine: never passive, redacted first, and separately disabled with `RETICLE_FEEDBACK=0`.
- **Network bodies aren't captured by default:** only method/url/status/timing. Body capture is opt-in and runs through a redactor (drop `password`/`token`/`secret`/… + your patterns).
- **Additive & reversible.** Reticle patches `fetch`/History/console defensively and restores them on disconnect; it will not break the app under test.

### Extending the redaction rules

The built-in rule catches the credential names that are common across apps. Yours has its own vocabulary in both directions (a `licenceKey` it has never heard of, and a `designToken` it redacts by mistake), so `connect()` takes a `redact` option:

```ts
reticle.connect({
  redact: {
    keys: ['licenceKey', /^partner[-_]?code$/i], // also redact these
    allow: ['designToken'], // stop redacting this false positive
  },
});
```

- **`keys`** adds to the rule. A string matches a key name **exactly**, case-insensitively, so `'code'` does not redact `codeOwner`. A RegExp is tested against the key.
- **`allow`** exempts a key from the **default** rule. It loses to `keys`: an explicit redact instruction beats an exemption. Exempting a key the default rule considers a credential prints a one-time warning naming it, because that value now reaches the agent transcript and the on-disk journal in cleartext.
- **There is no way to replace the default set.** Both options are additive on purpose: a config that could turn the whole rule off would eventually ship in an app that leaks, and Reticle would be the thing that recorded it.
- **With no `redact` option, behaviour is exactly what it was before this option existed**, pinned by a test that walks every credential name and every known false positive.

**What crosses the bridge, and why it matters.** Most captures pass through the SDK in your page. Request bodies and response headers on the **driven** path (`reticle drive`, or a CDP-attached browser) do not: the daemon reads them straight from the network stack. So the literal strings in `keys` are announced to the daemon when your app connects, and it redacts them there too. Two parts deliberately stay in the page:

|                         | Applies in the page | Applies on the driven path |
| ----------------------- | :-----------------: | :------------------------: |
| `keys` (plain strings)  |         ✅          |             ✅             |
| `keys` (RegExp entries) |         ✅          |             ❌             |
| `allow`                 |         ✅          |             ❌             |

A RegExp does not travel because compiling a pattern that arrived over a socket and running it against every key of every request body is a denial-of-service surface. `allow` does not travel because it is the only part of the config that **removes** redaction, and the driven path keeps the built-in floor rather than letting a page lower it. Both exclusions fail in the safe direction: the driven path can over-redact relative to your config, never under. **If a key must be redacted everywhere, name it as a plain string.**

---

## 16. Presenter mode, narration & fake clock (watch + control)

### Presenter mode: let a human watch the agent

Turn it on when connecting:

```ts
reticle.connect({ session: 'my-app', present: true, pace: 450 });
```

You get, in the page itself:

- a **glowing border** while the agent is working,
- a **synthetic cursor** that flies to each target before acting,
- **click ripples, hover rings**, and a status **HUD** ("Clicking button \"Save\"… ✓ passed"),
- a per-action **pacing** delay (`pace`, ms) so a human can follow.

All presenter DOM uses `data-reticle-*` and is excluded from snapshots/observers, so it never pollutes what the agent sees. Use `setIgnoreSelectors([...])` to also hide your own dev widgets.

#### Session liveness: the HUD never gets stuck "running"

A session starts on the agent's first activity and must reliably end even when the agent misbehaves. Reticle is an MCP tool, so the agent (Claude) can crash, disconnect, or simply forget to call `reticle_session {action:"end"}`, and a backgrounded tab's own timers are throttled by the browser. So **the Node server owns liveness, not the browser tab:**

- **Agent goes idle / forgets to end** → a server-side reaper (immune to tab throttling) ends the session after `idleEndMs` of no agent commands and pushes the end to the browser. A backgrounded tab still receives that push, so you can switch windows and come back to a correctly-ended HUD.
- **Agent (MCP client) disconnects cleanly** → every active session ends at once.
- **Agent kills the Reticle server process** (so no push can arrive) → the SDK self-ends the session after it can't reach the bridge for `BRIDGE_LOST_MS` (~15s), showing "lost connection to Reticle."
- **Slow-but-alive agent** → if it goes quiet long enough to auto-end and then acts again, the session **revives** automatically (an explicit `reticle_session {action:"end"}` stays terminal).

Tune the idle window with `reticle_session({ action: "tune", idleEndMs })`; it updates both the browser timer and the server reaper. The human keeps the panel (with Copy/Export of the run) after any end.

### `reticle_session {action:"narrate"}`: show the agent's intent

So the human sees _what the agent is about to do and why_:

```jsonc
reticle_session {action:"narrate"}({ text: "Adding a beat, then checking the section count goes up" })
```

It renders on the HUD. (The agent's private reasoning isn't visible to Reticle; narration is how it surfaces intent on the page.)

### `reticle_clock`: control time deterministically

Fast-forward toasts, debounces, auto-dismiss, and commit-on-blur without waiting:

```jsonc
reticle_clock({ freeze: true })          // freeze app timers (Date.now/setTimeout/setInterval)
reticle_act({ ref: e9, action: "click" })
reticle_clock({ advanceMs: 5000 })       // jump 5s: the auto-dismiss fires now, deterministically
reticle_assert({ predicate: { kind: "element", query: { role: "alert" }, absent: true } })
reticle_clock({ reset: true })           // restore real timers
```

It does **not** freeze `requestAnimationFrame`/microtasks (React's scheduler keeps running), and Reticle's own internal timers are insulated, so freezing never stalls the tools.

### Action refinements (from real-app use)

- **`blur`** now fires a bubbling `focusout`, so React's commit-on-blur (`onBlur`) runs, and inline editors and form fields commit. `fill`/`type` focus first so a later `blur` commits.
- **`hover`** accepts `{ holdMs }` to dwell, so timer-gated reveals mount; then `wait_for` the revealed nodes.
- **`drag`** yields a frame between phases (React flushes between steps) and accepts `{ data: { mime, value } }` for custom `dataTransfer` payloads.

### Richer `dataMatches` (signals)

```jsonc
{
  "kind": "signal",
  "name": "chat:edit-applied",
  "dataMatches": { "count": { "$gte": 1 }, "sections": { "$contains": "hook" } },
}
// operators: $gte $lte $gt $lt $contains (array/substring) $length ; "*" = present
```

On a failed signal assert, the result includes a **near-miss**: the signals that _did_ fire with that name + their data. And `reticle_observe`'s summary now includes `domChanged` (in-place text/attribute re-renders, not just added/removed nodes).

---

## 17. Evidence-of-effect, act+await, state, capabilities, replay

These close the "is the action trusted?" gap, so you can tell _my action missed_ vs _the app didn't react_ vs _the tool didn't dispatch_.

### `reticle_act` returns evidence-of-effect

Every `reticle_act` result now carries an `effect`:

```jsonc
{ since, dispatched, settled, settleReason,
  result: { ok: true, ref, action, dispatched, settled, settleReason, testid,
  effect: { dispatched, targetMatched, visible, enabled, defaultPrevented,
            focusMoved: "e11->e12"|null, valueChanged, domMutatedWithin } } }
```

`settled:false, settleReason:"timeout"` means the settle frame did not flush within the budget (a throttled/background tab). This is **not** a failure: the dispatch landed and the tool resolved.

Read it to disambiguate failures instantly: `targetMatched:false` = your ref was stale; `defaultPrevented:true` = a handler cancelled it; `domMutatedWithin:0` + `valueChanged:false` = the app didn't react.

### `reticle_act_and_wait`: one hop for act → observe → assert

```jsonc
reticle_act_and_wait({ ref, action, args?, until: <predicate>, timeout_ms })
// → { effect, verdict: { pass, evidence, failureReason? }, trace: <reaction report> }
```

Performs the action (with settle so React commits land in the window), waits for `until`, and returns the action's effect + the verdict + the full causal trace. Collapses four calls into one.

### `reticle_state`: read live framework/store state

No need to broadcast a signal for every fact. Register stores in your app:

```ts
import { registerStore } from '@reticlehq/react';
registerStore('workspace', useWorkspace); // pass the store itself → auto STATE_CHANGE diffs
```

**Which state libraries work.** `registerStore` accepts anything shaped `{ getState, subscribe }`, so **zustand and Redux (and Redux Toolkit) need no adapter at all**: pass the store. For everything else Reticle ships adapters, because the shape is the only thing missing:

```ts
import {
  tanstackQueryStore,
  jotaiStore,
  xstateStore,
  valtioStore,
  mobxStore,
  svelteStore,
  piniaStore,
  recoilStore,
} from '@reticlehq/browser';

registerStore('queries', tanstackQueryStore(queryClient)); // TanStack Query
registerStore('app', jotaiStore(getDefaultStore(), { cart, user })); // Jotai (name the atoms)
registerStore('machine', xstateStore(actor)); // XState
registerStore('app', valtioStore(state, snapshot, subscribe)); // Valtio
registerStore('app', mobxStore(store, toJS, reaction)); // MobX
registerStore('cart', svelteStore(cartStore)); // Svelte store: `{ subscribe }` is the whole contract
registerStore('cart', piniaStore(useCartStore())); // Pinia (Vue)
```

**Svelte and Pinia** are the two whose adapters do something you would not guess from the shape.

A Svelte store has **no pull side at all**: `{ subscribe }` is the entire contract, no `getState`. `svelteStore` reads the current value by subscribing, catching the synchronous first callback the store contract guarantees, and unsubscribing immediately (the same thing `svelte/store`'s own `get()` does), so it holds no lasting subscription and needs no teardown. It also _swallows_ that first callback on `subscribe`, because forwarding it would emit a state change at registration time for a change that never happened.

`piniaStore` subscribes with `detached: true` and `flush: 'sync'`. Without `detached`, a store registered from inside a component goes permanently silent after that component unmounts: still readable, but never emitting another state change, which reads exactly like an app that stopped changing. Without `sync`, the notification lands a Vue tick late, outside the window that links a state change to the click that caused it. Note that `$state` carries state, not getters: a Pinia getter is derived, so asserting on the state it derives from is the stronger assertion anyway.

**Recoil** has no enumerable registry of live atoms and no per-atom subscription outside React, so it takes an atom map (like Jotai) plus the transaction stream from a small bridge component:

```tsx
import { snapshot_UNSTABLE, useRecoilTransactionObserver_UNSTABLE } from 'recoil';

function ReticleRecoilBridge() {
  const latest = useRef(snapshot_UNSTABLE());
  const listeners = useRef(new Set<() => void>()).current;
  useRecoilTransactionObserver_UNSTABLE(({ snapshot }) => {
    latest.current = snapshot;
    for (const l of listeners) l();
  });
  useEffect(() => {
    registerStore(
      'recoil',
      recoilStore(
        { cart: cartAtom, user: userAtom },
        () => latest.current,
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      ),
    );
  }, []);
  return null;
}
```

Each atom comes back as `{ status, value, error }` rather than a bare value, because Recoil atoms can be async: calling `getValue()` on a pending selector **throws the pending promise**, which would lose the whole state read over one slow atom. A loading atom reports `status: 'loading'` instead of silently reading as empty.

**TanStack Query is worth registering even if you register nothing else.** Its cache holds the state most likely to be wrong in a way nothing else can observe: a stale value served as fresh, a mutation that never invalidated its query, an optimistic update never rolled back. None of those fire a network request, so a network log shows silence and the DOM shows a plausible number. The cache is the only witness. The adapter exposes `status`, `fetchStatus`, `isStale` and `dataUpdatedAt` per query key, so an agent can assert the stronger property: not "the number rendered is 42" but "the number rendered came from fresh data".

**React Context / `useState` / `useReducer`** have no store object to adapt: the value lives in the fiber tree and the only subscription is a re-render. Invert it with the hook:

```tsx
import { useReticleStore } from '@reticlehq/react/store';

function CartProvider({ children }) {
  const [cart, dispatch] = useReducer(cartReducer, initial);
  useReticleStore('cart', cart); // one line, and the agent can now read and assert on cart
  return <CartContext.Provider value={cart}>{children}</CartContext.Provider>;
}
```

```jsonc
reticle_state({ store: "workspace" })   // → { stores: { workspace: {…} } }
reticle_state({ ref: "e9" })            // → { component: { ok: true, component, hooks } } or { component: { ok: false, reason: "component-state-unavailable" } }
// `hooks` carries the hook VALUES only (state / ref / memo). React effect entries (chained,
// null-filled fiber internals with nothing to act on) are dropped, and when any were, the read
// says so: component.truncation = { droppedItems, note }.

// Scope a large store instead of paying for the whole thing:
reticle_state({ store: "workspace", path: "captionCache.v3" })  // → { found: true, value: {…} }
reticle_state({ store: "workspace", depth: 1 })                 // → top-level keys, deeper values collapsed to "{…N keys}"
reticle_state({ store: "workspace", path: "nope" })             // → { found: false, availableKeys: ["captionCache", "version", …] }
```

Store reads are the reliable path; ref reads degrade to a structured failure rather than blocking. `path` (dot-path, numeric segments index arrays) and `depth` keep a 60KB store from becoming a token tax, and a wrong `path` returns the keys that _were_ there, so it's self-correcting.

### Charts and dashboards: geometry faults report themselves

Every dashboard widget except one renders text a comparison can read: a KPI card renders a number, a table renders rows. A **chart renders geometry** (the data has been through a scale function into coordinates), and a perfectly correct `series` in the store can still become a blank, flat, or NaN-filled path. Neither a state read nor a screenshot-vs-baseline catches that.

So any element descriptor containing faulty plot geometry carries a `chart` field. There is no extra tool call and no flag: query the chart the way you already would, and a broken one tells you.

```jsonc
reticle_query({ by: "testid", value: "revenue-chart" })
// → { elements: [{ ref: "e12", role: "img", source: "src/Chart.tsx:34",
//      chart: [{ kind: "non-finite-coordinates", tag: "polyline", attr: "points",
//                sample: "0,10 5,NaN 10,20" }] }] }
```

`kind` is one of `non-finite-coordinates` (a zero-range scale divided by zero, always a bug), `empty-geometry` (the chart mounted but no data reached it), or `degenerate-geometry` (every point identical). A **healthy chart adds no field at all**, so this costs nothing on the common path. A genuinely flat line (constant data) is not flagged.

**Canvas charts** (Chart.js, ECharts) are pixels, not DOM, so nothing above applies. Read their data directly instead, which is the only route short of vision:

```ts
import { canvasChartData } from '@reticlehq/browser';
canvasChartData(canvasEl, window); // → { library: "chartjs", data: { datasets: [...] } }
```

### `reticle_capabilities`: the app's testable surface

Declare it once so the agent learns the surface without reading source:

```ts
import { registerCapabilities } from '@reticlehq/react';
registerCapabilities({ testids: [...], signals: [...], stores: [...], flows: [...] });
```

```jsonc
reticle_capabilities()   // → { testids, signals, stores, flows }
```

### `reticle_replay`: recordings become re-runnable programs

`reticle_record {action:"start"}` → drive the flow → `reticle_record {action:"stop"}` returns a **compiled program** (steps bound to testids/signals, not volatile refs). `reticle_replay({ recordingName })` re-executes it, so your flow becomes a deterministic regression run, not a checklist.

---

## 18. Real input mode: native hover & drag

Reticle drives actions by dispatching JS events from inside the page. That covers click, fill, type, select, submit, press, and HTML5 drag, but it **cannot** trigger browser-native pointer behavior: `onMouseEnter`/`onMouseLeave`, hover-gated reveals, and pointer-library drags rely on the browser's real hit-testing, which synthetic events don't drive.

**Clicks are synthetic by default, on purpose.** Even with real input configured, `click`/`dblclick` run the occlusion-honest synthetic path (full `pointerdown→…→click` sequence + a `occluded` hit-test + off-viewport auto-scroll), reporting `inputModeReason:"synthetic-click-preferred"`. There's no coordinate gesture for the presenter HUD to intercept or to miss off-screen, and synthetic dispatch reaches the resolved element directly. Reserve native clicks for the rare `isTrusted`-gated case (native file picker, clipboard) with `args:{ native:true }`. Real input remains the path for `hover`/`drag`, which genuinely need the browser's hit-testing. Every `reticle_act` result tells you which path ran:

```jsonc
{ since, dispatched, settled, inputMode: "synthetic" | "real", inputModeReason?, result, session, warning? }
```

When `inputMode` is `"synthetic"` and the target has hover/enter handlers, the result carries a `warning` so you know a hover may be a no-op. You never have to reverse-engineer it.

**`inputModeReason` is never a silent fallback.** When real input **is** configured but a pointer act still ran synthetic, the result says _why_, so per-element inconsistency is diagnosable instead of mysterious:

| `inputModeReason` | meaning / fix |
| --- | --- |
| `page-not-correlated-to-a-cdp-target` | no CDP page matches the session URL, usually a fresh tab or a CDP target that isn't this page |
| `element-not-locatable` | the element had no box (off-screen / stale ref); `scrollIntoView` first |
| `drag-target-unresolved` | a drag's `toRef` was missing or not locatable |
| `provider-declined` / `provider-error` | the CDP provider declined or threw (the latter also sets `warning`) |
| `not-a-pointer-action` | `fill`/`type`/etc. are always synthetic by design |
| `synthetic-click-preferred` | a `click`/`dblclick` ran the occlusion-honest synthetic path by default; pass `args:{ native:true }` to force a trusted native click |

(No `inputModeReason` is set when real input simply isn't configured; synthetic is the expected default there.)

### Enable real input (optional, opt-in)

Point Reticle's server at a Chrome DevTools (CDP) endpoint; it then drives **real** pointer input (via Playwright `connectOverCDP`) at the element's box for `hover`/`drag` (and for `click`/`dblclick` only when you pass `args:{ native:true }`, since clicks default to synthetic), and reports `inputMode: "real"`.

1. Launch your browser with remote debugging:

   ```bash
   # Chrome/Chromium
   google-chrome --remote-debugging-port=9222 http://localhost:3000
   ```

2. Tell the Reticle server where it is, via the MCP config `env`:

   ```jsonc
   // .mcp.json
   {
     "mcpServers": {
       "reticle": {
         "command": "npx",
         "args": ["@reticlehq/server", "mcp"],
         "env": { "RETICLE_CDP_URL": "http://localhost:9222" },
       },
     },
   }
   ```

That's it. Reticle correlates the CDP page to your SDK session by URL; pointer actions now fire native hover/enter so hover-gated suggestion panels, tooltips, and pointer-based drag become drivable. Everything else is unchanged, and with no `RETICLE_CDP_URL` set, Reticle stays in the synthetic (zero-dependency, in-page) mode. Playwright is an optional dependency loaded only when you opt in.

> **SPA navigation is handled.** The URL correlation tracks client-side route changes (`pushState`/`replaceState`/`popstate`), so real input keeps working after your app navigates into a sub-route, e.g. the hover/quick-edit cluster on a `/workspace` view stays drivable. (If you see `inputModeReason:"page-not-correlated-to-a-cdp-target"`, the reported session URL isn't correlated to a CDP target and real input silently falls back to synthetic.)

> **Watching the agent (presenter).** With `present: true` the activity border now glows once while the agent is busy and fades when idle (no per-action strobe); the HUD sits **bottom-center**, shows a **READING** vs **ACTING** chip so you can tell observation from action at a glance, and `reticle_session {action:"narrate"}` lines are **queued** with a minimum on-screen dwell so none flash by unread.

> **Limitation: un-scriptable tabs.** Reticle observes/drives a tab through the in-page SDK + (optionally) CDP; it **cannot bring to front or recover a browser tab the OS won't let it script** (e.g. a backgrounded or non-default-browser tab reporting `hidden:true`/`throttled:true`). When that happens, `reticle_sessions` and every act/assert result carry a `session.recommendation` saying so and pointing to `reticle drive <url>` for a guaranteed scriptable context. Refocus the tab, or use `reticle drive`.
