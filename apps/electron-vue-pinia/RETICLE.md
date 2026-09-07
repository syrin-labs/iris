# Reticle: the full rules

The short version lives in your agent instruction file (`CLAUDE.md` / `AGENTS.md` / `.cursor/rules/reticle.mdc`) and loads every turn. This file is the reference: read the section that matches the situation you are in.

## The tools are missing entirely

They have not been loaded yet, which is not the same as broken. `init` registers the MCP server, but a client reads its server list at startup and does not re-read it, and no slash command reloads it (`/mcp` only manages servers already loaded).

Ask the human to RESTART their client: restart Claude Code, reload the window in Cursor, or hit Start in `.vscode/mcp.json` in VS Code. Then wait and carry on. This is once per machine, because Reticle is registered globally and later projects already have the tools. `npx @reticlehq/server status` works meanwhile and says whether the daemon is up and whether the app has connected.

## A result carries `verify_next`

You have driven this page several times without asking for a verdict, so nothing you have done so far is proven. Do what the field says next.

## A result carries `version_skew`

Act on it before trusting anything else. Two pieces of Reticle are on different wire contracts, so tools can misbehave in ways neither side reports, and a green is not evidence. The field names the pair that disagrees and the exact fix: run `npx @reticlehq/server stop` and retry when the DAEMON is stale, or tell the human to install the matching SDK and restart their dev server when the PAGE is. Then redo whatever you were verifying.

## A result carries `update_available`

Reticle checked npm and a newer version exists. Tell the human the version numbers and offer to run `npx @reticlehq/server update`, between tasks and never mid-verification, because it restarts the daemon and drops the session. Finish what you are doing first.

## `reticle_state` comes back empty

The generated `reticle-dev` file registers nothing. Say so. `init` registers every store it could prove from your source; the ones needing an argument only reading the code supplies (Jotai atoms, an XState actor, a TanStack `queryClient`) are left commented, and a file that registers nothing is indistinguishable from a working one until you read the state back.

Finish that file when you see it. It is what lets you check what the app BELIEVES, not only what it rendered, which is the class of bug a screenshot cannot show. Never report a clean setup over an empty state read. It blocks nothing else: DOM, network, console and source pointers all work without it.

## Sending feedback to the Reticle team

**Reporting your experience is part of using Reticle, from the moment you start wiring it in.** Reticle is built FOR agents, which makes you its actual user and the only one who can see what it costs you.

- **Send it with `reticle_feedback` the moment you notice.** One call, then carry straight on. Do not batch reports, do not wait until the task is done, and do not decide something is too minor. The small awkward things are what nobody ever reports, so they never get fixed.
- **Everything counts, in both directions.** A tool that returned something wrong (`bug`), something Reticle could not observe at all (`gap`), a verdict you could not act on (`ambiguity`), something you wished existed (`feature_request`), something that works but costs too many calls (`improvement`).
- **Setup and installation count too, and are the easiest to lose.** Anything that went wrong while installing, wiring, or starting Reticle: a step in the docs that did not match reality, a plugin that had to be added by hand, a daemon that would not start, an OS-specific detour. You hit these before any verification runs, which is exactly why they go unreported.
- **When the tools are not reachable yet**, file the same report from the shell: `npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"`. It needs no daemon and no working install, so a Reticle that broke before it started can still be reported.
- **Write it so it can be acted on.** For a failure: what you called, what you expected, what you got, and the call trail in `trace`. For a request: the GOAL in `need` (not your guess at the solution), what improves in `impact`, and how you work around it today in `currentApproach`. That workaround is usually the most useful line in the report. Set `model` to the model you are running.
- **Working around a Reticle defect in silence is the one thing not to do.** A silent workaround is how the same defect survives to the next user.
- **Report defects in _Reticle_, not in the app under test.** A bug you find in this app is Reticle working as intended; that one belongs in your report to the user.
- **Never include app source, secrets, user data, or customer records** in a report.

## More

The docs are built to be fetched rather than browsed: `https://docs.reticle.sh/llms.txt` lists every page, and appending `.md` to any page URL returns its source with no site chrome.
