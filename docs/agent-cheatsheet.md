---
title: Agent cheat sheet
description: 'One screen to get fluent: the look → act → observe → assert loop, with the exact calls to make.'
icon: bolt
---

The loop is **look → act → observe → assert**, and only `reticle_act_and_wait` and `reticle_assert` produce a verdict. Reach for `reticle_act_and_wait({ ref, action, until })` first: it names the expected consequence before the action, which is the difference between a check and a rationalisation. `verified: "unknown"` is not a pass.

One screen to get fluent. Reticle is the **proof layer for AI agents**: no screenshots, no vision model, evidence not prose. Everything below returns structured data. Full guide: [usage.md](usage.md).

## The core loop: look → act → observe → assert

| Verb | Tool | One-liner |
| --- | --- | --- |
| **look** | `reticle_snapshot` / `reticle_query` | See the page (semantic tree) / find one specific element. |
| **act** | **`reticle_act_and_wait`** / `reticle_act_sequence` / `reticle_act` | **Act + name the consequence, one hop. Reach for this first.** / batch a whole journey in one hop / move the app and prove nothing. |
| **observe** | `reticle_observe` / `reticle_wait_for` | Everything the app did after `since` / block until true. |
| **assert** | `reticle_assert` | Evaluate a predicate → `{ pass, evidence, failureReason? }`. The end of every loop. |

> **Only `reticle_act_and_wait` and `reticle_assert` produce a verdict.** Everything else moves or reads the app and proves nothing, so a drive ending without one of those two has no result however many tools it used. `reticle_act` is the tool agents reach for by habit and it catches nothing; `act_and_wait` is where defects actually surface. And `verified: "unknown"` is not a pass: it means Reticle drove the app and could not tell what happened. Report it as unknown.

`reticle_act` returns a `since` cursor; pass it to `reticle_observe({ since })` to scope the window. Elements are addressed by stable refs (`e7`) from `snapshot`/`query`; they re-resolve across re-renders.

**`assert`/`wait_for` are auto-scoped to your last act.** By default they only count events buffered _since_ the most recent act, so a stale signal from a previous step can't fake a pass. Pass an explicit `since` to override. **Clicks run the code, not pixels:** `reticle_act` click fires the full pointer sequence on the element (no coordinate gesture for the HUD to intercept), reports `occluded:true` when something covers the target, and stays synthetic even with CDP configured (use `args:{ native:true }` for a trusted native click).

**Never sleep. Wait deterministically.** Fixed sleeps are the #1 cause of flaky agent tests. Instead:

- `reticle_act_and_wait({ ref, action })` with **no `until`** waits for the page to _settle_ (network + structural DOM idle; ambient count-up/spinner churn is ignored so an animated page still settles) before returning: the one-call replacement for "click then sleep 500ms".
- Need to wait without acting? `reticle_wait_for({ predicate: { kind: "settled", quietMs } })`.
- Waiting for a specific outcome? Pass that consequence as the predicate (`{ signal }` / `{ net }`), or `allOf` it with `{ kind: "settled" }` to wait for both the event _and_ the page going quiet.

**A predicate that does not parse produces NO verdict, not a failing one.** Nothing runs, so the drive ends with no result at all, which is strictly worse than a failure. The shapes below are the ones agents reach for most; the first column now works, but knowing the second saves you the round trip:

| You may write | It means |
| --- | --- |
| `{ kind: "text", text: "Saved" }` | `{ kind: "text", contains: "Saved" }` |
| `{ kind: "element", role: "button", text: "Save" }` | `{ kind: "element", query: { role, text } }` |
| `{ kind: "route", url: "/checkout" }` | `{ kind: "route", contains: "/checkout" }` |

**New in 2.8.0, and it changes what some existing assertions mean.** An element predicate now CHECKS `value` and `text` instead of quietly folding them into the locator and ignoring them.

```jsonc
// Now a real assertion about the field's contents. Before 2.8.0 this passed
// whatever the input held, because `value` was read as a locator operand and,
// with no `by`, silently did nothing.
{ "kind": "element", "role": "textbox", "name": "GST amount", "value": "274.58" }
```

Two consequences worth knowing before you write your next predicate:

- **You can now assert what a field contains.** That was not possible before; agents worked around it by reading the value out of band with `reticle_query` and comparing in prose, which produces no verdict and therefore does not count as verification.
- **`{ role, text }` now checks the text.** It used to match on role alone, so it matched every button on the page. If an assertion you have used for months starts failing, that is the likely reason, and the failure is the truth arriving late.

