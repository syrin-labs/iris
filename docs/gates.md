---
title: Gates
description: 'I changed some files. Which command do I run before I push?'
icon: shield-check
---

If you changed anything at all, run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` (about two minutes). If you also touched the tool surface, install, desktop or Rust, section 1 below names the one extra command your change needs. CI runs everything regardless, so routing costs you a slower red, never a missed one.

> **One question this file answers:** _I changed some files. Which command do I run?_
>
> The _why_ behind the gate design (tiers, the merge-gate/release-gate split, what is still unbuilt) lives in [`gate-plan.md`](./gate-plan.md). This file is the routing table.

---

## 0. Last verified

Every gate below was executed end to end against `main` on **2026-08-12** (macOS, M-series, `v2.6.0`). A green row means somebody watched it go green, not that it is supposed to be green.

| Gate | Result | Wall clock |
| --- | --- | --- |
| `pnpm build` | ✅ | ~40s |
| `pnpm lint` (+ both guard self-tests) | ✅ | ~15s |
| `pnpm typecheck` | ✅ | ~10s |
| `pnpm test:unit` | ✅ 5,725 tests / 613 files across 8 packages | ~45s |
| `pnpm format:check` | ✅ | ~10s |
| `pnpm test:integration` | ✅ 12/12 | 17s |
| `pnpm test:e2e` | ✅ 33/33 specs + soak 60/60 answered | **490s** |
| `pnpm test:e2e:desktop` | ✅ 2/2 (Electron 20, Tauri 17) | 58s |
| `node apps/e2e/soak.mjs --self-check` | ✅ | `<1s` |
| `node apps/e2e/matrix.mjs --self-check` | ✅ | `<1s` |
| `pnpm matrix:compat --only cursor` | ✅ 4/4 | ~10s |
| `pnpm bench` | ✅ 10/10 (**was failing before this sweep**, see below) | 279s |

**`pnpm bench` was broken and nobody knew.** `suite-rre.mjs` recorded four flows that asserted no observable consequence and then demanded a `pass` verdict from whole-suite replay, which correctly grades an assertion-free suite `unverifiable`. The product got more honest about false greens; the benchmark measuring it did not follow, so the whole run aborted at script 9 of 10 and `replay-determinism` never ran at all. Each flow now carries a success oracle. This is the failure mode `bench/` is most exposed to: **nothing in CI runs it**, so it can only rot silently.

`pnpm gate:install` (~15 min) and the Windows / Rust jobs were **not** run in this sweep; they are CI-only or network-bound. They are green on `main` per the last CI run, which is a weaker claim than every row above, and is stated that way on purpose.

---

## 1. The routing table

Find the row that matches what you changed. Run its commands. That is the whole rule.

| You changed | Run | Cost |
| --- | --- | --- |
| **Anything at all** | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` | ~2 min |
| The tool surface, the wire contract (`packages/core`), or an observer | ↑ **and** `pnpm test:e2e` | +~8 min |
| `reticle init`, `@reticlehq/vite-plugin`, `@reticlehq/next`, `@reticlehq/babel-plugin`, anything a user runs before their first session | ↑ **and** `pnpm gate:install` | +~15 min |
| `@reticlehq/electron`, `packages/tauri`, the IPC observer, desktop capture | ↑ **and** `pnpm test:e2e:desktop` | +~3 min |
| Telemetry, feedback, or anything that emits an event | ↑ **and** read [`telemetry-contract.md`](./telemetry-contract.md) first. `pnpm test:e2e` covers it (`telemetry-events-test`) | n/a |
| `packages/tauri` (Rust) | ↑ **and** `cd packages/tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings` | +~2 min |
| Docs, README, comments only | `pnpm format:check` | seconds |

**Why routing exists.** The full set is roughly 35 minutes. A gate people resent is a gate people route around, so only the tier that can see your change is worth your time. CI runs everything regardless, so routing costs you a slower red, never a missed one.

---

## 2. Every gate, and what each one can actually see

Each gate exists because the ones above it are blind to something. That blindness is the column that matters.

