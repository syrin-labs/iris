# CLAUDE.md — Reticle

> Master rules for this codebase. Read this first — the non-negotiables, layout, and conventions.

## What Reticle is

Reticle is the **proof layer for AI agents** — it verifies a running web app from the inside, without screenshots. The app embeds a dev-only SDK that instruments the DOM, network, routing, console, animations, and framework state; a local bridge + MCP server exposes that as structured tools the agent uses to **look, act, observe, and assert**. See `plan/` for the full design (gitignored).

## Monorepo layout

```
packages/core          @reticlehq/core         — bottom-of-graph foundation: wire contract, constants, zod schemas (deps: zod)
packages/browser       @reticlehq/browser      — instrumentation SDK embedded in the app (DOM-side)
packages/server        @reticlehq/server       — bridge + MCP server, the `reticle` CLI (Node-side)
packages/react         @reticlehq/react        — React adapter: DOM ref -> component -> source file
packages/vite-plugin   @reticlehq/vite-plugin  — Vite integration: stamps source + auto-injects connect()
packages/babel-plugin  @reticlehq/babel-plugin — stamps data-reticle-source (source mapping, React 19)
packages/next          @reticlehq/next         — Next.js source mapping (keeps SWC) via withReticle (CJS)
packages/electron      @reticlehq/electron     — Electron main-process adapter (IPC observer, capture)
packages/tauri         reticle-tauri           — Tauri capture backend (RUST — outside every JS gate)
packages/test          @reticlehq/test         — spec runner + matchers for CI (peer vitest)
packages/eslint-plugin @reticlehq/eslint-plugin — dev-only lint rule: state changed ⇒ signal fired
apps/bench-app         @reticlehq/bench-app    — integration proof (Vite + React) AND the primary benchmark target
apps/api               @reticlehq/api          — support infra: backend the web e2e battery drives against
apps/next-smoke        @reticlehq/next-smoke   — integration proof: Next.js 15 App Router, RSC, SWC source mapping
apps/electron-smoke    @reticlehq/electron-smoke — integration proof: real Electron app (Vite + React renderer)
apps/tauri-smoke       @reticlehq/tauri-smoke  — integration proof: real Tauri v2 app (Rust commands via invoke)
apps/e2e                @reticlehq/e2e          — support infra: the web e2e test runner itself
apps/atlas             @reticlehq/atlas        — adversarial fixture: one realistically-sized app, emergent defects
apps/large-dom-bench   @reticlehq/large-dom-bench — benchmark target: non-virtualized grid, vanilla (non-React) TS
apps/vibe-builder-demo @reticlehq/vibe-builder-demo — product demo: AI app-builder with Reticle as the QA layer
apps/examples          —                       — integration proof for frameworks with no smoke app (Remix, Astro)
docs/                  — user-facing docs (getting-started, usage, token-efficiency, local-registry)
SKILL.md               — PUBLIC skill for users integrating Reticle into their own project (the canonical paste-URL)
plan/                  — research/design docs only, no code (ALWAYS gitignored)
```

This is **one git repo** at the root (pnpm + turbo monorepo). The TS library packages are strict TypeScript; `@reticlehq/babel-plugin`/`@reticlehq/next` are plain CJS tooling, `packages/tauri` is Rust and invisible to every JS gate, and everything under `apps/` is a local fixture — all excluded from the build/lint/test gates. See [`apps/README.md`](apps/README.md) for what belongs under `apps/` and why.

## Service boundaries (who owns what)

- **`@reticlehq/core` is the contract.** Any message that crosses browser ↔ bridge ↔ agent is defined there as a constant + zod schema. It sits at the bottom of the graph (deps: `zod` only); everything depends on it, it depends on nothing. Never inline a wire string in `browser` or `server` — add it to `core`.
- **`@reticlehq/browser` only touches the DOM/page.** It never imports Node APIs.
- **`@reticlehq/server` only runs in Node.** It never imports DOM APIs.
- **`@reticlehq/react` is optional enrichment.** Core must work without it.