Fields that nothing can check are refused rather than ignored: `by` without a `value`, and `label`, `placeholder`, `testid`, `alt` or `component` when a higher-precedence field already selected the element. An element query is a first-match dispatch, not a conjunction.

**Combinators take `predicates`, not a bare array.** This is the shape most often got wrong, and it is the one that produces no verdict at all:

```jsonc
// WRONG: neither of these parses
{ "allOf": [ … ] }
{ "kind": "allOf", "allOf": [ … ] }

// RIGHT
{ "kind": "allOf", "predicates": [ … ] }
{ "kind": "anyOf", "predicates": [ … ] }
{ "kind": "not",   "predicate":  { … } }
```

Each child reports its own evidence, in order:

```jsonc
{
  "kind": "allOf",
  "predicates": [
    { "kind": "signal", "name": "auth:granted" },
    { "kind": "net", "method": "POST", "urlContains": "/api/login", "count": 1 },
    { "kind": "console", "level": "error", "absent": true },
  ],
}
// -> evidence: [ { name: "auth:granted", … }, { matched: 1 }, { absent: true } ]
```

If a predicate is still rejected, the error names the fields **that kind** accepts. Read it rather than guessing again, and note `state` spells its selector `path` while `route` spells its `pathname`.

**Assert a consequence, not just presence.** `{ signal }` / `{ net }` prove the feature actually did something; `{ element }` / `{ text }` only prove something is on screen, which a stale render or a locator healed to the wrong element can fake. A _passing_ presence-only `reticle_assert` returns `advice` nudging you to a consequence; heed it on anything that matters.

## The 4-layer cross-check: never trust a green the state contradicts

A claim is real only when the layers agree. Check more than the UI:

| Layer | Tool(s) | Question it answers |
| --- | --- | --- |
| **UI** | `reticle_snapshot` / `reticle_query` | Is it on screen / in the right state? |
| **signal** | `reticle_capabilities` / `reticle_observe` | Did the app emit the intent it advertised? |
| **network** | `reticle_network` | Did `POST /x` actually fire and return 200? |
| **store** | `reticle_state` | Does live framework/store state match? |

> **Rule:** a passing UI assert that the store, network, or signal contradicts is a **false green**.

**Session health is universal.** Every live-session tool result carries a `session` block (`throttled`, `focused`, `lastSeenMs`); when `throttled:true` it also adds a `warning` + `recommendation` (refocus, or `reticle drive`). A throttled/backgrounded tab can silently no-op timers/rAF/pointer gestures. If you see `session.throttled`, distrust a green and refocus first.

> Store reads (`reticle_state`) are the reliable path; the DOM can lie (optimistic UI, stale render).

**Truncation and coverage are declared, never silent.** A big `reticle_state` read carries `truncation` when the transport caps dropped items; its presence means "this is NOT the whole value", so an absence assertion over a truncated read proves nothing; scope with `path`/`depth` instead. A `reticle_assert` verdict carries `coverage` when part of the page was unobservable (cross-origin iframe, closed shadow root); a green then means "nothing failed in the part I could see", not "the page is correct". Both fields are **omitted when everything was fine**, so their presence is the warning.

**Charts report their own geometry faults.** Any element descriptor containing a broken plot carries `chart: [{ kind, tag, attr, sample }]`, one of `non-finite-coordinates` (a zero-range scale divided by zero; always a bug), `empty-geometry` (mounted but no data reached it), `degenerate-geometry` (every point identical). No extra call and no flag: query the chart as you would anyway. A healthy chart adds nothing. This matters because a chart is the one widget whose correctness is _geometry_: the store can be right while the polyline is blank, and neither a state read nor a screenshot catches it. Canvas charts are pixels, not DOM: read their data with `canvasChartData(canvasEl, window)` instead.

**Reads never go silently empty.** A zero-result read returns a `hint`, not a bare `[]`: `reticle_query` → `{ route, presentTestids, knownEmptyState }`; `reticle_network` → `{ totalInWindow, present[] }` (what DID fire); `reticle_console` → `{ totalInWindow, byLevel }` (so "0 errors" ≠ "silent page"); `reticle_state` lists `storeNames` when a store isn't found. Read the hint before assuming "not there." Scope big stores with `reticle_state({ store, path:"a.b.0", depth })` instead of paying for the whole tree; a wrong `path` returns `{ found:false, availableKeys }` so it's self-correcting.

## Core tool set

The tools advertised DIRECTLY, i.e. what you'll use 90% of the time. Everything else is one `reticle_run` away (see Token note below).

