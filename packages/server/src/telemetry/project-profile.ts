/**
 * What kind of project is this, and how much of Reticle does it actually use?
 *
 * A DAU chart cannot tell apart someone running forty saved flows with visual baselines and a
 * checked-in contract from someone who called `reticle_snapshot` twice and never came back. Both are
 * one active user. Only one of them is retained, and only one of them is a company. `featureDepth`
 * is the number that separates them, and it is the closest thing here to an activation metric.
 *
 * Everything is derived from files already on disk in the project, and everything is reduced before
 * it leaves: sizes become buckets, ages become whole weeks, feature use becomes a fixed vocabulary of
 * family names we define ourselves. No file names, no paths, no flow names, no dependency inventory.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectSize, ReticleDir, type ProjectProfile } from '@reticlehq/core';
import { gitFacts } from './git-facts.js';
import { detectStack } from './feedback-context.js';
import { readProjectId } from '../cli/cli-port.js';

/**
 * The feature FAMILIES, and the on-disk evidence that a project has adopted each. Named rather than
 * counted so the vocabulary stays stable as tools are added, renamed, or merged into action-dispatched
 * families — a count would silently change meaning the next time the tool surface is reorganized.
 */
const FeatureFamily = {
  DETERMINISTIC_REPLAY: 'deterministic_replay',
  VISUAL_BASELINE: 'visual_baseline',
  TEXT_BASELINE: 'text_baseline',
  CAPABILITY_CONTRACT: 'capability_contract',
  RUN_ARTIFACTS: 'run_artifacts',
  BUG_CAPSULES: 'bug_capsules',
  CROSS_RUN_HISTORY: 'cross_run_history',
} as const;
type FeatureFamily = (typeof FeatureFamily)[keyof typeof FeatureFamily];

const ALL_FAMILIES = Object.values(FeatureFamily);

/** Source-file thresholds for each bucket. A bucket answers "toy or real codebase"; a count fingerprints. */
const SIZE_THRESHOLDS: readonly (readonly [number, ProjectSize])[] = [
  [50, ProjectSize.TINY],
  [250, ProjectSize.SMALL],
  [1000, ProjectSize.MEDIUM],
  [5000, ProjectSize.LARGE],
];

const SOURCE_EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/;
/** Never walked: cost, and nothing in them describes the project the team actually wrote. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage']);
/** Bound the walk — a huge monorepo must not turn a telemetry snapshot into a filesystem crawl. */
const MAX_FILES_SCANNED = 6000;
const MAX_WALK_DEPTH = 8;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Count source files, stopping at the cap (the cap itself lands in the largest bucket, correctly). */
function countSourceFiles(root: string, readDir: DirReader = defaultReadDir): number {
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || count >= MAX_FILES_SCANNED) return;
    for (const entry of readDir(dir)) {
      if (count >= MAX_FILES_SCANNED) return;
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name), depth + 1);
        }
      } else if (SOURCE_EXTENSIONS.test(entry.name)) {
        count += 1;
      }
    }
  };
  walk(root, 0);
  return count;
}

export function sizeBucket(sourceFiles: number): ProjectSize {
  for (const [threshold, bucket] of SIZE_THRESHOLDS) {
    if (sourceFiles < threshold) return bucket;
  }
  return ProjectSize.HUGE;
}

/**
 * Project age in whole WEEKS, from the repo's first commit.
 *
 * Weeks rather than a date, deliberately: an exact creation timestamp combined with a framework and a
 * size bucket starts to narrow toward a specific repository, and the question being asked — "is
 * Reticle being adopted on greenfield spikes or on mature codebases?" — does not need that precision.
 *
 * Read from git's own reflog tail rather than by shelling out, for the same reason the origin lookup
 * does: this runs on a startup path and must not cost a subprocess or require a `git` binary.
 */
