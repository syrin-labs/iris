# Reticle

Reticle embeds a dev-only SDK in the user's running app and exposes it to you as `reticle_*` MCP tools. You look, act, observe, and assert against the real app. No screenshots, and no browser download for the verify loop: it drives the tab the user already has open.

This file is the whole critical path and nothing else. Everything it leaves out is at `https://docs.reticle.sh`, one page at a time.

## Your first action, before you read the rest

Do not spend a turn working out which path you are on. The command knows.

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init --flow "<the journey worth proving>"
```

It is idempotent: on a project that is already wired it reports `·` for what is already there and goes straight to proving the app still works. Run it now, then read **SETUP** below for what to pass it and what to do with what it returns.

Everything between here and there is a rule the steps assume. Read it as you go, not before you act.

## Installed means a verdict was produced

**Setup is not complete until you have driven one real flow in the user's app and produced a verdict.** Writing config files is not installed. Every earlier point looks like success and is not:

- `init` exited 0. Files were written. Nothing connected.
- The `reticle_*` tools appeared. Your client can reach a daemon. The app is very likely still uninstrumented.
- A session is listed. The app dialled in. The user has still seen nothing happen.

**Do not tell the user Reticle is set up until a verdict exists.** The most common failure in the field is an agent that writes the config, reports success, and leaves somebody with an uninstrumented page. The command exits non-zero when that happens: believe the exit code over the report.

## Setup runs to the end without you

**Do not stop, and do not ask the user anything, until their app is running with Reticle inside it and a session is connected.** Everything between here and that point is yours to do: run `init`, fix the wiring it could not, start the dev server, open the browser. Not one of those needs a human, and every one of them has been the place an onboarding turn died with nothing to show.

Questions you must not ask, because the repo you are sitting in already answers them: which framework, which package manager, which port, which editor or MCP client, whether to start the dev server, whether to open the browser, whether to carry on. Decide, act, and say what you did in one line.

There are exactly three places you may stop, and none is a question about a preference:

1. **No recognisable dev script in `package.json`.** Say so; do not invent one.
2. **Your host asks the human to approve a command.** That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer. `init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle's own tools.
3. **Only if no agent CLI exists on the machine at all**, the client restart that loads the MCP tools (step 2). If `claude`, `codex`, `cursor-agent` or `gemini` is installed, you do NOT stop. Step 2 shows you how to drive from a child process instead, and that path is measured to be the difference between a verdict and a dead end.

If you do have to stop, the restart ends your turn. This file was fetched into the context that just ended, so nothing carries it across unless you make it. **Before you trigger the restart, write the remaining steps into `RETICLE-SETUP.md` at the repo root**, one line each, with the step you stopped at marked. That file is what you re-read afterwards. Delete it once step 5 has produced a verdict.

Better still, install the on-disk copy first. It survives the restart on its own, and it is the same content:

```bash
npx skills add reticlehq/reticle --skill install-and-verify -y
```

**After the restart, resume at the step you were on.** Do not start over, and do not skip forward.

## Feedback is first-class

Reticle is built for agents. You are its user, and your experience is the only signal that decides what gets built or fixed. It disappears when your context does.

The moment Reticle breaks, lies, cannot see something you needed, costs too many calls, or gives you trouble during setup:

```
reticle_feedback { kind, text }
```

`kind` is one of `bug`, `gap`, `ambiguity`, `feature_request`, `improvement`. One call, then carry on with the task. If the tools are unreachable (setup unfinished, daemon down), file the same report from the shell:

```bash
npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"
```

Nothing is too minor. Report defects in **Reticle**; a bug you find in the app under test is Reticle working, and belongs in your answer to the user. Never put app source, secrets, or user data in a report.

## Do not re-read this file to look something up

Fetch the one page that answers the question instead. **Appending `.md` to any docs URL returns its source with no site chrome.**

```bash
curl https://docs.reticle.sh/llms.txt              # every page title and URL; read this first
curl https://docs.reticle.sh/frameworks.md         # per-framework SDK wiring
curl https://docs.reticle.sh/troubleshooting.md    # nothing connected, click did nothing, verdict unknown
curl https://docs.reticle.sh/agent-cheatsheet.md   # the verify loop on one screen
```