`reticle_sessions` · `reticle_navigate` · `reticle_snapshot` · `reticle_query` · `reticle_act` · `reticle_act_sequence` · `reticle_act_and_wait` · `reticle_observe` · `reticle_network` · `reticle_console` · `reticle_wait_for` · `reticle_assert` · `reticle_state` · `reticle_inspect` (DOM node → `src/App.tsx:104`) · `reticle_feedback` (tell the maintainers what is missing) · `reticle_session` (hand back: `{action:"yield"}` the moment you stop driving, `{action:"resume"}` after a human pause).

Frequently useful but NOT core, so reach them through `reticle_run({ tool, args })`: `reticle_capabilities` (the app's whole testable surface in one call; `{fromDisk:true}` needs no browser), `reticle_domain` (learn the app + gaps), `reticle_baseline {action:"diff"}`, `reticle_project` (run history).

**Reach past core when…** you need to record/replay a journey (`reticle_record {action:"start"}/stop`, `reticle_replay`), persist a self-healing golden flow (`reticle_flow_save*` / `reticle_flow_replay` / `reticle_flow_heal`), compile annotations (`reticle_annotate`), explore autonomously (`reticle_explore` lists controls; `reticle_verify {action:"crawl"}` clicks them all and reports anomalies, and is **destructive**), reveal a virtualized off-screen row (`reticle_scroll_to`, for when `reticle_query` finds nothing because a windowed list hasn't rendered it yet), visual-check (`reticle_screenshot` / `reticle_visual_diff`, pinned with `reticle_viewport` for reproducible baselines), test error/edge states by stubbing the network (`reticle_network_mock`: 500 / offline / delay, driven or leased), control time for toasts/debounces/auto-dismiss (`reticle_clock { freeze | advanceMs | reset }`), or work with a human (`reticle_session {action:"end"}` / `reticle_session {action:"resume"}` / `reticle_session {action:"messages"}`, and **`reticle_session {action:"review"}`** to drain + fix the bugs the human flagged from the panel).

## flows vs baselines vs project.json (the persistence layers)

| Artifact | Tool(s) | What it is |
| --- | --- | --- |
| **flows** | `reticle_flow_save*` / `reticle_flow_replay` / `reticle_flow_heal` | Replayable **golden journeys**, anchored to testids/signals; drift is legible and self-heals. |
| **baselines** | `reticle_baseline {action:"save"}` / `reticle_baseline {action:"diff"}` | Structural **"before" snapshots**; `reticle_baseline {action:"diff"}` flags regressions against them. |
| **project.json** | `reticle_project` | Cross-run **run-history**: "did it behave like last run?" read via `reticle_project`. |

> `reticle_project` / `project.json` are the **run-history layer**. flows answer "does the journey still work?"; baselines answer "did the structure change?"; project.json answers "is this run consistent with prior runs?".

**Visual layer (opt-in).** `reticle_screenshot` saves a PNG baseline to `.reticle/visual/<name>.png`; `reticle_visual_diff` perceptually compares the live page to it (`{ masks }` to ignore volatile regions, `{ maxRatio }` tolerance) → `{ matched, changedPixels, ratio, region, diffPath }`. It answers "does it **look** right", complementary to the behavioral layers, never a replacement. Both need a **driven browser** (`reticle drive <url>` / `RETICLE_CDP_URL`); without one they return `{ ok:false, reason:"no-visual-provider" }` (the always-on SDK ships no screenshotter).

## Fields worth reading that you may not know are there

Recent additions, each of which answers a question agents were previously asking a second call to resolve:

| Field | On | What it tells you |
| --- | --- | --- |
| `expiresInMs` | `reticle_lease { action: "acquire" }` | How long the lease lives if untouched, reset by every call that targets it. Plan a pass to finish inside it, or re-acquire deliberately, rather than losing a measurement to a silent expiry. |
| `scroll` | `reticle_inspect` | `scrollTop`, `scrollHeight`, `clientHeight`, `overflowY`. Whether the element scrolls, which you cannot infer from geometry alone. |
| `timeline_omitted` | `reticle_record { action: "stop" }` | The raw event timeline is not in the response. It says how many events there were and names the call that returns them, with the cursor filled in. |
| `elided` | `reticle_act_and_wait` | Some diff arrays were capped. The count is real even when the list is trimmed, so a small array does not mean a quiet app. |
| `colorTokens`, `themeScope` | `reticle_inspect` | Every design token matching a colour, not one arbitrary winner, and which theme the reading was taken under. The singular `colorToken` is `null` when several tokens share a colour, because naming one of them was the defect. |
| `why` | `reticle_sessions`, when the list is empty | Why nothing is connected, and the next action. An empty list is never the end of the road. |

**When a verdict comes back `unsettled`,** it now names what it was waiting for and what the window actually held. Read those before retrying: an `unknown` that explains itself is a retry with a better `until`, and one that does not is a dead end.

**If the port is taken,** `reticle kill` frees it and leaves your own MCP proxy alone. Do not reach for `lsof -i :4400` and kill what it lists; that matches every process on the port, including the proxy you are talking through.

## Start here

0. Just ran `reticle init` / started the dev server? Poll `reticle_sessions()` until your tab appears. Readiness is server-internal now, so the first live call already blocks until the SDK connects.
1. `reticle_sessions` finds the connected tab (omit `sessionId` if there's only one). **An empty list is not a dead end: read the `why` field.** It names which case this is (no app running, an app running that has never dialled this daemon, a project that never went through `init`, or a tab that closed) and the fix for each. Do not fall back to static reasoning until you have read it.
2. `reticle_domain` learns the app BEFORE testing: the saved flows, what each asserts, and the **gaps** (declared signals/testids that no flow verifies, i.e. untested intent). Tells you what to test and where the real risk is without crawling the whole app. Falls back to `reticle_capabilities` for the raw testable surface (`testids`, `signals`, `stores`, `flows`).
3. Run the loop: **look → act → observe → assert**, cross-checking the 4 layers on anything that matters.

## Token note

- **Keep observation cheap.** Prefer `reticle_query` / scoped or `interactive` `reticle_snapshot` / `reticle_assert` over dumping the full tree. A full verify loop is ~100 tokens; see [token-efficiency.md](token-efficiency.md) (~73× leaner than full-tree snapshots).
- **Re-look with `reticle_snapshot({ diff:true })`** after an action; it returns only what changed (`mode:delta`/`unchanged`), ~99% fewer tokens than a full re-snapshot and no stale tree to mis-read. Every snapshot/query result carries `cost:{ bytes, tokens }`, so re-scope before reading if it's large.
- **Cap broad reads.** `reticle_query` takes `limit` (caps descriptors; reports `total`/`truncated`) and `count_only` (just the match count). `reticle_network` / `reticle_console` take `limit` (most-recent-N, reports `droppedOldest`) and carry the same `cost` hint, so a busy page or wide window never floods your context unnoticed.
- **A saved flow tells you if it's a real test.** `reticle_flow_save` returns `assertions.grade` (`asserted` / `presence-only` / `assertion-free`); if it's not `asserted`, add a consequence (`reticle_annotate` assert-signal/assert-net or a success-state) so it can't pass while broken. On replay, an ambiguous heal (two testids tie) is surfaced, never auto-applied. And an `apply` heal re-replays the rebound flow and **refuses to write** if the success consequence no longer fires (`status:consequence_broken`): it heals the locator, never the intent.
- **Predicate schema is not bloated.** The recursive predicate DSL used by `reticle_assert` / `reticle_wait_for` / `reticle_act_and_wait` is **factored, not inlined**: when converted to the JSON Schema MCP sends, the predicate body is emitted **once** (~2.7k chars ≈ **~685 tokens** per tool) and recursion is handled by self-`$ref` (`#/properties/predicate`), with no per-recursion duplication. No action needed.
- **One tool surface.** Reticle advertises the core set directly (sessions/navigate/snapshot/query/act/act_and_wait/observe/network/console/wait_for/assert/state/inspect/feedback/session: the whole detect loop, plus the file-pointer, the feedback channel and the handback) PLUS two meta-tools that keep every other tool one call away: `reticle_tools` (discover; no args lists every tool name + summary, `names:[…]` loads full params on demand) and `reticle_run({ tool, args })` (invoke any tool by name; a top-level `sessionId` is forwarded to the target, so you need not nest it in `args`). So to record/replay/verify a flow, call `reticle_run({ tool:"reticle_verify", args:{ action:"flows" }, sessionId })` (or `reticle_tools` first to see params). There is nothing to pick. `RETICLE_ADVERTISE_ALL_TOOLS=1` (read by the daemon at startup, so restart it) advertises everything with output schemas: a verification switch for suites, not a way to run agents. **Sizes are deliberately not quoted here.** A count in prose goes stale, and has three times already. `reticle_tools` reports the live surface, and SKILL.md carries the one gated table.
