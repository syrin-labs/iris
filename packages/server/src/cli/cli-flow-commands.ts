/**
 * CLI commands that operate on SAVED FLOWS: watch, capsules, and the gate.
 *
 * Split out of cli.ts, which was 653 lines — over the project's own cap, and the file a contributor
 * opens first. These five functions form one cohesive group: they all read the flow store and report on
 * verification state, and none of them touch daemon lifecycle, which is what the rest of cli.ts does.
 */

import { GateExit } from './gate-exit.js';
import { gateHookMessage, GATE_SKIP_ENV } from './gate-hook-message.js';
import { readProjectId } from './cli-port.js';
import { changedFilesSince } from '../flows/git-changed.js';
import { join } from 'node:path';
import { ReticleDir, RunFlowStatus } from '@reticlehq/core';
import { FlowStore } from '../flows/flows.js';
import { RunStore } from '../runs/run-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { affectedSavedFlows, type NamedFlow } from '../flows/flow-sources.js';
import { gateDecision } from '../flows/gate.js';
import { FlakeStore } from '../flows/flake-store.js';
import { formatBuddyStatus } from '../flows/buddy-status.js';
import { CapsuleStore } from '../capsule/capsule-store.js';
import { AssertionTiersStore } from '../flows/assertion-tiers-store.js';
import { detectDowngrades } from '../flows/assertion-integrity.js';
import { computeCoverage, flowCoverageReport } from '../flows/coverage.js';
import { createWatchBatcher } from '../flows/watch-batcher.js';
import { watch } from 'node:fs';
import { log } from '../log.js';
/** Load the {name, steps} of every saved flow for the active project. */
/** Explicit files plus, when --since is given, the git-changed files since that ref. */
export async function resolveChangedFiles(
  files: string[],
  since: string | undefined,
): Promise<string[]> {
  if (since === undefined) return files;
  return [...new Set([...files, ...(await changedFilesSince(since, process.cwd()))])];
}

export async function loadNamedFlows(
  fs: FileSystemPort,
  reticleRoot: string,
): Promise<NamedFlow[]> {
  const projectId = readProjectId(process.cwd());
  const store = new FlowStore(fs, reticleRoot, { now: () => Date.now() });
  const flows: NamedFlow[] = [];
  for (const name of await store.list(projectId)) {
    const loaded = await store.load(name, projectId);
    if (loaded.ok) flows.push({ name: loaded.value.name, steps: loaded.value.steps });
  }
  return flows;
}

/** File-change extensions worth reacting to (skip node_modules churn, dotfiles, build output). */

/**
 * The buddy channel: one ambient line a human can park in a statusline. Deliberately best-effort
 * and silent on failure — a status line that throws is worse than no status line, and it must never
 * interfere with the watch loop it rides on.
 */
async function emitBuddyStatus(
  fs: ReturnType<typeof createNodeFileSystem>,
  reticleRoot: string,
  flows: readonly NamedFlow[],
  affected: readonly string[],
): Promise<void> {
  try {
    const latest = await new RunStore(fs, reticleRoot).latest();
    const passingNames = new Set(
      (latest?.flows ?? [])
        .filter((f) => f.status === RunFlowStatus.PASS || f.status === RunFlowStatus.HEALED)
        .map((f) => f.name),
    );
    const quarantined = await new FlakeStore(fs, reticleRoot).flakyFlows();
    const flaky = new Set(quarantined);
    // A deviation is an at-risk flow with no passing artifact — and a quarantined flake is not a deviation.
    const deviations = affected.filter((n) => !passingNames.has(n) && !flaky.has(n));
    log('reticle_buddy', {
      status: formatBuddyStatus({
        total: flows.length,
        passing: passingNames.size,
        deviations,
        quarantined,
      }),
    });
  } catch {
    // never let the ambient line break the watcher
  }
}

const WATCHED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;
const WATCH_DEBOUNCE_MS = 200;

/**
 * `reticle watch [url]` — on every save, report which saved flows must re-verify (the affected set).
 * Environment-side (costs the agent nothing per turn); the buddy loop. This v1 detects + reports on
 * change; auto-replaying the affected flows against the app is the next increment. Long-running.
 */
