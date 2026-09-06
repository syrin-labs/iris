---
title: Telemetry contract
description: 'Read this before adding a tool, an event, a finding kind, or a failure path. Telemetry fails silently.'
icon: file-contract
---

> For anyone (human or agent) adding a tool, an event, a finding kind, or a failure path to Reticle.
>
> The rules here are enforced by `packages/server/src/telemetry/telemetry-contract.test.ts`. If you break one, that test tells you which and where. This page is why.

## Why this has its own contract

**Telemetry fails silently.** Nothing throws when an event is missed. No test goes red. No user complains. The data is simply, permanently absent, and you find out months later when someone asks a question the data cannot answer, about a period you can never re-collect.

That has already happened here twice, and both times the code looked correct:

- `daemon_stopped` was emitted fire-and-forget microseconds before `process.exit(0)`. The POST was killed every single time. The event **never once arrived**, and nothing anywhere indicated a problem.
- `bug_found` hand-copied the twelve contradiction kinds into a local `Set`. Correct on the day it was written; the thirteenth kind would have been silently miscounted, quietly deflating the one number we intend to publish.

So the rule is not "remember to add telemetry". The rule is that the guard lives in a test.

## The five rules

### 1. Everything routes through a chokepoint

Tool usage, timing, errors, verifications and bugs are all recorded in **one place**: `runTool` in `tools/invoke-tool.ts`. Adding a tool to `TOOLS` is all it takes to be instrumented.

Do **not** add telemetry inside a tool handler. If you find yourself wanting to, the metric probably belongs at the chokepoint, read off the result.

> The exceptions are paths that genuinely do not go through `runTool`. One is the verification runner (`reticle verify`, the HTTP verify surface), which has its own reporter in `telemetry/run-telemetry.ts`. The other is the MCP proxy's POST leg (`postToSession`): a socket failure there never reaches a tool handler, so the counts live on the proxy's session summary and flush as `session_progress`. **If you add another dispatch path, it needs the same treatment**, and until it has one it is invisible. That gap existed for real: CI-found bugs were uncounted.

### 2. Names say what happened

`<noun>_<verbed>`, lowercase, no abbreviations: `verification_completed`, `bug_found`, `runtime_crashed`.

## Counting defects: instances vs distinct

`bug_found` fires once per OCCURRENCE. A defect hit five times in a session is five events, which is the right raw signal; frequency is what says which classes of defect actually cost anybody anything. But it means a naive count answers "how often were defects hit", not "how many defects were found", while looking like it answers the second.

So every `bug_found` carries **`repeat`**: false the first time a KIND is seen in a session, true after. Count `repeat: false` for **distinct defects**; count everything for **instances**. Measured on a real app, the instance count was more than double the defect count. Publishing instances as defects inflates the claim accordingly.

The denominator is **`verification_completed`**, which fires per verdict with `via`, `verified`, `passed` and `falseGreenCaught`. Defects per verification is the honest rate; raw defect counts grow with usage and say nothing on their own.

**And `repeat` only means anything if the session remembers.** `SessionMetrics.reset()` runs at every periodic flush and used to clear the seen-kinds set with the window counters, so the same defect, re-found after a flush, reported `repeat: false` again. Sessions in the data run to 11.5 hours. Window counters zero on a flush; session-lifetime memory does not. (`session-window.test.ts`)

Two rules follow, and both are gated:

- **`repeat` is set at the EMISSION site, never by the classifier.** `bugsInResult` is a pure function over one tool result and cannot know what a session has already seen; if it ever grows a `repeat` field it will be guessing, and the guess becomes the published number. (`telemetry-contract.test.ts`)
- **Session-scoped, and it cannot be otherwise.** The payload carries no selector, URL or app detail by design, so the same defect in two sessions is unrecognisable as one, and making it recognisable would require collecting exactly what this event refuses to collect.

The old set failed this so badly it confused its own authors: `invoke` meant "the CLI ran" while `tool` meant "a tool was called", which is the opposite of how both read. A name that has to be looked up is a name that gets misread on a dashboard a year from now.

### 3. Names, never values

| Send                                 | Never send              |
| ------------------------------------ | ----------------------- |
| Parameter and flag **names**         | What they were set to   |
| Error **shape** (variables stripped) | The message             |
| **Our** stack frames                 | The user's stack frames |
| The **kind** of a defect             | What it was found in    |
| A hash of the git origin             | The origin              |

`--http-token` holds a secret. `reticle_act`'s `args` holds the text being typed into the app, which on a login form is a password. Assume every value is the worst thing it could be.

There is one narrow exception, and it is explicit rather than heuristic: parameters whose values are enums **we** defined are allow-listed in `telemetry/argument-shape.ts`, and anything unrecognised reports as `other` so a schema change cannot start forwarding free text.

### 4. Never derive a vocabulary by copying it

If a set of kinds already exists in `@reticlehq/core`, **import it**. Do not re-list it.

```ts
// ✗ correct today, wrong the moment core gains a member, and silent about it
const KINDS = new Set(['ui-advanced-request-failed', 'signal-contradicted' /* …10 more */]);

// ✓ cannot drift
const KINDS = new Set(Object.values(ContradictionKind));
```

A copied enum is a drift hazard anywhere. It is a **correctness** hazard when the thing that drifts is a number you publish.

### 5. A metric may never change behaviour

Every send is wrapped and best-effort. A telemetry failure must not fail a tool call, a verification, a daemon start, or `reticle init`.

The single exception is `daemon_stopped`, which is **awaited**, because the process exits immediately after and the send would otherwise be killed. Even then a failure resolves rather than throws.

## The event kinds, all of them

