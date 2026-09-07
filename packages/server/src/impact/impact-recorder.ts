import {
  Verified,
  type ImpactCounts,
  type ImpactDefect,
  type ImpactSnapshot,
} from '@reticlehq/core';
import { estimateTokens } from '../session/output-budget.js';
import { ImpactStore, type ImpactFoldMeta } from './impact-store.js';

/**
 * The daemon's impact recorders — ONE PER PROJECT ROOT.
 *
 * This was a single module-level store, and "the first root wins for the daemon's lifetime" was
 * written down as if it were a design decision. It is only correct for a daemon that serves one
 * project, and this daemon has never been that: `artifactRootFor` exists precisely because one
 * daemon serves many, and nine modules already route their artifacts by the SESSION's project.
 *
 * Measured, not theorised: with a daemon rooted at repo A, two verdicts driven against app B landed
 * in A's `impact.json` — B's own ledger never moved — and A's cloud link then carried them to a
 * PRODUCTION dashboard belonging to a different account than B was linked to. The impact ledger is
 * what the whole dashboard is computed from, so this was the one artifact whose misrouting was
 * guaranteed to be visible and billed.
 *
 * Keyed by root path, so two projects driven through one daemon keep separate ledgers, and the
 * daemon's own root remains the answer for anything that cannot name a project.
 */

/** One store per `.reticle` root. */
const stores = new Map<string, ImpactStore>();
/** The daemon's own root — used when a call cannot say which project it was for. */
let defaultRoot: string | undefined;
/** Held so a per-root store is built with the same clock and project name as the default. */
let storeOpts: { projectName?: string; now?: () => number } = {};

/** Get-or-create the store for one root. */
function storeFor(root: string | undefined): ImpactStore | undefined {
  const key = root ?? defaultRoot;
  if (key === undefined || 0 === key.length) return undefined;
  let found = stores.get(key);
  if (found === undefined) {
    found = new ImpactStore({ ...storeOpts, reticleRoot: key });
    stores.set(key, found);
  }
  return found;
}

/**
 * Wire the DEFAULT root — the daemon's own. Idempotent; the first one wins.
 *
 * Still idempotent, and still first-wins, because the daemon's own root genuinely does not change
 * while it runs. What changed is that this is no longer the ONLY root: a call that knows its
 * project passes one, and this is the fallback for calls that do not.
 */
export function initImpact(opts: {
  reticleRoot: string | undefined;
  projectName?: string;
  now?: () => number;
}): ImpactStore | undefined {
  // No root, no record. Programmatic callers and test doubles build their own deps and are not
  // obliged to carry one, and a courtesy counter must never be the reason a tool call throws.
  if (opts.reticleRoot === undefined || 0 === opts.reticleRoot.length) return storeFor(undefined);
  if (defaultRoot === undefined) {
    defaultRoot = opts.reticleRoot;
    const { projectName, now } = opts;
    storeOpts = {
      ...(projectName === undefined ? {} : { projectName }),
      ...(now === undefined ? {} : { now }),
    };
  }
  return storeFor(opts.reticleRoot);
}

/** The live store for a root (default when omitted), if one has been initialised. */
export function impactStore(root?: string): ImpactStore | undefined {
  return storeFor(root);
}

/** Test seam: drop the stores so a suite can start from a clean record. */
export function resetImpactForTest(): void {
  stores.clear();
  defaultRoot = undefined;
  storeOpts = {};
}

/**
 * Record one delta against a project's ledger. Never throws: stats must not break a tool call.
 *
 * `root` is the `.reticle` directory this call's evidence belongs to. Omitted means "could not tell
 * which project", which falls back to the daemon's own root — the old behaviour, kept for the paths
 * that genuinely have no session to ask.
 */
export function recordImpact(
  delta: Partial<ImpactCounts>,
  meta: ImpactFoldMeta = {},
  root?: string,
): void {
  try {
    storeFor(root)?.record(delta, meta);
  } catch {
    // Counting is a courtesy to the user; failing to count is not worth failing their call over.
  }
}

export function impactSnapshot(root?: string): ImpactSnapshot | undefined {
  return storeFor(root)?.snapshot();
}

/**
 * What one tool call did, as counters.
 *
 * Pure and exported so the shape is testable without a dispatch: given a result and a duration, it
 * says what the record should gain. `verified` is the only field that can mint a verdict, which is
 * the same rule the product states to agents - everything else moves or reads the app.
 */
export function deltaForToolResult(
  raw: unknown,
  durationMs: number,
  refused: boolean,
): Partial<ImpactCounts> {
  const delta: Partial<ImpactCounts> = {
    calls: 1,
    drivingMs: Math.max(0, Math.round(durationMs)),
    tokensReturned: estimateTokens(JSON.stringify(raw) ?? ''),
  };
  if (refused) {
    delta.refusals = 1;
    return delta;
  }
  const verified = isRecord(raw) ? raw['verified'] : undefined;
  if (verified === Verified.YES) {
    delta.verdicts = 1;
    delta.passed = 1;
  } else if (verified === Verified.NO) {
    delta.verdicts = 1;
    delta.failed = 1;
  } else if (verified === Verified.UNKNOWN) {
    delta.verdicts = 1;
    delta.unknown = 1;
  }
  return delta;
}

/**
 * What one FAILED verdict was, in a line.
 *
 * Only a verified:"no" produces one. That is the same rule the counters follow and the same rule
 * the product states to agents: an "unknown" is not a defect, it is Reticle admitting it could not
 * tell — recording those here would fill the user's short list with the tool's own blind spots.
 *
 * Everything is read from the result the tool already returned, so this costs nothing extra and
 * cannot disagree with the verdict it describes.
 */
export function defectForToolResult(raw: unknown, at: number): ImpactDefect | undefined {
  if (!isRecord(raw) || raw['verified'] !== Verified.NO) return undefined;

  const effect = isRecord(raw['effect']) ? raw['effect'] : undefined;
  const verdict = isRecord(raw['verdict']) ? raw['verdict'] : undefined;
  const named = text(effect?.['name']) ?? text(effect?.['testid']) ?? text(effect?.['component']);
  const why = text(verdict?.['failureReason']) ?? text(raw['because']);

  const defect: ImpactDefect = {
    at,
    // The control that was acted on, when the result names one — "Sign In did not sign in" is a
    // sentence somebody can act on; "a verdict failed" is not.
    title: named === undefined ? (why ?? 'a declared consequence did not hold') : named,
  };
  if (named !== undefined && why !== undefined) defect.detail = why;
  const source = text(raw['source']);
  if (source !== undefined) defect.source = source;
  return defect;
}

function text(value: unknown): string | undefined {
  if ('string' !== typeof value) return undefined;
  const trimmed = value.trim();
  return 0 === trimmed.length ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value;
}
