/**
 * The environment context stapled to every feedback report. Feedback without it is a complaint;
 * feedback with it is a work item — "reticle_act misses the click" is unactionable, "reticle_act
 * misses the click on Tauri + SvelteKit under a CDP driver" names the bug.
 *
 * Everything here is detected LOCALLY from files and env already on the machine, and every field is
 * low-cardinality by construction (an enum, or a framework name off a fixed list). No paths, no repo
 * names, no dependency inventory, no UA string — the same non-identifying bar the rest of telemetry
 * holds to. Detection is entirely best-effort: an unreadable package.json or an SDK too old to report
 * its runtime yields `undefined`, never a throw and never a guess.
 */
import { mcpClientIdentity, setMcpClientIdentityHook } from '../mcp/client-identity.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  AppRuntime,
  McpScope,
  PageDriver,
  StackUnknownReason,
  type Feedback,
} from '@reticlehq/core';
import { parseMajor } from '../init/detect.js';
import { findWorkspaceApps } from '../init/workspace-apps.js';
import type { InitIo } from '../init/run.js';

/** The context fields — the whole `Feedback` shape minus what the author supplies. */
type FeedbackContext = Pick<
  Feedback,
  'stack' | 'stackMajor' | 'runtime' | 'engine' | 'driver' | 'client' | 'clientVersion' | 'mcpScope'
>;

/**
 * Dependency → reported stack, in resolution order. Meta-frameworks come FIRST: a Next app also
 * depends on react, and reporting `react` for it would collapse the single most important segment
 * we have into the generic bucket.
 *
 * Deliberately NOT reusing `init/detect.ts`. That module answers a different question — "which build
 * integration do I install?" — so its enum stops at next/vite/sveltekit/html. Widening it to carry
 * vue/astro/solid would make `reticle init` branch on frameworks it has no install path for.
 */
const STACK_BY_DEP: readonly (readonly [string, string])[] = [
  ['next', 'next'],
  ['@sveltejs/kit', 'sveltekit'],
  ['nuxt', 'nuxt'],
  ['astro', 'astro'],
  ['@remix-run/react', 'remix'],
  ['@angular/core', 'angular'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['solid-js', 'solid'],
  ['vite', 'vite'],
];

const PACKAGE_JSON = 'package.json';
/** A project-scoped MCP registration lives in one of these; `reticle init` writes user scope instead. */
const PROJECT_MCP_FILES = ['.mcp.json', join('.cursor', 'mcp.json'), join('.vscode', 'mcp.json')];

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** Read only to tell a monorepo root apart from an app we failed to recognise. */
  workspaces?: unknown;
}

/**
 * What one directory's manifest said: a stack, no manifest at all, or a manifest naming nothing known.
 *
 * The three used to be one empty object. That collapsed the two facts that need opposite fixes —
 * "there is no app here" is a discovery problem, "we read this app and did not recognise it" is a
 * one-line addition to STACK_BY_DEP — and it is why the unknown bucket could not be acted on.
 */
type ManifestStack =
  | { kind: 'found'; stack: string; stackMajor?: number }
  | { kind: 'no-manifest' }
  /** `declaresWorkspaces`: this is a monorepo ROOT, so naming nothing is expected, not diagnostic. */
  | { kind: 'unrecognised'; declaresWorkspaces: boolean };

/**
 * The project's framework and its MAJOR version. The major comes from `parseMajor` — the same range
 * parser `reticle init` uses to decide React 19 source mapping — so a range like `^15.0.0-canary.3`
 * narrows the same way in both places instead of via a second, subtly different reader.
 *
 * `no-manifest` covers absent AND unreadable: both mean this directory could not answer, which is
 * the distinction that matters to the caller. Unreadable is not separated because a manifest we
 * cannot parse is not evidence about the app, and a reason nobody can act on is noise in a closed
 * vocabulary.
 */