`TelemetryEventKind` in `@reticlehq/core` is the closed list. Seven of these went undocumented here for months (the doc described only the session-lifecycle half), so anyone building a dashboard from this page could not know that the transport and install events existed at all. A kind nobody documents is a kind nobody queries, and telemetry that nobody queries is telemetry nobody notices has stopped arriving. `telemetry-contract.test.ts` now fails when a kind is missing from this table.

| Kind | When | What it answers |
| --- | --- | --- |
| `reticle_installed` | first-ever run on a machine | install count, and the new-user curve |
| `cli_command_run` | a human ran a `reticle` subcommand | human intent: `verify`/`gate` mean something very different from `status`. Never emitted for the internal `_daemon` spawn |
| `daemon_started` | the daemon came up | active sessions, DAU/WAU/MAU |
| `daemon_stopped` | clean exit | the rich session roll-up. **Count sessions with this one**; see below |
| `session_progress` | periodic flush from a LIVE daemon | same payload, `final: false`. Sum work across both |
| `verification_completed` | a verdict was produced | the product's reason to exist: was an app actually verified |
| `project_profiled` | once per daemon start | stack, size, and how deeply the feature surface is used (activation vs retention) |
| `version_changed` | the running version differs from last seen | upgrade adoption, and whether a nudge caused it |
| `runtime_crashed` | an unhandled failure in the daemon | stability |
| `feedback_submitted` | `reticle feedback`, or an agent's report | the qualitative channel |
| `identified` | `reticle identify` | joins anonymous machine ids to a person who volunteered one |
| `mcp_client_connected` | an MCP client attached | how many sessions are agent-driven at all |
| `app_instrumented` | the first app carrying the SDK reached this daemon | **the funnel step everything turns on**; see below |
| `mcp_connection_lost` | the proxy lost its daemon | **the transport-stability metric.** The disconnect that makes a user reopen `/mcp` is invisible without it |
| `init_completed` | `reticle init` finished | does install actually work, outside the fixtures gate |
| `bug_found` | a defect was detected in the app under test | the value delivered, as opposed to the work done |
| `tool_refused` | a tool could not do what was asked | WHY the largest cohort in the funnel goes quiet. See below |

## The install has two halves: `app_instrumented`

Reticle is only usable when both halves are done: the MCP server is registered so the agent has the tools, and the SDK is loaded by a running page so there is something for those tools to look at. They are done by different commands, at different times, often in different directories. Almost everyone completes the first. The second is where the users go.

Nothing measured the second. `daemon_started` and `mcp_client_connected` describe the agent half. `session_appConnects` describes the app half but is a **window counter**: it resets on every flush, so a user whose app connected in one window reads zero in every other. The population it under-counts is precisely the population being measured, and a funnel built on it reported fewer instrumented users than there were users calling tools, which is impossible on its face.

`app_instrumented` fires **once per daemon run**, on the first session-ready only, so `daemon_started` → `app_instrumented` is a rate rather than an inference and a reloading page cannot inflate it. It carries `initialized` (had `init` run here), `agentAttached` (was an agent already waiting), and `msToFirstApp` (how long the daemon sat with nothing wired). It deliberately carries no stack and no framework: `project_profiled` already reports both for the same run, and the two join on `sessionId`.

The failure side is a **set difference**, not an event: `daemon_started` minus `app_instrumented`, joined on `sessionId`. There used to be an `instrumentation_stalled` event for it, and it was removed because the derivation is strictly more complete. The event could only fire on a flush tick or a graceful shutdown, so a killed daemon never produced one and landed in the absence anyway, while the set difference catches it. Two ways to compute one number, disagreeing with each other, is worse than one way.

## Where the install stopped: reading the non-instrumented majority

Most daemons never see an app. The failure side is a **set difference** -- `daemon_started` minus `app_instrumented`, joined on `sessionId` -- and a set difference cannot say why. Four situations with four different owners land in it as one silence.

Three fields split it, and none of them is a new event kind:

| `init_completed.ok` | `project.initialized` | `project.appConnectedBefore` | Reading | Owner |
| --- | --- | --- | --- | --- |
| -- | `false` | `false` | `init` was never run here. Nothing was ever wired. | acquisition / docs |
| `false` | -- | -- | `init` ran and failed. `init.reason` says which step. | us |
| `true` | `true` | `false` | The config is written and **no page has ever reached the daemon**. The dev server was never restarted, the plugin never loaded, or the handshake was refused page-side. | us + onboarding |
| -- | `true` | `true` | A working install whose app simply is not up right now. **Not a loss.** | nobody |

The third row is the cohort the funnel actually loses, and it was invisible: `initialized` alone is `true` for the working installs too, so only the pair separates them.

What this still does **not** answer: whether the dev server is running right now. Nothing probes for one at profile time, so "restarted the dev server and it still did not connect" and "never started the app at all" are both in the third row. `no-session-diagnosis.ts` computes that distinction live, for the agent, as prose -- it is not classified and it is not emitted.

Two more traps on these fields. `project_profiled` fires **5 seconds after** the daemon comes up, so a daemon killed inside that window sends none of this and lands in the silence it was meant to explain. And `appConnectedBefore` is scoped to project + port: an app that has only ever connected on a different port reads `false`, correctly for the question asked and wrongly if you read it as "this user has never had Reticle work".

## What the agent had to look at: `connection.appConnected`

Most MCP clients that attach never call a single tool, and that cohort emits **nothing at all**. `tool_refused` cannot see it -- an agent that reads the server instructions, learns nothing is wired, and stops has refused nothing, because it made no call.

`connection.appConnected` is the one bit that splits it. `false` means the handshake happened against a daemon with no app to look at, which is the state the first-move instructions describe and the state in which no tool could have answered anything. The two halves need opposite fixes: one is an install that never finished, the other is an agent that had everything it needed and did not use it.