| Gate | Command | Proves | Blind to | CI job |
| --- | --- | --- | --- | --- |
| **Build** | `pnpm build` | every package compiles and emits | anything at runtime | `verify` |
| **Lint** | `pnpm lint` | style rules, plus the dependency-boundary and lossy-transform guards | anything not expressible as a rule | `verify` |
| **Typecheck** | `pnpm typecheck` | types agree across package boundaries | runtime behaviour | `verify` |
| **Unit** | `pnpm test:unit` | 4,315 tests, per-package, no browser | anything crossing a package boundary at runtime | `verify` |
| **Format** | `pnpm format:check` | Prettier | n/a | `verify` |
| **Integration** | `pnpm test:integration` | real headless Chromium: browser pool, crash isolation, framework adapters, `withReticle` | the MCP surface, the daemon | `e2e` |
| **Web e2e battery** | `pnpm test:e2e` | 32 specs against 3 booted servers and a real browser (the tool surface, the daemon lifecycle, transport faults, telemetry, trace shape), plus the soak | desktop runtimes; the install | `e2e` |
| **Desktop battery** | `pnpm test:e2e:desktop` | a real Electron main process and a **packaged** Tauri binary, driven headless | web-only paths | `desktop-e2e` |
| **Install gate** | `pnpm gate:install` | scaffolds 3 pristine apps, publishes this checkout to a local Verdaccio, lets `init` install itself, boots each app in a real browser, polls for a session that advertised capabilities | install _complexity_; see [`fixtures.md`](./fixtures.md) | `install-gate` |
| **Matrix records** | `pnpm matrix:validate` | every submitted client-compat record is well-formed | whether the client actually works | `matrix-records` |
| **Windows** | (CI only) | that the code runs at all on the majority platform | e2e; Windows is unit-only | `windows` |
| **Rust** | `cargo fmt/clippy/check` | `packages/tauri` compiles and lints on Linux, macOS, and cross-checks Windows | everything JS | `rust`, `rust-macos` |

**The single required status check is `gate`.** It passes when every job above either succeeded or was deliberately skipped by path routing, and fails on anything else. Adding a job to `ci.yml` is half the work; adding it to `gate`'s `needs:` list is the other half. A job missing from that list runs, reports, and is structurally incapable of blocking a merge.

### Guards that self-test

Four checks prove they can still fail before they are trusted. A guard that has never refused anything is not a guard, so each has a negative control that CI runs **first**:

```bash
node scripts/check-boundaries.mjs --self-test        # catches a synthetic bad dependency graph
node scripts/check-lossy-transforms.mjs --self-test  # catches an unclassified lossy export
node apps/e2e/soak.mjs --self-check                  # the soak gate still reddens on an unanswered call
node apps/e2e/matrix.mjs --self-check                # the validator still refuses a malformed record
pnpm gate:install:self-test                          # mis-wires every scaffold; the gate MUST go red
```

---

## 3. Gates that are not automatic

These are real and they work; they are not on the PR path, so they only run when somebody runs them.

| Command | What it is | When |
| --- | --- | --- |
| `pnpm gate:soak:record` | the half-hour release soak (20 rounds, 2s idle), re-records `bench/soak-history.jsonl` and `bench/TOOL-PROFILE.md` | before a release |
| `pnpm matrix:compat` | drives each MCP client's config exactly the way that client would; writes a machine record for `docs/matrix/` | before a release, per client |
| `pnpm knip` | unused files, exports, and dependencies | when the repo feels heavy |
| `node scripts/verify.mjs` in the sibling **`reticle-fixtures`** repo | installs this commit into nine real third-party apps (install _complexity_, not regressions) | see [`fixtures.md`](./fixtures.md) |

---

## 4. `bench/` is not a gate

`bench/` is **measurement and research**, not a merge check. Nothing there blocks a PR, nothing runs in CI, and it is allowed to bit-rot in a way a gate is not. Read [`bench/README.md`](../bench/README.md) before touching it: it says which scripts are live and which are one-off studies kept as evidence for a published claim.

The one exception worth knowing: `pnpm bench` + `pnpm bench:gate` is a working regression gate for the replay numbers, and it is run by hand before a release.

---

## 5. When a gate fails and you think it is the gate's fault

Sometimes it is. The specific failures worth recognising:

- **`EADDRINUSE` / "died during boot".** A previous run left something on `:8787`, `:4310`, or `:3100`. `run-ci.sh` frees these on exit; if it was killed, free them by hand.
- **Killing port 4400 with `lsof -ti tcp:4400 | xargs kill -9`.** This SIGKILLs the `reticle mcp` proxy too, because the proxy holds a _client_ socket on the bridge port. Always add `-sTCP:LISTEN`. This is the root cause of most "the MCP went down" reports.
- **A timing assertion.** If a test asserts `Date.now() - t < N`, that is a bug in the test, not a flake to re-run. Assert the bound (output size, a truncation flag), or use a generous per-test timeout. See [`harness-rules.md`](../apps/e2e/harness-rules.md).
- **An `INCONCLUSIVE` verdict.** The harness is telling you the transport did not stay up, so it is claiming nothing about the product. That is the harness working, not the product failing.

The four rules every tier obeys, and the incident behind each, are in [`apps/e2e/harness-rules.md`](../apps/e2e/harness-rules.md).