Every page arrives with the rules that matter prepended, so a single fetch orients you without a second call.

## Which path am I on

You do not have to decide. `init` is idempotent and reports what is already wired, so running it is the cheapest way to find out, and on an installed project it goes straight to proving the app still works.

Read **VERIFY** below when the question is "does this still work?" rather than "is this set up?". If `reticle_sessions` returns an empty list on a project that is already wired, fetch `https://docs.reticle.sh/troubleshooting.md`; do not restart setup.

---

# SETUP

**One command. It does all of it, and it ends with a verdict.**

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init --flow "<the journey worth proving>"
```

`@latest` is deliberate: `npx` caches, and a stale cached CLI is the most common silent setup failure. Never pin a version here.

That single command detects the framework and package manager, wires the build config, installs the SDK, registers the MCP server, starts the dev server, opens the app, waits for a session to connect from inside it, drives one flow, and saves it so every later check is one call with no model in the loop. It exits non-zero if it did not produce a verdict, and prints exactly what is left to do.

## What YOU decide, and pass in

The command reads the repository. It cannot read the request, and three things live only there. Decide them before you run it; do not walk any of them by hand.

| flag | what only you know |
| --- | --- |
| `--flow "<what>"` | which journey proves the thing the user asked for. Code can list the buttons; it cannot know checkout matters and the theme toggle does not. Naming it took one real app from a ten-minute timeout to 138 seconds, because the turns go into FINDING a flow. |
| `--env KEY=VALUE` | what the app needs to reach a usable state: the key from `.env.example`, the mock backend in the README, the variable that skips an auth wall. Repeatable. Without it a real app sits on a login screen and there is no flow to drive at all. |
| `--app <dir>` | which app in a monorepo. It can list the ones that are servable; only the request says which one is being worked on. |

**Ask the user nothing.** Not the framework, package manager, port, editor or MCP client: every one is answerable from the repo you are sitting in. Read `.env.example`, the README and `package.json`, decide, and say what you decided in one line.

**Never ask about the port.** There are two, and conflating them is a top setup failure. The dev-server port (3000, 5173) belongs to the project's own dev script. The bridge port (**4400**) is the daemon-to-SDK channel and defaults correctly.

## Then read what it gives you back

`⚠` lines and a non-zero exit are a to-do list, not a failed install. The command names the cause and prints the REMAINING steps from wherever it stopped, and it will not tell you to redo a phase that already worked. Do those, and re-run; re-running is safe.

**It is not finished until a verdict exists.** Writing files is not an install, and neither is a connected session. If it exits non-zero, the app is wired and something is still outstanding; say so plainly rather than reporting success.

**If the user gave you a license key**, see [License key](#license-key) below.

---

# If that command could not run it

**Do not choose this path.** It is not the thorough version of the one above; it is what you fall back to when the command physically could not do the work, and taking it by preference is how an install costs 176 turns instead of one. That is a measured figure, not a way of speaking.

Use it only when ONE of these is true, and you can say which:

- `init` exited without ever printing `starting:` or `▸ WATCH`, which means the CLI on this machine predates the runtime phases and stopped after writing files.
- `init` printed a to-do list, you did those things, re-ran it, and it stopped in the same place twice.
- There is no Node 18 or newer on this machine, so nothing can run.

Anything else is not a reason: not a `⚠` in the report, not a step you would rather do yourself, not a feeling that you should check its work. Re-run the command. It is idempotent, it reports what is already wired, and it names what is still outstanding.

When one of those three IS true, the whole manual procedure is one page:

```bash
curl https://docs.reticle.sh/install-manual.md      # register the MCP, wire the SDK, prove it
curl https://docs.reticle.sh/troubleshooting.md     # nothing connected, click did nothing, verdict unknown
```

**Vite + React**, **Next.js**, **Remix** and **Astro** are the frameworks with an app and a CI gate behind them, so their wiring is proven rather than assumed. The SDK is framework-agnostic and usually connects elsewhere, but say that honestly rather than reporting a proven install.

Do not reconstruct it from memory. Three things decide whether it works, and all three get skipped:

1. **The SDK must load in a RUNNING page.** Not wired in a config file: loaded, in a page a browser has open. This is the step the funnel dies on.
2. **A session must appear** on that app's own url. `reticle_sessions` returning an empty list has four causes with four different fixes, and its `next_action` names which one this is.
3. **A verdict must exist.** `reticle_act_and_wait` or `reticle_assert`, and nothing else. A drive that ends without one has no result however many tools it used.

## The dev server, whoever starts it

**A dev server already running when `init` ran does not have Reticle in its bundle.** It read `vite.config.ts` / `next.config.js` at boot; `init` edited that file afterwards. The process keeps serving the old bundle, the page loads without the SDK, no session appears, and every symptom points at the wiring you just correctly did. This is a 100% failure, not an intermittent one, and it is the single largest cause of an install that gets to step 4 and finds an empty list.

So, in this order:

1. **A dev server was already running?** Restart it, then hard-reload the tab. "Something is listening" does not mean the right bundle is served.
2. **Nothing was running?** Start it in the BACKGROUND and say so in one line. `reticle_sessions` gives you this project's own dev command in `next_action`; use that, never compose one. Started after `init`, it needs no restart. **`reticle init` may start it for you, and stops it again if setup fails**: a command somebody ran is attributable and stoppable where a daemon is not.

Stopping here to ask is how a setup turn ends with nothing verified.

The daemon deliberately will not do this for you. A build process started by a long-lived background daemon is invisible to the person whose machine it runs on and orphans when the daemon exits; a dev server YOU start is in the transcript, attributable, and stoppable.

Four guards, none optional:

1. **Never run two at once.** One dev server on the app's port. Restarting a stale one means stopping it first, not starting a second alongside it.
2. **Never guess the command.** It comes from `package.json` scripts. No recognisable dev script means say so and stop, not invent one.
3. **Never kill anything you did not start**, and never a daemon or a port holder. The one exception is the restart above, and say in one line that you did it.
4. **The permission prompt belongs to your host.** Never bypass, suppress or auto-approve it, and take a refusal as the answer. You have no business editing a permissions file yourself. `init` writes one rule, for the `reticle` server alone, and prints that it did.

---

# License key

Enterprise features are unlocked by a signed key, verified locally with Ed25519 and **no network call**. If the user hands you one, during setup or at any later point:

```bash
npx @reticlehq/server@latest init --license <key>
```

That writes `RETICLE_LICENSE_KEY` to the project's `.env` and adds `.env` to `.gitignore` if nothing there covers it. Do not do those two by hand: a key committed to git is a leaked credential, and it stays leaked after the file is removed. Confirm with `npx @reticlehq/server license`, which prints `active`, `eval`, `missing` or `expired`.

Never echo the key back in your reply, and never put it in a commit, a code comment, or a feedback report. The rest: `curl https://docs.reticle.sh/enterprise.md`.