It does **not** say which instruction variant the agent was served. `buildServerInstructions` keys on `previouslyConnected` (durable, project-scoped), not on whether an app is attached right now, and those disagree on a working install whose page is closed.

## Was the verdict trustworthy: reading `unknown` and the passing greens

Two questions get asked of `verification_completed` constantly and both have exact answers already in the payload. Neither needs a new field, and both are read wrong without `reason`.

**"A large share of verdicts come back `unknown`."** `verified` has three values and the rule that produces it has eleven clauses, so `unknown` on its own is seven different situations belonging to three different owners. **Always break `unknown` down by `verification.reason`** before treating it as a quality number:

- `inconclusive`, `nothing_declared`, `vacuous_grade` -- the agent's own call. Teach the agent; the product worked.
- `outcome_pending`, `outcome_unread`, `unsettled`, `evidence_incomplete`, `window_closed_early` -- the app had not finished. Wait and re-check; often a budget that ended early.
- `observation_lost`, `unclean_capture`, `absence_blind_spot` -- **ours**. Ship a fix. `uncleanLoss` names which of the three owners inside that one.

An `unknown` rate quoted without this split is a number about all three at once and actionable by none of them.

**"Many verdicts passed their own assertion yet did not report `yes`."** That is `passed: true` with `verified !== 'yes'`, and it is mostly the product working as designed: `decideVerified` refuses a green seven ways. Split it:

- `verified: 'no'` -- a green actively refuted by another channel. This is `falseGreenCaught`, and it is the thesis.
- `verified: 'unknown'` -- Reticle declined to endorse a green it could not stand behind. `already_true` (the condition held before the action, so the check proved nothing) is a _correct_ refusal and not a defect anywhere.

`falseGreenCaught` is deliberately narrow -- only `passed && verified === 'no'` -- so the wider number can be counted from `reason` without a definition change. **Do not widen it**: a metric whose definition shifts underneath it produces two series that look comparable and are not.

## Sessions: `daemon_stopped` vs `session_progress`

Count sessions with **`daemon_stopped`** (`final: true`). It fires once, at a clean exit.

A running daemon rolls its window up every 5 minutes as **`session_progress`** (`final: false`), same payload shape. Sum work across both; count sessions with neither summed nor doubled.

This split exists because the flush used to be emitted AS `daemon_stopped`, an event named for an exit, fired while the process was alive. Anything counting sessions over the raw event therefore over-stated, and the two populations it merged are opposites: a flush comes from a daemon that has served tool calls, while a clean exit comes from one that has not, because a daemon that has served a tool never idle-exits and so never reaches a clean shutdown. A funnel over the raw event describes active sessions at one end and abandoned ones at the other.

The flush interval is also the **bound on what is lost**: nothing calls shutdown when a working daemon is finally killed, so its last partial window dies with it. The old 30-minute interval was long enough to lose most of a typical session that way. Only non-empty windows emit, so a short interval costs nothing on the daemons that never serve a tool.

## The session summary's newer fields

Four counters and one flag were added because the data could not answer questions we were already asking. All are properties on events that already exist (no new kinds), and all four counters are **omitted rather than sent as zero**, so a field's presence is itself the signal.