export function handleWatch(): void {
  const fs = createNodeFileSystem();
  const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
  const batcher = createWatchBatcher({
    debounceMs: WATCH_DEBOUNCE_MS,
    schedule: (fn, ms) => {
      setTimeout(fn, ms).unref();
    },
    onFlush: (files) => {
      void loadNamedFlows(fs, reticleRoot)
        .then(async (flows) => {
          const result = affectedSavedFlows(flows, files);
          if (result.affected.length > 0) {
            log('reticle_watch_affected', { changed: files, affected: result.affected });
          }
          await emitBuddyStatus(fs, reticleRoot, flows, result.affected);
        })
        .catch((error) => {
          log('reticle_watch_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  });
  log('reticle_watch_started', { cwd: process.cwd() });
  // Print the ambient line once at startup so the human sees where they stand before touching anything.
  void loadNamedFlows(fs, reticleRoot)
    .then((flows) => emitBuddyStatus(fs, reticleRoot, flows, []))
    .catch(() => undefined);
  watch(process.cwd(), { recursive: true }, (_event, filename) => {
    if ('string' === typeof filename && WATCHED_EXTENSIONS.test(filename))
      batcher.onChange(filename);
  });
}

/**
 * `reticle capsules` — list saved fail-to-pass bug capsules (.reticle/capsules). Each is a minimal
 * failing reproduction plus the consequence that should have held; replay one with reticle_flow_replay.
 */
export async function handleCapsules(): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const capsules = await new CapsuleStore(fs, join(process.cwd(), ReticleDir.ROOT)).all();
    log('reticle_capsules', {
      count: capsules.length,
      capsules: capsules.map((c) => ({
        id: c.id,
        ...(c.flow === undefined ? {} : { flow: c.flow }),
        origin: c.origin,
        expected: c.expected,
        observed: c.observed,
        steps: c.steps.length,
      })),
    });
  } catch (error) {
    log('reticle_capsules_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

/**
 * `reticle gate <file...>` — exit non-zero unless passing artifacts cover the flows affected by the
 * changed files. Flaky flows are quarantined (surfaced, not blocking). The environment-side enforcement
 * that makes verification unavoidable. Never throws; a fault fails closed (exit 1).
 */
export async function handleGate(
  files: string[],
  since: string | undefined,
  /** Hook mode: prose for a human, and silence when there was simply nothing to check. */
  hook = false,
): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
    const changed = await resolveChangedFiles(files, since);
    const allFlows = await loadNamedFlows(fs, reticleRoot);
    const affected = affectedSavedFlows(allFlows, changed).affected;
    const latest = await new RunStore(fs, reticleRoot).latest();
    const passing = (latest?.flows ?? [])
      .filter((f) => f.status === RunFlowStatus.PASS || f.status === RunFlowStatus.HEALED)
      .map((f) => f.name);
    const flaky = await new FlakeStore(fs, reticleRoot).flakyFlows();
    // Anti-reward-hacking: diff each flow's CURRENT assertions against what it asserted the last
    // time it passed. A mustHold that dropped from a real consequence to a fakeable presence check is a
    // green bought by weakening the test — and a flow that covered a changed file but no longer exists
    // is coverage deleted rather than satisfied. Both block.
    const baseline = await new AssertionTiersStore(fs, reticleRoot).load();
    const byName = new Map(allFlows.map((f) => [f.name, f]));
    const downgraded = Object.entries(baseline)
      .filter(([name]) => affected.includes(name) && byName.has(name))
      .map(([name, before]) => {
        const current = byName.get(name);
        const after = (current?.steps ?? []).map((s, i) => ({
          step: i,
          ...(s.expect === undefined ? {} : { expect: s.expect }),
        }));
        return { flow: name, steps: detectDowngrades(before.steps, after).map((d) => d.step) };
      })
      .filter((d) => d.steps.length > 0);
    // A flow with a recorded passing baseline that has since vanished, while its files changed.
    // A flow that PASSED covering these files and has since vanished is coverage DELETED, not satisfied —
    // and it can never appear in `affected` (that is derived from flows that still exist), so it must be
    // matched against the baseline's own recorded sources. Missing this made deleting a flow turn the
    // gate green, which is precisely the gaming move exists to stop.
    const changedSet = new Set(changed);
    const deleted = Object.entries(baseline)
      .filter(([name, entry]) => !byName.has(name) && entry.sources.some((f) => changedSet.has(f)))
      .map(([name]) => name);
    const result = gateDecision({ affected, passing, flaky, downgraded, deleted });
    // Verified-surface coverage over flows: how much of the saved suite this run actually exercised.
    const coverage = computeCoverage(
      { testids: [], signals: [], flows: allFlows.map((f) => f.name) },
      { testids: [], signals: [], flows: passing },
    );
    // A gate over an empty suite has not passed — it had nothing to check. Same rule the suite
    // verdict already applies to `reticle verify`; see flowCoverageReport.
    const flowCoverage = flowCoverageReport(coverage.flows);
    const pass = result.pass && flowCoverage.outcome === undefined;
    log('reticle_gate', {
      pass,
      uncovered: result.uncovered,
      quarantined: result.quarantined,
      ...(result.downgraded.length > 0 ? { downgraded: result.downgraded } : {}),
      ...(result.deleted.length > 0 ? { deletedCoverage: result.deleted } : {}),
      coverage: flowCoverage,
    });
    // Two non-zero codes, because two callers want opposite things from the same run. CI wants any
    // problem to fail. A Stop hook wants to block a real regression and NOT block a project that
    // has simply not recorded a flow yet — which is every project on its first day, and measured
    // before this change as an exit 1 that would have blocked every stop. See GateExit.
    if (!pass) {
      const code =
        result.pass && flowCoverage.outcome !== undefined
          ? GateExit.NOTHING_TO_CHECK
          : GateExit.FAIL;
      process.exitCode = code;
      if (hook) {
        // An honest escape hatch, because the alternative to one is not compliance — it is somebody
        // deleting the hook, and a deleted gate protects nothing. Recorded either way.
        if (process.env[GATE_SKIP_ENV] !== undefined) {
          process.stderr.write(
            `Reticle: gate skipped via ${GATE_SKIP_ENV}. This change is unverified.\n`,
          );
          process.exitCode = GateExit.PASS;
          return;
        }
        const message = gateHookMessage(code, {
          uncovered: result.uncovered,
          quarantined: result.quarantined,
          // A downgrade is reported per flow with its step indices; the hook names the flow.
          downgraded: result.downgraded.map((d) => d.flow),
          deleted: result.deleted,
        });
        if (message !== undefined) process.stderr.write(`${message}\n`);
      }
    }
  } catch (error) {
    log('reticle_gate_failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = GateExit.FAIL;
  }
}