---

# VERIFY

**Only `reticle_act_and_wait` and `reticle_assert` produce a verdict.** Everything else (`act`, `snapshot`, `query`, `navigate`, `observe`, `network`, `console`) moves or reads the app and proves nothing. A drive that ends without one of those two has no result, however many tools it used.

A verdict of `verified: "unknown"` is not a pass. It means Reticle drove the app and could not tell what happened. Report it as unknown. `verified: "no-fault"` is not a pass either. It means the page settled and no channel reported a problem, but nothing was declared to prove, so assert a consequence the action CHANGES. **Never weaken a check to make it pass.**

## Take the cheapest path that answers the question

Work down this list and stop at the first row that fits. Do not hand-drive a flow you could replay, and never pay one call per field.

| The question | The call | Calls |
| --- | --- | --- |
| "Did my edit break anything?" | `reticle_run({ tool: "reticle_verify", args: { action: "change", files: ["src/App.tsx"] } })` | 1 |
| "Does this known journey still work?" | `reticle_run({ tool: "reticle_flow_replay", args: { flowName: "login" } })` | 1 |
| "Does this new behaviour work?" | `reticle_act_sequence` for the setup, then ONE `reticle_act_and_wait` | 2 |
| No MCP available at all | `npx @reticlehq/server verify <url>` in the shell | 1, no MCP |