| Field | On | Means |
| --- | --- | --- |
| `noSessionErrors` | session summary | tool calls that failed because there was no app to reach: no session, no session by that id, or several with none named. The largest drop-off in the funnel; it was previously reachable only by unpacking `errors[]`. |
| `postSocketFailures` | session summary | connection-level POST failures on the MCP proxy (`ENOBUFS`, `EMFILE`, `EADDRNOTAVAIL`, `ECONNREFUSED` before any bytes were sent). These never produce `tool_refused` (the call never reached a handler) and never produce `mcp_connection_lost` (the SSE stream is fine). Counted in the proxy process and flushed as `session_progress` on stdin end. The send is awaited, because fire-and-forget before `process.exit` is how `daemon_stopped` never arrived. Absent when none happened. |
| `postRetriesSaved` | session summary | of those POST failures, how many a bounded retry then delivered. The numerator against `postSocketFailures`: a retry that quietly saves a call is a different fact from a retry that never runs. Absent when none were saved. |
| `consecutiveRepeats` | session summary | longest back-to-back run per tool name. `toolCounts` reports five useful calls and five retries of one failing call identically, and those are opposite facts. |
| `abandonedActions` | session summary | actions driven with no verdict AFTER them (the trailing unsettled run, not `actions - verifications`). That difference ignores order, so a verdict that drove nothing (a `flow_verify` over saved flows) silently paid for an abandoned action elsewhere. |
| `endedWithVerdict` | session summary (final only) | did this session ever produce a verdict. The headline metric, and previously the only thing in the payload that had to be COMPUTED, from lifetime counters sitting next to windowed ones, which is a subtraction that gets read wrong. Sent as `false` rather than omitted: a session that drove an app and never asked whether it worked is the finding. |
| `verification.browser` | `verification_completed` | `headless` \| `headed` \| `attached`: who DROVE the browser. `attached` (Reticle launched nothing, the SDK connected from a browser somebody else opened) is the common case in production, so on its own this is mostly "somebody's own browser". |
| `verification.brand` | `verification_completed` | WHICH browser it was: `chrome` \| `edge` \| `arc` \| `dia` \| `brave` \| `opera` \| `firefox` \| `safari` \| `other`, the closed `BrowserBrand` list in core. The axis `engine` cannot answer, since Chrome, Edge, Arc, Dia and Brave are all `blink`. The SDK reads `navigator.userAgentData.brands` (and the UA string on Firefox/Safari, which expose no `userAgentData`) and normalises IN THE PAGE: a raw brand or UA string is unbounded and fingerprintable and never leaves. Anything unrecognised is `other`. **Omitted rather than `"unknown"`** when the page did not say. A desktop webview has no brand and an older SDK does not report one, and a guess is indistinguishable from a measurement on a dashboard. |
| `verification.reason` | `verification_completed` | WHICH clause of `decideVerified` produced the verdict, from core's closed `VerifiedReason`: `inconclusive` \| `observation_lost` \| `window_closed_early` \| `assertion_failed` \| `contradicted` \| `already_true` \| `unclean_capture` \| `vacuous_grade` \| `outcome_pending` \| `outcome_unread` \| `unsettled` (the page never went idle and no consequence was declared) \| `evidence_incomplete` (the assertion held, but a channel's outcome had not arrived when the window closed) \| `proved`. See below. |
| `verification.uncleanLoss` | `verification_completed` | WHAT was lost when `reason` is `unclean_capture`, from core's closed `CaptureLoss`: `buffer_loss` (our server ring buffer evicted evidence from the window) \| `transport_gap` (our browser queue overflowed) \| `blind_spot` (a boundary in the page, such as a cross-origin frame or a closed shadow root) \| `other`. Three owners, three fixes, and one bar on a dashboard until this existed. ONE value, not a list: a multi-value property is not something a breakdown can group by, so the first is sent, ours before the page's. **Absent whenever the capture was clean**, so its presence is itself the signal. Reported as `other` rather than omitted when the block says dirty and names nothing: a gap there would read as "no unclean verdicts happened". |
| `project.stackUnknownReason` | `project_profiled` | WHY there is no `stack`, from core's closed `StackUnknownReason`: `no_app_found` \| `manifest_unrecognised` (we READ an app's manifest and knew nothing in it, which one line in `STACK_BY_DEP` fixes) \| `workspace_apps_unrecognised` \| `workspace_root_no_apps` (a monorepo root where discovery surfaced no app at all) \| `discovery_failed`. `stack` unknown is one of the largest buckets and an empty field is not a cause: it collapsed four facts with four different fixes. **Absent whenever a stack WAS found**, so its presence marks the unknown bucket. Note `workspace_root_no_apps` is expected to dominate over `workspace_apps_unrecognised`: `findWorkspaceApps` admits a directory only on a Vite/Next config file or a literal `next`/`vite` dependency, so a workspace app on any other framework is never surfaced and its manifest is never read. |
| `bug.attribution` | `bug_found` | `app` \| `request` \| `reticle`: whose fault the defect was. **Absent means unclassified**, never `app`. See below. |
| `refusal.noSessionReason` | `tool_refused` | For `no_session` only: WHICH no-session situation, from core's closed `NoSessionReason`: `lease_expired` \| `tab_gone` \| `app_not_reopened` \| `config_elsewhere` \| `no_listener_no_config` \| `no_listener` \| `no_config` \| `sdk_not_reaching_daemon`. `no_session` is the largest refusal cohort and on its own it is a set difference: nothing connected, with no word on which of several opposite situations that was. "Restarted the dev server and it still did not connect" and "never started the app" need opposite fixes and arrived as the same silence. Derived from the branches of `explainNoSession`, not classified beside them, so the code cannot describe a diagnosis different from the sentence the user was shown. **Absent on every other refusal reason.** |
| `outage.stage` / `outage.reason` / `outage.attempts` | `mcp_connection_lost` | which stage of the outage, why the stream went away (closed `OutageReason`, `other` for anything unnamed), and how many reconnects had been tried. See below. |
| `project.initialized` | `project_profiled` | has `reticle init` run here -- a `.reticle.json` is present. On `project_profiled` rather than `app_instrumented` deliberately: that event fires once per daemon start whatever happens next, so it is the only place a fact about a project reaches us for the users who never instrument anything. **Absent means an older sender, never `false`.** |
| `project.appConnectedBefore` | `project_profiled` | has an app for THIS project ever connected to Reticle, from durable state -- not from this process. Scoped to project + port like every other reader of that state, so it cannot borrow another project's success on a shared daemon. **Absent when the daemon did not know its own port**, which is not-measured rather than `false`; a `false` invented from a read error would put the working installs into the cohort we are sizing. |
| `connection.appConnected` | `mcp_client_connected` | was an app already attached when the agent arrived. The mirror of `instrumentation.agentAttached`, read off the same flag so the two halves cannot disagree about one daemon run. The closest thing we have to WHAT THE AGENT SAW. |
| `installSource` | `reticle_installed`, `init_completed` | WHICH published route brought this install in, from core's closed `InstallSource`. Read from one self-declared marker (`RETICLE_INSTALL_SOURCE`) and NEVER inferred, so `unknown` is expected to dominate until every channel's own copy of the install command carries it. See below. |
| `licenseId` / `licenseStatus` | every event, on a licensed build | Enterprise activation. `licenseStatus` is core's closed `LicenseActivation` (`active` \| `missing` \| `invalid` \| `expired`) and rides through the FAILURE states too, which is what makes a lapse distinguishable from a churn. `licenseId` is present only while a key verifies, so on identity alone a customer whose key expired and one who left are the same silence. `licenseId` is an opaque uuid that resolves to a company only against the issuance ledger held locally, so the analytics backend never holds a customer list. The organisation NAME is never sent. **All three absent on a build with no issuer key baked**, which is every OSS install, so absence means "not a licensed build" and costs nothing to say. See below. |
| `init.confirmation` | `init_completed` | what `init` SAW after writing, from core's closed `InitConfirmation`: `connected` (an app carrying the SDK reached the daemon while it watched, and it is the only value that means installed) \| `no_daemon` (nothing was listening, so no session could arrive) \| `no_session` (a daemon was up and no app connected inside the window). **Absent means it never looked**, which is every scripted run: `init` waits only when a human is at the terminal. Read absent as "not measured", never as a failure to connect. |
| `automation` | every event | ADVISORY hint that the run looks automated when `CI` does not say so, from core's closed `AutomationHint`: `container` \| `hosted_workspace` \| `no_tty`. `ci` reads one environment variable set only by a runner, so a gate driven from a cloud sandbox lands as a human at a machine. **Never a filter**: people work in containers, in Codespaces, and over ssh with no terminal, and dropping a row because this is set drops real users. Absent means nothing looked automated, not that a human was present. |
| `tzOffsetMin` | every event | minutes offset from UTC. One integer, no location. |
| `session.updateNudged` / `session.updateOffered` | session summary | did the update nudge actually fire this daemon run, and which version it knew about. The nudge is the ENTIRE adoption mechanism for a published fix -- it rides the tool-result envelope once per daemon process -- and for several releases it emitted nothing at all. `updateNudged` is the one-shot delivery flag: `true` means an agent was told, never how often. `updateOffered` is our own published version number, so it is low-cardinality and says nothing about the machine; without it `updateNudged: false` would mean "nothing was available" and "something was and the nudge did not fire" at once, and only the second is a defect. See below. |
| `versionChange.nudged` | `version_changed` | an agent had been told about exactly this version recently, so the nudge plausibly caused the update. The daemon that nudges and the `reticle update` that acts are different processes, so a marker file joins them. |