## Non-negotiable rules

1. **Equality:** `===`/`!==` always. `eqeqeq` is an error.
2. **No `any`.** Use `unknown` + zod narrowing at boundaries. `no-explicit-any` is an error.
3. **No free strings.** Every domain/wire/UI string is a named constant.
4. **No non-null `!`.** Use optional chaining + explicit null checks.
5. **Tests first.** RED → GREEN → REFACTOR.
6. **1000-line file cap.** Over it = a cohesion failure; split before adding. (Raised from 600: the old cap was forcing splits of genuinely cohesive units — a stateful class, a package's public-API barrel + bootstrap — and turning a two-line fix into a refactor. Cohesion is still the actual rule; the number is only the backstop.)
7. **Inject the clock.** Never call `Date.now()`/`Math.random()` inside pure logic — pass them in.
8. **Scope every data access to the authenticated principal.**
9. **Design tokens are the only place design values live.**
10. **Telemetry is part of the feature, not a follow-up.** Adding a tool? Put it in `TOOLS` and, if it produces a verdict, in `VERIFICATION_TOOLS`. Adding a finding kind? Add it to core's enum and never re-list it locally. Adding a dispatch path that bypasses `runTool`? It is invisible until you give it a reporter. Telemetry fails SILENTLY — nothing throws, no test reddens, the data is just permanently gone — so the rules are enforced by `telemetry-contract.test.ts` and written down in [`docs/telemetry-contract.md`](docs/telemetry-contract.md). Read that before touching anything that emits.
11. **No internal tracking tags.** Comments, file names, directory names, and test descriptions must never contain design-doc reference codes (letter + digit patterns like `N5`, `G4`, `M8`, `P2`, `F1`, `R1`) or internal version strings (like `0.3.7`).

## Naming conventions

| Thing | Convention | Example |
| --- | --- | --- |
| Package | `@reticlehq/<kebab>` | `@reticlehq/browser` |
| File | kebab-case | `ring-buffer.ts` |
| Type / class | PascalCase | `RingBuffer`, `ReticleEvent` |
| Variable / function | camelCase | `pushEvent` |
| Constant object | PascalCase + `as const` | `EventType`, `ActionType` |
| React component file | PascalCase or `create-` prefix for creation flows | `App.tsx`, `create-session-view.tsx` |
| `useX` function | ONLY if it calls React hooks | else use `apply/build/get/handle` |

## Pre/post-coding checklist

> The routing below is also a table in [`docs/gates.md`](docs/gates.md) — that file is the one a human contributor reads, and it carries the "what is each gate blind to" column. If you change a gate's cost or scope, change it in both; they are the same rule stated twice on purpose, because one of the two audiences never opens the other file.

**Before coding:** scan for existing code to reuse → identify the constants you'll need and add them first → write the failing test. **After coding:** refactor with tests green → check the file is still cohesive (and under the 1000-line backstop) → run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` **before committing, not chained after it** → confirm no `any`, no free strings, no `console.log`.

`format:check` is first because it is the one CI enforces that **`pnpm lint` does not run**. This checklist omitted it until 2.6.0, which is exactly how a release branch with all four heavy gates green locally still turned CI's `verify` red on six prettier warnings — and `verify` is a dependency of `e2e`, `desktop-e2e` and `install-gate`, so one unformatted file skips every expensive gate behind it. `pnpm format` writes the fixes.

**Touching the tool surface, the wire contract, or an observer?** Also run `pnpm test:e2e` (boots api + bench-app + next-smoke — **~8 min**, measured 2026-08-11 at 32/32 specs on an M-series mac; it was documented as "~20 min" for months and then as "~70s", and both numbers stopped anybody from planning around the real one). The unit gate cannot see cross-package drift: a tool rename once left four e2e specs dead across a whole framework and nothing caught it, because the battery is not part of `test:unit`. `e2e-surface-drift.test.ts` now catches the name-lookup half of that in the fast gate; the rest still needs the battery.

**Touching telemetry, feedback, or anything that emits an event?** Read [`docs/telemetry-contract.md`](docs/telemetry-contract.md) first — short, and the difference between a metric that works and one that is silently absent for six months. `pnpm test:e2e` runs `telemetry-events-test`, which fires all ten event kinds against a real capture endpoint and asserts each one lands. It exists because telemetry fails SILENTLY: `daemon_stopped` was emitted fire-and-forget just before `process.exit(0)`, so the POST died every time and nothing threw, nothing failed, and no unit test could see it. Half the spec is leak checks — a telemetry mistake is silent, shipped, and about somebody else's data.

**Touching desktop — `@reticlehq/electron`, `packages/tauri`, the IPC observer, or desktop capture?** Also run `pnpm test:e2e:desktop`. It starts a real Electron main process and a **packaged** Tauri binary and drives them headless (~3 min, most of it the Rust build). The web battery boots three HTTP servers and no desktop runtime, so it is blind to all of this — which is how v2.3.0 shipped Electron and Tauri support with no automated coverage at all, and why a `no-visual-provider` lie on concurrent captures lived in code that no gate touched. `packages/tauri` is Rust and outside every JS gate; CI's `rust` / `rust-macos` jobs are the only thing that compiles it.

**Touching `reticle init`, `@reticlehq/vite-plugin`, `@reticlehq/next`, or anything a user runs before their first session?** Run **`pnpm gate:install`** (~15 min). Nothing else in this repo can see the install: every app in `apps/` is already instrumented, so re-running `init` over one reports "already wired" for every step and proves nothing — which is exactly how v2.3.0 shipped a Next.js install that connected **0% of the time** through three independent defects, none of which any check short of opening a browser could see.

The gate scaffolds three pristine apps (`npm create vite`, `create-next-app`, `create-next-app --no-app` — the three genuinely different `init` paths), publishes this checkout to a local Verdaccio so `init` does its own dependency install, boots each one, opens it in a real browser and polls for a session. It asserts **zero `⚠`** and diffs `init`'s plan against `apps/e2e/install-baseline.json` — because a step silently changing mark, or vanishing from the plan, passes every other check. Changed the plan on purpose? `pnpm gate:install --update-baseline` and commit the diff.

`pnpm gate:install:self-test` is the negative control and runs FIRST in CI: it mis-wires every scaffold and requires the gate to go RED. If it ever passes, the real run's green means nothing.

That covers install **regressions**. It does not cover install **complexity** — a 70-dependency app with ten Vite plugins is a different question, and that still lives in the sibling **`reticle-fixtures`** repo (`node scripts/verify.mjs`), which installs into pristine upstream apps on a `clean` branch. Read [`docs/fixtures.md`](docs/fixtures.md).

**Accuracy outranks tokens, and the trade is not hypothetical.** A cheaper surface bought its saving with a lie: run as an arm of the fix-and-verify benchmark, the `lean` profile fixed 3/5 where the full surface fixed 5/5, and produced the first FALSE GREEN this repo has ever measured — six turns, 62k tokens, the cheapest cell of the run, ending in a hypothetical walkthrough ("spaces are trimmed, valid part is used. VERDICT: FIXED") against a submit button that was still enabled. It reasoned about its own code instead of driving it. So a token optimisation ships only with a correctness measurement beside it, and a verdict that lies costs more than every token it saved — the verdict IS the product. Cutting turns is different and welcome: the two instruction fixes this release removed 21% of the tokens with identical outcomes, because they changed the ROUTE to the answer, not the evidence behind it.

**Timing assertions are a bug.** Two flaky tests this build both asserted a DURATION when the invariant was a BOUND. If the property is "cost is fixed", assert the bound (output size, truncation flag) or use a generous per-test timeout — never `Date.now() - t < N`, which is a statement about the machine and fails only under parallel load, i.e. only in CI.