`reticle_verify` and `reticle_flow_replay` are **not on the advertised tool list**: they are reached through `reticle_run` exactly as written above. That is the supported call shape, not a workaround, and it is why you have to be told they exist at all.

`reticle_verify {action:"change"}` answers `unknown` when no saved flow covers the files you changed. That is the honest answer and not a failure. Nothing ran, so nothing was proved. It is also the signal to record one. Never read it as a pass.

## Two more you have to be told about

Same story as `reticle_verify`: extended surface, so they are not in the tool list you were handed, and reached through `reticle_run`.

**Context compacted, a turn starting, or a sub-agent taking over?** Ask what this run already established, instead of re-snapshotting to rediscover what you already knew:

```
reticle_run({ tool: "reticle_context", args: {} })
```

**About to change something?** Declare what the change is SUPPOSED to make true, in prose, while you still know. A verdict with nothing declared can only be checked against itself:

```
reticle_run({ tool: "reticle_intent", args: { action: "declare", intents: [{ id: "checkin", statement: "clicking Send check-in makes the badge read 'checked in'" }] } })
```

Or say it on the verdict itself and skip the round trip. `reticle_act_and_wait` and `reticle_assert` both take an optional `intent`, writing the same ledger:

```
reticle_act_and_wait({ ref: "e42", action: "click", until: { kind: "signal", name: "checkin:sent" }, intent: "clicking Send check-in makes the badge read 'checked in'" })
```

The verdict that passes is the one that proves it. Already declared it? Pass the intent's **id** there instead of the prose, and several verdicts can answer to one statement.

## Record once, replay cheaply

The first drive of a journey is expensive. The rest should not be. After you drive something worth keeping:

```
reticle_run({ tool: "reticle_record", args: { action: "start", recordingName: "checkout" } })
   ... drive the flow ...
reticle_run({ tool: "reticle_record", args: { action: "stop",  recordingName: "checkout" } })
reticle_run({ tool: "reticle_flow_save", args: { flowName: "checkout" } })
```

From then on that journey re-verifies in one call, deterministically, and `reticle_verify {action:"change"}` can start answering `yes` or `no` for the files it touches instead of `unknown`.

Check `assertions.grade` on the save. Anything other than `asserted` means the flow only acts, so it will pass even if the feature breaks.

## When you do have to drive by hand

Five calls, and the last one is the only one that counts:

```
reticle_sessions()                                   // connected? if empty, read `why` — it names the fix
reticle_run({ tool: "reticle_capabilities", args: { sessionId } })  // the app's whole testable surface, ~1 KB
reticle_snapshot({ sessionId, mode: "interactive" }) // just the controls, with refs
reticle_act_and_wait({ sessionId, ref, action: "click", until: { kind: "allOf", predicates: [
  { kind: "net",     urlContains: "/api/...", status: 200 },
  { kind: "element", query: { testid: "..." } },
  { kind: "console", level: "error", absent: true },
]}})                                                 // ← the verdict
```

Prefer `reticle_act_and_wait({ ref, action, until })`. It names the expected consequence **before** the action, which is the difference between a check and a rationalisation.

A verdict of `verified: "unknown"` is not a pass. It means Reticle drove the app and could not tell what happened. Report it as unknown. `verified: "no-fault"` is not a pass either. It means the page settled and no channel reported a problem, but nothing was declared to prove, so assert a consequence the action CHANGES. **Never weaken a check to make it pass.**

Then report what you drove, what it produced, and the `file:line` for anything broken.

The surface is deliberately small: `default` 18, `all` 30. Editors budget tools across every MCP server you have connected (Cursor allows 40 in total), so the count is capped rather than allowed to grow. `reticle_tools` loads the argument grammar for the rest on demand, and `reticle_run` invokes any of them by name. Nothing is unreachable; the cold tail just costs one discovery hop.

- Batching, regression suites, reading a verdict: `https://docs.reticle.sh/agent-cheatsheet.md`
- Every predicate and action: `https://docs.reticle.sh/predicates.md`, `https://docs.reticle.sh/actions.md`
- The complete tool surface: `https://docs.reticle.sh/usage.md`