## Enterprise activation: `licenseId`, `licenseStatus`

A licensed deployment reports which licence it is running under, so per-customer usage can be answered at all. Three things make this different from every other property here, and all three are deliberate:

**It is on every event, not on an activation event.** The questions a licensed customer generates are "how much is this org using it", "what is breaking for them", "did their key lapse", and every one of those is answered by an event that has nothing to do with licensing. A status riding only its own event would say a key verified once and nothing about the sessions it covered.

**Status is separate from identity, and reports failures.** `licenseId` exists only while a key verifies. If that were the whole signal, a lapse would look exactly like a departure, and the renewal conversation would start after the customer noticed rather than before. `licenseStatus` keeps arriving through `expired` and `invalid`. A mis-built release (production with no issuer key baked) reports `invalid` rather than staying quiet, because that one is ours to fix.

**The plan is not sent, and neither is the organisation name.** They are left out for different reasons and both are worth stating. The name is free text somebody typed when the key was signed, so rule 3 forbids it. The plan is merely redundant, which is the quieter reason and the easier one to lose sight of: the issuance ledger already holds it against this same id, so sending it would be a per-event cost, from every machine, forever, for something the join that resolves the id resolves at the same moment. `reticle license` still reports it locally, where it costs nothing.

**The organisation name never goes on the wire.** It is free text somebody typed when the key was signed, so it falls under rule 3. The id is opaque; the map from id to company is a local ledger. An analytics-side breach therefore cannot expose who is evaluating Reticle.

Resolution reads the EVENT's clock, not one captured at daemon start: sessions here run to eleven hours, and a key that expires mid-session has to start reporting `expired` from the event it expired on.

> **This changes what a licensed deployment sends, so it is a contract term, not a quiet addition.** The enterprise agreement has to say that licensed deployments report usage attributed to their licence id, and list these fields. `RETICLE_TELEMETRY=0` and `DO_NOT_TRACK` still switch it off exactly as they switch off everything else. There is no exception for licensed installs, and adding one would put a hole in the kill switch that a security review is entitled to find.

## Why they stopped: `tool_refused`

The refusal path computes a precise diagnosis, hands it to the agent as prose, and throws it away. So the biggest cohort in the funnel, the users who attach an agent and never drive, emitted nothing at all and was reachable only by subtracting two other numbers. Half of issue #172.

- `refusal_tool`: which tool, from our own fixed namespace. Never app data.
- `refusal_reason`: the closed `RefusalReason`: `no_session` | `no_match` | `unsupported` | `bad_args` | `not_ready` | `other`. Four different owners, and one undifferentiated "they stopped" number is actionable by none of them.
- `refusal_retried`: the call immediately before this one was the same tool, also refused.

Two things about it are deliberate and easy to get wrong later.

**The reason is derived from the recovery table, not from a second list of patterns.** `error-recovery.ts` is the one place a thrown message becomes a next action; `REASON_OF` is a `Record` over its keys, so a recovery added without a reason does not compile. A parallel regex list would have been correct the day it was written and silently wrong at the next addition. That is rule 4, on the exact kind of value that cannot be recovered afterwards.

**`retried` lands on the RETRY, not on the first refusal.** Reporting it the other way round means holding the first event back until the next call reveals whether one came, which loses it entirely for an agent that gives up, and that agent is the whole population this event exists to describe. So a refusal is sent the moment it happens, and the retry that follows carries the flag. Count `retried: true` for retries; the ratio against all refusals is whether our diagnosis gets anybody unstuck.

Capped at 50 per daemon run. Volume is part of this taxonomy's design and a stuck agent is exactly the shape that produces hundreds; `consecutiveRepeats` on the session summary still reports how long the loop ran.

## Did anybody hear about the release: the nudge

`versionChange.nudged` answers "did the nudge cause this update", and it only ever reaches us from machines that **did** update. The cohort that matters is the opposite one: an install pinned several releases back never fires `version_changed` at all, so the population being nudged the hardest was the population the metric structurally could not see.

`session.updateNudged` + `session.updateOffered` close that. Crossed against the same installId's `version` on a later day, they separate two causes that need opposite fixes:

| `updateOffered` | `updateNudged` | version moves later | Reading |
| --- | --- | --- | --- |
| absent | `false` | -- | nothing was available. Not a finding. |
| present | `false`, run after run | no | **the nudge is not firing for them**: a manifest cache that never warms, a check that never returns, an offline machine. Ours. |
| present | `true`, run after run | no | the agent is receiving it and **dropping it out of the envelope**, or telling a human who declines. A delivery problem, not a detection one. |
| present | `true` | yes | it worked. `versionChange.nudged` confirms from the other side. |