function stackOfManifest(dir: string, read: (path: string) => string): ManifestStack {
  let pkg: PackageJsonLike;
  try {
    pkg = JSON.parse(read(join(dir, PACKAGE_JSON))) as PackageJsonLike;
  } catch {
    return { kind: 'no-manifest' };
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  for (const [dep, stack] of STACK_BY_DEP) {
    const range = deps[dep];
    if (range === undefined) continue;
    const stackMajor = parseMajor(range);
    return { kind: 'found', stack, ...(stackMajor !== undefined ? { stackMajor } : {}) };
  }
  return { kind: 'unrecognised', declaresWorkspaces: pkg.workspaces !== undefined };
}

export function detectStack(
  cwd: string,
  read: (path: string) => string = readFile,
): {
  stack?: string;
  stackMajor?: number;
  stackSource?: 'cwd' | 'workspace';
  stackUnknownReason?: StackUnknownReason;
} {
  // The cwd wins when it IS an app — never redirect away from the real answer.
  const here = stackOfManifest(cwd, read);
  if ('found' === here.kind) {
    const { stack, stackMajor } = here;
    return { stack, ...(stackMajor !== undefined ? { stackMajor } : {}), stackSource: 'cwd' };
  }

  // Otherwise look for the app. The daemon's cwd is wherever the agent's client happened to launch,
  // which for a real repo is the ROOT while the app sits in `frontend/`, `web/`, or a declared
  // workspace. Reading one directory and giving up is why this returned nothing for every project
  // that actually had Reticle set up: 0 of 77 instrumented projects, and 0 of 166 `size: huge` ones.
  // The bigger the repo, the more certainly we failed.
  //
  // `findWorkspaceApps` is init's discovery, reused rather than reimplemented: it already reads
  // declared workspaces (pnpm-workspace.yaml, package.json `workspaces`) AND scans top-level
  // directories, and it was widened once already for a repo shape a user hit twice. A second
  // detector here would drift from it the first time either changed.
  //
  // Every exit below carries WHY, because an empty result is not a cause. Four different facts used
  // to arrive as one `{}`: no app anywhere, an app we read and did not recognise, workspace apps
  // that were all unrecognised, and discovery erroring. They have different fixes, and the bucket
  // was unusable while they were indistinguishable (#617).
  let sawWorkspaceApp = false;
  try {
    for (const app of findWorkspaceApps(profileIo(cwd))) {
      const found = stackOfManifest(join(cwd, app), read);
      // Reported as `workspace` so the share of projects needing discovery is measurable — that
      // number is what says whether our inference needs an agent to correct it.
      if ('found' === found.kind) {
        const { stack, stackMajor } = found;
        return {
          stack,
          ...(stackMajor !== undefined ? { stackMajor } : {}),
          stackSource: 'workspace',
        };
      }
      // A manifest we READ and did not recognise is evidence about the app; a directory with no
      // manifest is not an app at all and says nothing either way.
      if ('unrecognised' === found.kind) sawWorkspaceApp = true;
    }
  } catch {
    // Discovery touches the filesystem; a permission error must never cost us the profile event.
    // Named rather than folded into "found nothing": an error is not an absence, and a detector
    // that reports one as the other sends the reader looking for a project that was there.
    return { stackUnknownReason: StackUnknownReason.DISCOVERY_FAILED };
  }
  if (sawWorkspaceApp) {
    return { stackUnknownReason: StackUnknownReason.WORKSPACE_APPS_UNRECOGNISED };
  }
  // The cwd's own manifest is the stronger statement when it exists: we read this app and did not
  // know it. Ranked below the workspace answer only because discovery may have found the REAL app.
  if ('unrecognised' === here.kind) {
    // A monorepo root naming no framework is not an unrecognised APP — the app is a directory down
    // and discovery did not surface it. Reporting MANIFEST_UNRECOGNISED here would read as "add
    // this framework to the table" about a manifest that describes no framework at all.
    return {
      stackUnknownReason: here.declaresWorkspaces
        ? StackUnknownReason.WORKSPACE_ROOT_NO_APPS
        : StackUnknownReason.MANIFEST_UNRECOGNISED,
    };
  }
  return { stackUnknownReason: StackUnknownReason.NO_APP_FOUND };
}

/**
 * The three filesystem methods `findWorkspaceApps` needs, rooted at `cwd`.
 *
 * Deliberately not the whole `InitIo`: this path must not be able to write, exec or print. What it
 * cannot do is a stronger guarantee than a rule saying it shouldn't.
 */
function profileIo(cwd: string): Pick<InitIo, 'exists' | 'readFile' | 'listDirs'> {
  const abs = (rel: string): string => (isAbsolute(rel) ? rel : join(cwd, rel));
  return {
    readFile: (rel) => {
      try {
        return readFileSync(abs(rel), 'utf8');
      } catch {
        return null;
      }
    },
    exists: (rel) => existsSync(abs(rel)),
    listDirs: (rel) => {
      try {
        return readdirSync(abs(rel), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && 'node_modules' !== e.name)
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * User scope unless the project checks in its own MCP registration. `reticle init` deliberately
 * registers ONCE at user scope, so `project` here means the team wired it up by hand — which is
 * itself the interesting signal.
 */
export function detectMcpScope(
  cwd: string,
  exists: (path: string) => boolean = fileExists,
): McpScope {
  return PROJECT_MCP_FILES.some((file) => exists(join(cwd, file)))
    ? McpScope.PROJECT
    : McpScope.USER;
}

function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The MCP client on the other end, self-reported in its `initialize` handshake (`claude-code`,
 * `cursor-vscode`, …). Read through a HOOK rather than sniffing env vars: the handshake is the
 * client's own claim about itself, while an env-var table is a guess that silently rots every time a
 * vendor renames a variable. Unset (a CLI run with no MCP peer) simply reports no client.
 */
/** Kept as the telemetry-facing name; the mechanism itself lives in mcp/client-identity.ts. */
export function setMcpClientNameHook(
  hook: () => { name?: string; version?: string } | undefined,
): void {
  setMcpClientIdentityHook(hook);
}

function detectClient(): { client?: string; clientVersion?: string } {
  try {
    const info = mcpClientIdentity();
    return {
      ...(info.name === undefined ? {} : { client: info.name }),
      ...(info.version === undefined ? {} : { clientVersion: info.version }),
    };
  } catch {
    return {};
  }
}

/** What the connected session knows about itself — the shell it runs in and its rendering engine. */
export interface SessionFacts {
  runtime?: string;
  engine?: string;
  /** True when Reticle drives the page over CDP rather than observing the human's own browser. */
  driven?: boolean;
  /** What the APP said it is running, from the SDK's hello. The only session-scoped stack evidence. */
  adapters?: string[];
}

/**
 * Which cwd-derived stacks each SDK adapter is consistent with.
 *
 * The adapter names a UI library; the directory may name a meta-framework built on it. `react` and
 * `next` are the same app described at two levels, so the more specific one is kept. `react` and
 * `sveltekit` are not — that pairing means the daemon's directory is not this session's project.
 */
const ADAPTER_IMPLIES: Readonly<Record<string, readonly string[]>> = {
  react: ['react', 'next', 'remix'],
  svelte: ['svelte', 'sveltekit'],
  vue: ['vue', 'nuxt'],
  solid: ['solid'],
  angular: ['angular'],
};

/**
 * Reconcile what the DIRECTORY says with what the APP says.
 *
 * `detectStack` reads the daemon's cwd, which is not the session's project whenever one daemon
 * serves several apps — the normal case for anyone with two dev servers, and the default in the
 * fixtures. Reported from the field: feedback filed from an astro session arrived stamped
 * `"stack":"sveltekit"`, because that was the directory the daemon happened to be started in. The
 * sessionId was passed and ignored.
 *
 * The rule: keep the directory's answer only while the app agrees with it. An adapter that implies a
 * different family means the directory is describing somebody else's project, so the app's own
 * report wins — less specific, and true, which is the right trade for an attribution field.
 */
export function reconcileStack(
  fromCwd: { stack?: string; stackMajor?: number },
  adapters: readonly string[] | undefined,
): { stack?: string; stackMajor?: number } {
  const claimed = adapters?.find((adapter) => adapter in ADAPTER_IMPLIES);
  if (claimed === undefined) return fromCwd;
  const consistent = ADAPTER_IMPLIES[claimed] ?? [];
  if (fromCwd.stack !== undefined && consistent.includes(fromCwd.stack)) return fromCwd;
  // The major belonged to the directory's framework, so it cannot travel with a different stack.
  return { stack: claimed };
}

function asRuntime(value: string | undefined): AppRuntime | undefined {
  return Object.values(AppRuntime).find((known) => known === value);
}

function asEngine(value: string | undefined): Feedback['engine'] {
  // The SDK already narrows to blink/gecko/webkit before it reports, so anything else is a stale or
  // hand-forged payload — drop it rather than widen the enum at the boundary.
  const known = ['blink', 'gecko', 'webkit'] as const;
  return known.find((engine) => engine === value);
}

/** Assemble the full context. Every field independently optional — a partial context still ships. */
export function feedbackContext(cwd: string, session?: SessionFacts): FeedbackContext {
  const runtime = asRuntime(session?.runtime);
  const engine = asEngine(session?.engine);
  const client = detectClient();
  return {
    // Session-scoped when the app reports something that contradicts the directory — see
    // reconcileStack. A daemon serving two apps otherwise stamps both with whichever one it was
    // started next to.
    ...reconcileStack(detectStack(cwd), session?.adapters),
    ...client,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(session?.driven !== undefined
      ? { driver: session.driven ? PageDriver.CDP : PageDriver.SDK }
      : {}),
    mcpScope: detectMcpScope(cwd),
  };
}