export function projectAgeWeeks(
  root: string,
  now: number,
  read: FileReader = defaultRead,
): number | undefined {
  for (const path of [join(root, '.git', 'logs', 'HEAD')]) {
    try {
      const first = read(path).split('\n')[0];
      // reflog line: `<old> <new> <name> <email> <unix-ts> <tz>\t<message>`
      const seconds = first?.match(/\s(\d{9,11})\s[+-]\d{4}/)?.[1];
      if (seconds === undefined) continue;
      const ageMs = now - parseInt(seconds, 10) * 1000;
      if (ageMs < 0) continue;
      return Math.floor(ageMs / MS_PER_WEEK);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** True when package.json declares workspaces — monorepos exercise very different code paths. */
export function isMonorepo(root: string, read: FileReader = defaultRead): boolean {
  try {
    const pkg = JSON.parse(read(join(root, 'package.json'))) as { workspaces?: unknown };
    if (pkg.workspaces !== undefined) return true;
  } catch {
    /* no package.json — fall through to the pnpm check */
  }
  try {
    read(join(root, 'pnpm-workspace.yaml'));
    return true;
  } catch {
    return false;
  }
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
}
type DirReader = (dir: string) => DirEntry[];
type FileReader = (path: string) => string;

const defaultReadDir: DirReader = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
};

const defaultRead: FileReader = (path) => readFileSync(path, 'utf8');

/** How many entries a `.reticle` subdirectory holds, matching an optional extension. 0 when absent. */
function countIn(reticleRoot: string, subdir: string, extension?: RegExp): number {
  try {
    const names = readdirSync(join(reticleRoot, subdir));
    return extension === undefined ? names.length : names.filter((n) => extension.test(n)).length;
  } catch {
    return 0;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the full profile. Best-effort throughout: an unreadable project yields a profile of zeroes
 * rather than an exception, because a telemetry snapshot must never be able to fail a daemon start.
 */
/**
 * Facts about the install that the filesystem cannot answer.
 *
 * Passed in rather than read here for the same reason `previouslyConnected` is passed to the MCP
 * server: it needs the daemon's port and the state home, and a profile that reached for those would
 * stop being a pure function of a directory.
 */
export interface InstallFacts {
  /** Has an app for this project EVER connected to Reticle, from durable state. */
  appConnectedBefore: boolean;
}

export function profileProject(cwd: string, now: number, install?: InstallFacts): ProjectProfile {
  const reticleRoot = join(cwd, ReticleDir.ROOT);
  const flowCount = countIn(reticleRoot, ReticleDir.FLOWS_SUBDIR, /\.json$/);
  const baselineCount = countIn(reticleRoot, ReticleDir.BASELINES_SUBDIR);
  // `.diff.png` files are diff OUTPUT, not baselines — counting them would double every visual user.
  const visualBaselineCount = countIn(reticleRoot, ReticleDir.VISUAL_SUBDIR, /(?<!\.diff)\.png$/);
  const runCount = countIn(reticleRoot, ReticleDir.RUNS_SUBDIR, /\.json$/);
  const capsuleCount = countIn(reticleRoot, ReticleDir.CAPSULES_SUBDIR, /\.json$/);
  const hasContract = exists(join(reticleRoot, ReticleDir.CONTRACT_FILE));
  const hasHistory = exists(join(reticleRoot, ReticleDir.PROJECT_FILE));

  const featuresUsed: string[] = [];
  if (flowCount > 0) featuresUsed.push(FeatureFamily.DETERMINISTIC_REPLAY);
  if (visualBaselineCount > 0) featuresUsed.push(FeatureFamily.VISUAL_BASELINE);
  if (baselineCount > 0) featuresUsed.push(FeatureFamily.TEXT_BASELINE);
  if (hasContract) featuresUsed.push(FeatureFamily.CAPABILITY_CONTRACT);
  if (runCount > 0) featuresUsed.push(FeatureFamily.RUN_ARTIFACTS);
  if (capsuleCount > 0) featuresUsed.push(FeatureFamily.BUG_CAPSULES);
  if (hasHistory) featuresUsed.push(FeatureFamily.CROSS_RUN_HISTORY);

  const { stack, stackMajor, stackSource, stackUnknownReason } = detectStack(cwd);
  const ageWeeks = projectAgeWeeks(cwd, now);
  const git = gitFacts(cwd);
  return {
    git: git.state,
    ...(git.forge !== undefined ? { forge: git.forge } : {}),
    ...(stack !== undefined ? { stack } : {}),
    ...(stackSource !== undefined ? { stackSource } : {}),
    ...(stackMajor !== undefined ? { stackMajor } : {}),
    // Present only when `stack` is absent, so the field's presence marks the unknown bucket.
    ...(stackUnknownReason !== undefined ? { stackUnknownReason } : {}),
    size: sizeBucket(countSourceFiles(cwd)),
    monorepo: isMonorepo(cwd),
    ...(ageWeeks !== undefined ? { ageWeeks } : {}),
    flowCount,
    baselineCount,
    visualBaselineCount,
    runCount,
    hasContract,
    capsuleCount,
    featuresUsed,
    // Rounded to 2dp: the exact ratio is a function of the counts above, and an unrounded float would
    // just be a higher-cardinality restatement of them.
    featureDepth: Math.round((featuresUsed.length / ALL_FAMILIES.length) * 100) / 100,
    // WHERE the install stopped, for the daemons that never see an app. `daemon_started` minus
    // `app_instrumented` says one happened and cannot say why; these two bits split that silence
    // into "never ran init", "ran it and no page has ever reached us", and "works, just not up
    // right now". See the fields on ProjectProfileSchema.
    initialized: readProjectId(cwd) !== undefined,
    ...(install === undefined ? {} : { appConnectedBefore: install.appConnectedBefore }),
  };
}