What it does **not** answer: whether the agent surfaced the nudge to its human. Nothing on this side of the envelope can see that, and inferring it from a later upgrade would credit the nudge for a `reticle update` somebody ran for their own reasons -- which is precisely the credit `nudge-credit.ts` bounds to a seven-day window rather than claiming outright.

One edge to know when querying: `updateNudged` reads the delivery flag, and `armUpdateNudgeFrom` re-arms it when a newer manifest lands mid-session. On a long session that spans a release it therefore reports the LAST arming's state, not "was ever shown". Sessions in the data run to eleven hours, so this is reachable; it is rare, and it errs toward `false`.

## Which route brought them in: `installSource`

Four install routes ship at once (the SKILL.md paste URL, an `npx skills add` package, a Claude Code plugin, and docs.reticle.sh), and not one install could be attributed to any of them. Every decision about where to spend distribution effort was made blind.

There is exactly ONE mechanism, and it is a declaration rather than a detection: the channel sets `RETICLE_INSTALL_SOURCE` on the process that runs the install, and `install-source.ts` narrows it against core's `InstallSource`. Anything unrecognised reports `unknown`; an echo would put whatever somebody exported onto the wire.

Nothing infers. Three things look like signals and are not: `npm_config_user_agent` says npm ran us, and all four routes go through npx; a `.claude-plugin/` directory or an installed skill folder says a route is PRESENT, not that it ran `init`, and both are present on any machine that tried more than one; and which command ran first says nothing about who told the user to run it.

So `plugin` is the only route detectable without anybody typing anything (the plugin registers the MCP server and sets the marker in its `env`). `skill_file`, `npx_skill`, `docs_site` and `readme` are detectable only where that channel's own published copy of the install command carries the marker, and each of those is a separately published artifact. `cli_direct` is not detectable at all.

**`unknown` is therefore expected to be the largest bucket, and shrinking it is a distribution job rather than a classifier job.** Read a small `unknown` as a marker that spread. A guessed attribution would be worse than none: it is the number distribution decisions get steered on, and once a guess sits in the same column as a measurement the two cannot be told apart.

**Where the value lives, and why it is not the environment.** The marker is an environment variable, so it exists for exactly one command and is gone by the next -- which is why the field originally reached two of the rarest events there are and nothing else. `init` writes it into `.reticle.json`, and `projectInstallSource()` reads **config first, then environment**, once per process, stamping it on every event that process sends. So the marker has to survive `init` to survive at all.

**A re-run backfills it, and never overwrites it.** `installSource` used to be written only when `.reticle.json` was CREATED, and `init` reports that file as `already exists` on every re-run -- so everyone who arrived before the marker shipped, and everyone who ran `init` once without one, was stuck on `unknown` with no way to fix it, which is most of the population the field describes. `configWithInstallSource()` now ADDS the field to a config that lacks one. It never replaces a recorded value: the first channel is the one that brought the user in, and a later `init` through a different route must not take credit for an acquisition it did not make. An unparseable config is left exactly as it is.

**Two ways this still degrades to `unknown`, and neither is a classifier bug.** An agent that paraphrases the published command drops the `RETICLE_INSTALL_SOURCE=` prefix along with it, and there is nothing on the machine afterwards that could recover it. And a project whose `init` never ran -- the SDK wired by hand, or a monorepo where the config sits somewhere the daemon's walk does not reach -- has no config to read from.

## Why a verdict came out that way: `verification.reason`

`verified` has three values. The rule that produces it has **eleven clauses**. Everything in between was thrown away at the moment it was known.

Captured against the real classifier: `verified: 'unknown'` covered "the agent malformed the call", "the consequence was already true", "the app answered 202", "a 2xx body went unread", "the capture was not clean", "nothing was asserted at a real grade" and "the page never settled": **seven causes, two wire payloads**. They belong to three different owners (the agent, the app, Reticle) and need opposite responses: teach the agent, wait and re-check, or ship a fix. On a dashboard they were one bar. `verified: 'no'` collapsed the same way: "channels disagree" (Reticle earning its keep) and "the agent's predicate failed" were the same string.

`VerifiedReason` lives in `@reticlehq/core` and is the **single list**. `decideVerified` returns a member from every clause, so a new clause cannot compile without one; `verified.test.ts` drives every member and fails if a member exists that no clause produces. `verification-of.ts` narrows the result field against `Object.values(VerifiedReason)`, and anything else is dropped rather than forwarded, because a string nobody can group by is worse than a gap. **Nothing re-lists these**, including the battery spec, which imports the enum from core's build.

Optional on purpose: a suite verdict (`flow_verify`) is a pass/fail with no clause behind it, and an older sender has none. Absent means unclassified.

## Whose defect it was: `bug.attribution`

It shipped twice and was wrong both times. A real drive found that across two full runs EVERY `attribution: 'app'` was a misattribution, while the one defect that genuinely was a bad agent predicate carried none. A single session would have published "2 defects in the app" against a true count of 0. So it was removed, and then absence made "nobody classified this" and "we looked and could not tell" the same fact, which is the other half of the same problem.

It is back with two rules, and both are the thing the earlier versions lacked. Issue #122.

**Always present.** `unclassified` is a value, not a gap. Absence would mean an old sender or a path that forgot; a value means the classifier ran and declined. Count `app` for defects in anybody's product; exclude `unclassified` rather than folding it in.

**`app` requires positive evidence.** Something the app itself did: a request that came back failed, a signal the app fired carrying data that disagrees with its own screen, a written field echoed back changed. Never "nothing else explained it". That line already exists in core, as `ABSENCE_DERIVED_CONTRADICTIONS`, the kinds inferred from something NOT having happened inside a window Reticle chose the end of, and it is the same line that decides whether a verdict may say `no`. Reusing it rather than inventing a second judgement beside it is the point: every historical misattribution was an absence-derived kind, so this rule produces zero of them on the data that broke the last two versions.

Everything else is `unclassified` on purpose. A failed `element.present` covers "the button is missing", "the API is down" and "the agent mistyped a testid" identically. A console error can be the app, a browser extension, or a framework's dev overlay, and one of those was a real false positive here. A replay regression says a flow that used to pass no longer does, which is a regression somewhere, and the row does not say whether the app changed or a selector strategy of ours did.

Driver-side causes need no bucket of their own: a stale ref, a malformed call and a lost session produce no `bug_found` at all, because those paths are excluded upstream in `bugsInResult` before anything is counted.

## What is NOT a crash: expected disconnects

`runtime_crashed` answers exactly one question: is Reticle stable. One real session put **nine** events into it, all `write EPIPE`: the MCP client closed its half of the stdio pipe and the next `process.stdout.write` failed, which is how a client is supposed to leave.

`daemon-resilience.ts` matches `err.code` against `EPIPE` / `ECONNRESET` / `ERR_STREAM_DESTROYED` and logs `reticle_daemon_client_disconnected` (or `reticle_mcp_proxy_client_disconnected`) instead of emitting. Two rules make this safe rather than a hole:

- **Code, never message.** Prose gets wrapped, localised and rewritten; matching it would eventually swallow a real crash that merely mentioned a pipe. `daemon-resilience.test.ts` drives an error whose message says `write EPIPE` and carries no `code`, and asserts it is still a crash.
- **Visible, never swallowed.** It still logs a line with the code. A daemon emitting a hundred of these is a finding, just not a crash.

A disconnect is also **no longer fatal for the daemon**: Node's "process state is undefined" guidance is about a throw that escaped everything, not about writing to a socket somebody closed, and exiting there let one departing client take down the daemon serving every other agent.

## Did MCP stay up: the `outage` block

The transport-stability metric shipped with an **empty payload** for months, and it is the exact failure this page opens with. `reportMcpOutage` passed `{ outage: { stage, reason, attempts } }`, `TelemetryExtra` declared the field, and it typechecked. But `emit()` builds its event from an **explicit allow-list of keys** and `outage` was not on it, nor in the `blocks` flattening map, nor in core's `TelemetryEventSchema`. Two deliberately different outages produced byte-identical events. Nothing threw, no test went red, and the data for that whole period cannot be recovered.

The lesson is not "wire the field". It is that **the battery asserted the event ARRIVED and never that it carried anything**, and a kind-only assertion cannot see an empty payload. When you add an event kind, the live check has to assert the FIELDS.

- `stage` is the closed `OutageStage`: `first` (this session lost MCP at all), `budget_spent` (it stopped retrying and went dormant), or `recovered` (the link came back on its own). Each is reported **at most once per proxy process**, so the three are a per-session state and never a count.
- `reason` is the closed `OutageReason`: `sse_ended` | `daemon_shutdown` | `sse_error` | `sse_aborted` | `sse_closed` | `connect_error` | `other`. The proxy's own reason strings are free text that also feeds a log, so `mcp-outage.ts` narrows them and reports **`other`** for anything unnamed. A classifier that cannot say "I don't know" lies instead, and an unbounded string must never reach the wire.
- `attempts`: consecutive reconnects tried when this was reported.
- `pendingLost`: in-flight tool calls this drop actually killed -- the only part an agent can FEEL. Sent always, **including zero**, because zero is the finding.

**Three things about querying this, and every one of them has already produced a wrong number.**

**`daemon_shutdown` is not an outage.** The daemon announces a planned retirement before it closes the stream, and from the socket's side that is byte-identical to a daemon dying under a live client. Without the split, the metric meant to say "the agent lost its tools" spends most of its volume counting the idle exit working exactly as designed. **Filter it out before reading this event as an outage rate at all** -- a chart over the raw kind describes the idle timer, not the transport.

**`attempts` on a `first` event is 1 by construction and carries no information.** It is emitted at the moment of the drop, when the counter has just been incremented once, and the once-per-process cap keeps any later drop from replacing it. Reading a field that can only hold one value as "reconnection never advances past the first attempt" is reading the emission point, not the transport. **`recovered` carries the real cost of coming back**; it is the only stage whose `attempts` is a measurement.

**`first` alone is unfalsifiable, and the pair is the metric.** `first` with a matching `recovered` is a blip the agent probably never noticed (check `pendingLost`). `first` with `budget_spent` and no `recovered` is a session whose tools never came back on their own, which is the number worth driving down. Counting `first` on its own over-states the problem by roughly the whole of it.

Still true and worth knowing when you query it: `mcp_connection_lost` carries **no `sessionId`** (it fires from the proxy process, not the daemon), and is capped at two per proxy process by design.

### Licence activation

Three envelope scalars, present on **every** event rather than on a licence event of their own: the questions a licensed customer generates are "how much is this org using it", "what is breaking for them" and "did their key lapse", and every one of those is answered by an event that has nothing to do with licensing.

- `licenseId`. The signed licence id. An opaque uuid that resolves to a company only against the issuance ledger held locally, so the analytics backend never holds a customer list. Present only while a key verifies.
- `licenseStatus`. `active` | `missing` | `invalid` | `expired`. Rides whenever an issuer key is baked, **including the failure states**, which is what makes a lapse distinguishable from a churn: a lapsed customer stops sending `licenseId`, so on identity alone a lapse and a departure look identical.
- `licenseKeyPresent`. A key was placed in the environment, whatever this build concluded about it.

**The trap this last one exists to close.** `licenseStatus` is absent entirely on a build with no issuer key baked, which is every OSS install and every source checkout. That is deliberate and correct for a machine with no key. And wrong for a machine with one. A customer who pastes a real enterprise key into such a build produced _no licence signal whatsoever_ and was indistinguishable from someone who has never held a key. So the one population most worth seeing was the one that could not be seen.

**`licenseKeyPresent: true` with no `licenseStatus` is the "their key is not taking effect" case.** Query for it directly; it is a support ticket that has not been filed yet.

**Never the key.** `licenseKeyPresent` is a boolean. The key is a credential and does not leave the machine, and neither does the organisation NAME (free text, and rule 3 is names-never-values) or the PLAN (the issuance ledger already holds it against the same id).

**Where the key is looked for.** The daemon is spawned without an explicit `cwd` and inherits the editor's, so `<cwd>/.env` alone missed keys routinely: in a monorepo the daemon starts at the workspace root while the key sits in the app's own `.env`, and under some editors the cwd is the user's home. `license-env.ts` searches `.env` and `.env.local`, upward to the project root and one level down into `apps/*` and `packages/*`. Only the licence key is taken out of a file found by walking. Bulk-importing a `.env` from a directory the caller never named could rebind the daemon's port or its allowed origins, which would be a far worse bug than the one it fixes.

## Recording locally instead of sending: `RETICLE_TELEMETRY_FILE`

Set it to a path and every event is appended there as one JSON object per line, and **nothing is sent**. The payload is the one the wire would have carried, built by the same code and redacted by the same rules, so what a run records is what a user would have sent.

It exists for two reasons that pull the same way:

- **A release sweep is not a user.** Driving dozens of sessions through a gate emits real `daemon_started` / `verification_completed` / `bug_found` events, indistinguishable in PostHog from people. Test runs polluting the numbers is the same class of error as counting `cli_command_run { mcp }` as human intent: the metric stops describing what it claims to.
- **Verifying telemetry should not need a hand-rolled HTTP server.** Ad-hoc harnesses are how a check ends up measuring nothing.

One deliberate exception to the rules above: `RETICLE_TELEMETRY_FILE` keeps telemetry ENABLED inside a Reticle source checkout. The checkout guard exists to stop us phoning home, and writing a local file is not phoning home, while a release sweep is driven from exactly there, so a sink that inherited the guard would record nothing and look like it had worked.

`sent: true` from `reticle_feedback` means the record landed in the file, which is the honest reading of "captured" for a recorded run. An unwritable path degrades to a no-op and reports `false`; it never takes the daemon down.

## Adding things: what to do

| You are adding | Do this | Enforced by |
| --- | --- | --- |
| **A tool** | Add it to `TOOLS`. Nothing else. If its name implies a verdict (`assert`/`verify`), also add it to `VERIFICATION_TOOLS` | `telemetry-contract.test.ts` |
| **A verdict-producing tool** | Add it to `VERIFICATION_TOOLS`. Otherwise it emits no `verification_completed` and stops counting toward the product's headline metric | ✓ |
| **A contradiction / anomaly kind** | Add it to core's enum only. `bug-found.ts` derives from it | ✓ |
| **A new finding shape** in a tool result | Teach `bugsInResult` the field. Add a case to the contract test | ✓ |
| **A failure path** (connect, install, crash) | Classify it into an enum with an explicit `OTHER` bucket; a classifier that cannot say "I don't know" lies instead | ✓ |
| **An event kind** | Add to `TelemetryEventKind` + a payload schema + emit it + add a live check to `apps/e2e/specs/telemetry-events-test.mjs` that asserts the **fields**, not just that it arrived | partly; the live check is on you |
| **A field on an EXISTING block** | Add it to that block's schema in core, and nothing else. The `blocks` map flattens every key it finds, so a new field on `connection`/`project`/`outage`/… reaches the wire for free | `extra-blocks-reach-the-wire.test.ts` |
| **A new block on `TelemetryExtra`** | FOUR hand-maintained lists, and missing any one drops the payload in silence (see `outage`): `TelemetryExtra` (`telemetry/telemetry.ts`), the `emit()` event-build spread (same file), the destructure + `blocks` prefix map (same file), and `TelemetryEventSchema` (`core/src/telemetry.ts`). Then add a `SAMPLES` entry in `extra-blocks-reach-the-wire.test.ts` | `extra-blocks-reach-the-wire.test.ts` |
| **A new SCALAR on the envelope** (`installSource`, `automation`, `licenseId`) | THREE: `TelemetryExtra` if a caller sets it, the `emit()` event build, and `TelemetryEventSchema`. **No `blocks` entry** -- there is nothing to flatten, and adding one is a silent no-op | ✗ **not enforced; be careful** |
| **A dispatch path** that bypasses `runTool` | Give it a reporter like `run-telemetry.ts`, or it is invisible | ✗ **not enforced; be careful** |

## Verifying it actually works

Unit tests cannot see the failure mode that matters, because nothing throws. Two things do:

```bash
pnpm test:unit                                  # the contract test + the fingerprint/redaction guards
node apps/e2e/specs/telemetry-events-test.mjs   # fires every event at a real endpoint, checks it lands
```

The second is the one that matters. It drives the real built modules against a real capture server (real network, real process semantics, real redaction) and asserts each event **arrives**. Half its checks are leak checks, asserting that secrets, passwords, customer emails and home directories are _absent_.

**Both halves are mutation-tested.** Reintroducing the fire-and-forget bug fails 9 checks; disabling redaction fails 3. A guard that cannot fail is theatre, so these are periodically proven to bite.

## The privacy line, in one sentence

We measure **that** something happened and **what class** of thing it was, never **what** it was, in whose app, or containing what.
