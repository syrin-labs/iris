/**
 * Pure assembly of the `reticle init` action plan. Given the detection result and the relevant file
 * contents, produce an ordered list of steps — each marked apply / manual / already / skip. The
 * runner performs the `write` side-effects; this module decides *what* should happen.
 */

import {
  Framework,
  PackageManager,
  UiLibrary,
  installCommand,
  installCommandParts,
  type Detection,
} from './detect.js';
import type { FoundStore } from './capabilities.js';
import { installFailureHint } from './install-hint.js';
import { claudeAddCommand, mcpManual, mcpWindowsNote } from './mcp.js';
import { NodePlatform } from '../platform.js';
import {
  mergeClientConfig,
  ClientMergeStatus,
  clientSnippet,
  clientSpec,
  McpClient,
} from './mcp-clients.js';
import {
  CLAUDE_COMMAND_PATH,
  CURSOR_COMMAND_PATH,
  SLASH_COMMAND_BODY,
  SLASH_COMMAND_SIGNATURE,
} from './slash-command.js';
import {
  mergeMarkedInstruction,
  reticleMdFile,
  cursorRuleFile,
  AgentRuleStatus,
  CLAUDE_MD_PATH,
  AGENTS_MD_PATH,
  RETICLE_MD_PATH,
  CURSOR_RULE_PATH,
} from './agent-rules.js';
import { cspStep, frameworkSteps } from './plan-framework.js';
import { join } from 'node:path';
import { reticleConfigContent, unverifiedUiLibraryNote } from './snippets.js';
import { configWithInstallSource, declaredInstallSource } from '../telemetry/install-source.js';
import { existingConfigProblem, projectIdOf, RETICLE_CONFIG_FILE } from './existing-config.js';

// Re-exported: it moved to the module that reads it, and every existing importer says `plan.js`.
export { RETICLE_CONFIG_FILE };

// An app dev installs exactly the audience-scoped browser-side dependencies — never the retired
// `@reticlehq/core` umbrella (which dragged the Node MCP server + ws into every app). The kit is the
// framework adapter (it re-exports the browser sensor), paired with that framework's dev-only build
// plugin for source mapping + connect injection.
const RETICLE_REACT_KIT = '@reticlehq/react';
/** The framework-neutral sensor, for stacks the React adapter has nothing to attach to. */
const RETICLE_BROWSER_SDK = '@reticlehq/browser';
const RETICLE_VITE_PLUGIN = '@reticlehq/vite-plugin';
const RETICLE_NEXT_PLUGIN = '@reticlehq/next';

/**
 * Pin the SDK to the CLI's own version.
 *
 * `pnpm add -D @reticlehq/react` installed **2.2.1** in one project while npm and yarn took 2.3.0 in
 * the next — a stale registry metadata cache, invisible to the user and to us. A version-skewed SDK
 * talking to a newer daemon is the `-32000` failure path: the app connects, the protocol disagrees,
 * and nothing on either side names a version. Asking for the CLI's exact version makes the cache
 * irrelevant, and a skewed pair impossible to install by accident.
 */
function pinnedPackages(
  packages: readonly string[],
  version: string | undefined,
): readonly string[] {
  if (version === undefined || 0 === version.length) return packages;
  return packages.map((p) => `${p}@${version}`);
}

/**
 * Does this codebase want the React kit, or the framework-neutral sensor?
 *
 * The kit is what adds component identity — component names and stacks — and it is worth having
 * wherever React or Preact is rendering (the adapter reaches Preact through `preact/compat`).
 * Everywhere else it is a package named `@reticlehq/react`, carrying `react` in its peer
 * dependencies, being installed into a codebase that has no React in it.
 *
 * UNKNOWN keeps the kit deliberately. Absence of evidence is not evidence of Vue, and guessing
 * "sensor" on no information silently drops component identity from apps that should have it.
 */
function wantsReactKit(ui: UiLibrary): boolean {
  return ui !== UiLibrary.VUE && ui !== UiLibrary.SVELTE;
}

/**
 * The dev-dependencies `reticle init` installs — kit (or sensor) first, build plugin next.
 *
 * `uiLibrary` matters because the framework does not always name the renderer. The rule below was
 * already written for Nuxt, correctly, and applied only there: a Vue app on plain Vite is
 * `Framework.VITE` and a SvelteKit app renders Svelte, and both were being handed the React kit
 * right after `init` had detected the real UI library and said so on screen.
 */
export function frameworkPackages(
  framework: Framework,
  uiLibrary: UiLibrary = UiLibrary.UNKNOWN,
): readonly string[] {
  const kit = wantsReactKit(uiLibrary) ? RETICLE_REACT_KIT : RETICLE_BROWSER_SDK;
  switch (framework) {
    case Framework.NEXT:
      // Next is React by construction, so the detection cannot disagree in a way worth honouring.
      return [RETICLE_REACT_KIT, RETICLE_NEXT_PLUGIN];
    // React Router framework mode is a Vite app that renders React, so the kit and the plugin are
    // both right for it too — only the connect INJECTION differs, and that is the plan's business.
    case Framework.VITE:
    case Framework.REACT_ROUTER:
    case Framework.SVELTEKIT:
      // SvelteKit builds on Vite; until a dedicated Svelte kit exists it uses the Vite build plugin.
      // The build plugin stamps `data-reticle-source` regardless of UI library, so a Vue or Svelte
      // app still gets source pointers — it is only component identity that needs the React kit.
      return [kit, RETICLE_VITE_PLUGIN];
    case Framework.NUXT:
      // The framework-neutral sensor, NOT the React kit. Nuxt renders Vue, and installing a package
      // named @reticlehq/react — with `react` in its peer dependencies — into a Vue codebase is the
      // single thing most likely to make someone abandon the setup, whether or not it works.
      return [RETICLE_BROWSER_SDK];
    case Framework.ASTRO:
      // Astro owns its own Vite instance and renders its own HTML, so there is no config for the
      // plugin to attach to — the kit alone, connected from a page <script> (see astroManual).
      return [kit];
    case Framework.CRA:
      // react-scripts owns its webpack config and cannot be extended without ejecting, so there is
      // no build plugin — the kit alone, imported from src/index.tsx (see cra.ts).
      return [RETICLE_REACT_KIT];
    case Framework.HTML:
      // No bundler plugin to install — just the kit; connect is wired by hand (see htmlManual).
      return [kit];
  }
}

/** Exported so the init telemetry can tell an MCP-registration failure from a dependency install. */
export const MCP_TARGET = 'global (claude user scope)';

/** The step that runs the package manager — the other thing that commonly fails on a user's machine. */
export const DEPS_TARGET = 'package.json';

export const StepStatus = {
  APPLY: 'apply',
  MANUAL: 'manual',
  ALREADY: 'already',
  SKIP: 'skip',
  /**
   * Something the user should KNOW, not something they must DO. The UNVERIFIED lines are the case:
   * a Preact or SvelteKit app is wired and working, it just isn't covered by a gate. Reporting those
   * as `manual` made "steps left to do" a number that could never reach zero, and made a release gate
   * read two regressions that were not regressions.
   */
  NOTICE: 'notice',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface Step {
  title: string;
  target: string;
  status: StepStatus;
  detail: string;
  /** Present only when status is APPLY and a file must be written. */
  write?: { path: string; content: string };
  /** Present only when status is APPLY and a subprocess must run (the dependency install). */
  exec?: { command: string; args: string[]; fallback: string };
  /**
   * A second, weaker attempt to run when `exec` fails, with what to tell the user if it succeeds.
   *
   * The pinned install is refused outright by pnpm's `minimumReleaseAge` for as long as its window
   * lasts — so for ~48 hours after every release, a project with that setting could not install
   * Reticle at all. An unpinned install still works there (it resolves the newest MATURE version), so
   * the fallback trades an exact version for a working install and says which it did. It must never
   * be silent: an older SDK against a newer daemon is the skew this pin exists to prevent.
   */
  retry?: { command: string; args: string[]; note: string };
  /**
   * This step wires the app to a package the install step provides. If that install fails, applying
   * it anyway leaves the app importing a module that is not there — `next.config.ts` importing
   * `@reticlehq/next` took a dev server down exactly this way. Installing Reticle must never be the
   * reason an app stops booting.
   */
  dependsOnInstall?: boolean;
}

export interface Plan {
  framework: Framework;
  /**
   * The renderer this app actually uses, carried so every consumer agrees on WHICH packages the
   * plan installed. The retry guard checks node_modules for exactly those names; without this it
   * looked for `@reticlehq/react` in a Vue app that had correctly been given the sensor, decided the
   * install had failed, and skipped every wiring step on the retry.
   */
  uiLibrary: UiLibrary;
  steps: Step[];
}

export interface PlanInput {
  detection: Detection;
  /**
   * Write `captureNetworkBodies: true` into the app's config. Off unless the caller asked (#705).
   *
   * Optional so every existing caller and test keeps the safe default without naming it — the one
   * direction a default about somebody else's data should be wrong in.
   */
  captureBodies?: boolean | undefined;
  /**
   * The CSP-bearing files this project actually has, keyed by path — read once in `gatherPlanInput`.
   *
   * Pre-read rather than given a reader, because `PlanInput` is the pure input to a pure planner and
   * handing it an io would let any later step reach the disk from inside `buildPlan`.
   */
  cspSources?: Readonly<Record<string, string | undefined>> | undefined;
  /** Whether the `claude` CLI is installed (so we can register the MCP server globally). */
  claudeCli: boolean;
  /** Whether an `reticle` MCP server is already registered with Claude (any scope) — idempotency. */
  mcpExists: boolean;
  /** `process.platform`. Injected so this module stays pure. Windows is the only branch. */
  platform?: string;
  /** Whether THIS project has a .cursor/ directory — the signal that Cursor works on this repo. */
  cursorProjectPresent?: boolean | undefined;
  /**
   * Every OTHER MCP client detected on this machine, with its config path and current content.
   *
   * Claude Code and Cursor keep their own steps — Claude registers through its CLI, and Cursor's
   * predates this. Everything else is uniform: read the file, merge, write.
   */
  detectedClients?:
    readonly { id: McpClient; configPath: string; existing: string | null }[] | undefined;
  /** Discovered Vite config: its path + source, or null if none found. */
  viteConfig: { path: string; source: string } | null;
  /** Discovered Astro config: its path + source, or null if none found. */
  astroConfig?: { path: string; source: string } | null | undefined;
  /**
   * The single layout to instrument, or null when the choice is not obvious.
   *
   * WHICH page or layout to instrument is a real decision — so `init` only makes it when there is
   * exactly one candidate. Zero or several falls back to the printed recipe rather than guessing at
   * the file every page of the user's site inherits from.
   */
  astroLayout?: { path: string; source: string } | null | undefined;
  /**
   * Existing `src/env.d.ts` content, when present — where the Vite-define ambient declarations go
   * so `astro check` can see `__RETICLE_TOKEN__` / `__RETICLE_ROOT__` (#677).
   */
  astroEnvDts?: string | null | undefined;
  /** Discovered Next config filename (e.g. 'next.config.mjs'), or null. */
  nextConfigFile: string | null;
  /** Source of that Next config, so the export can be wrapped in withReticle. */
  nextConfigSource?: string | null | undefined;
  /** Discovered Next root layout: its path + source, or null (App Router only). */
  nextLayout?: { path: string; source: string } | null | undefined;
  /** Where the dev-only connect component goes — never inside `pages/`, which routes on presence. */
  nextReticleDevPath?: string | undefined;
  /** What the mount file should import — a sibling for App Router, `../components/…` for Pages. */
  nextReticleDevImport?: string | undefined;
  /** Whether the ReticleDev component file already exists. */
  nextReticleDevExists: boolean;
  /**
   * The existing ReticleDev component's source, when there is one.
   *
   * Read so an install predating daemon discovery can be told apart from a current one. Undefined
   * means NOT READ, and an unread file is reported as already-wired rather than as stale: inventing
   * work from missing information is how a plan grows steps that can never be completed.
   */
  nextReticleDevSource?: string | null | undefined;
  /** `data-testid` values scanned from the app's source, for the generated capabilities block. */
  testids?: readonly string[] | undefined;
  /** Ready-to-uncomment `registerStore` lines for the state libraries the app actually depends on. */
  storeHints?: readonly string[] | undefined;
  /** Store instances found in the app's own source — imported and registered outright, not hinted. */
  foundStores?: readonly FoundStore[] | undefined;
  /** The same stores, with specifiers resolved from Next's dev-module directory instead of `src/`. */
  nextFoundStores?: readonly FoundStore[] | undefined;
  /** Whether src/reticle-dev.ts already exists — it is the one generated file users are meant to edit. */
  viteDevModuleExists?: boolean | undefined;
  /** Whether src/hooks.client.ts already exists (SvelteKit idempotency). */
  svelteKitHooksExists?: boolean;
  /** Whether app/entry.client.tsx already exists — it decides which React Router recipe to print. */
  reactRouterEntryExists?: boolean;
  /** CRA's bundled entry (src/index.tsx or .js) — where the connect import has to go. */
  craEntry?: { path: string; source: string } | null;
  /** Existing .env.development.local, so an unrelated variable in it survives. */
  craEnv?: string | null;
  /** The daemon's pairing token, inlined for CRA through the one channel it supports. */
  pairingToken?: string;
  /** Whether .reticle.json already exists in the project root (idempotency). */
  reticleConfigExists?: boolean;
  /**
   * Its CONTENT, so an existing config can be checked instead of trusted.
   *
   * Existence alone said "a file is present" and was reported as "this is configured correctly" —
   * see reticleConfigStep for the port that survived every re-run because of it.
   */
  reticleConfigSource?: string | null | undefined;
  /** Current project-root CLAUDE.md content (for the idempotent agent-rule merge), or null/undefined. */
  claudeMdContent?: string | null | undefined;
  /** Current project-root AGENTS.md content (the cross-agent rule), or null/undefined. */
  agentsMdContent?: string | null | undefined;
  /** Current project-root RETICLE.md content (the full rules), or null when absent. */
  reticleMdContent?: string | null | undefined;
  /**
   * Current .cursor/rules/reticle.mdc content, or null when absent.
   *
   * CONTENT, not existence. Gating on the file merely being there froze a Cursor project's rule at
   * whatever release wrote it — so the CLAUDE.md path refreshed itself while the Cursor one never
   * could, and a rule added later (`version_skew`) never reached a Cursor-only project at all.
   */
  cursorRuleContent?: string | null | undefined;
  /** Current .claude/commands/reticle.md content, or null when absent (slash-command idempotency). */
  claudeCommandContent?: string | null | undefined;
  /** Current .cursor/commands/reticle.md content, or null when absent. */
  cursorCommandContent?: string | null | undefined;
  /**
   * Absolute directory the AGENT runs in, when that is not the app's directory.
   *
   * The rule and command files are read by the agent, not by the app, so a monorepo whose app is a
   * directory down must still get its `/reticle` where the human's session actually stands. Absent
   * (the single-package case) leaves every path project-relative exactly as before.
   */
  agentFileRoot?: string | undefined;
  /**
   * Content of the `.reticle.json` already sitting at that agent root, or null/undefined when there
   * is none. Content rather than existence, for the reason `reticleConfigSource` is: a root config
   * that disagrees with the app's is worse than no root config, and only reading it can tell.
   */
  agentRootConfigSource?: string | null | undefined;
  options: {
    port: number | undefined;
    mcp: boolean;
    install: boolean;
    /** Stable project identity derived at init (package.json name + root). Baked into snippets/.reticle.json. */
    projectId?: string;
    /** The CLI's own version, pinned onto the SDK install so a stale registry cache cannot skew it. */
    sdkVersion?: string;
  };
}

/**
 * Where the agent-facing files go, which is not always where the app is.
 *
 * Reported from the field (#318): a repo with its app at `src/admin` got `.claude/commands/reticle.md`
 * written into the app directory, while the human's agent session runs at the repo root — so
 * `/reticle` did not exist for them at all until they copied it up by hand. The rule and command
 * files are read by the AGENT, so they belong where the agent stands; the app files stay with the
 * app. The two are the same directory in a single-package repo, which is why this went unnoticed.
 */
function agentFile(input: PlanInput, relPath: string): string {
  const root = input.agentFileRoot;
  return root === undefined || 0 === root.length ? relPath : join(root, relPath);
}

const CLAUDE_MCP_TITLE = 'MCP server (Claude, global)';

function claudeMcpStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  if (input.mcpExists) {
    return {
      title: CLAUDE_MCP_TITLE,
      target: MCP_TARGET,
      status: StepStatus.ALREADY,
      detail: 'reticle already registered (install once, used by every project)',
    };
  }
  const cmd = claudeAddCommand();
  return {
    title: CLAUDE_MCP_TITLE,
    target: MCP_TARGET,
    status: StepStatus.APPLY,
    detail: 'register reticle globally for all projects',
    exec: { command: cmd.command, args: cmd.args, fallback: cmd.display },
  };
}

/**
 * One step per OTHER detected client.
 *
 * The shapes differ enough that a shared "write mcp.json" would be wrong for three of them — see
 * mcp-clients.ts. What is shared is the DECISION: already-correct is left alone, a file we cannot
 * parse is reported with a paste-able block rather than overwritten, and everything else is written.
 */
function otherClientSteps(input: PlanInput): Step[] {
  const steps: Step[] = [];
  for (const detected of input.detectedClients ?? []) {
    const spec = clientSpec(detected.id);
    const merged = mergeClientConfig(spec, detected.existing);
    const title = `MCP server (${spec.label})`;
    if (merged.status === ClientMergeStatus.ALREADY) {
      steps.push({
        title,
        target: detected.configPath,
        status: StepStatus.ALREADY,
        detail: `reticle already registered with ${spec.label}`,
      });
      continue;
    }
    if (merged.status === ClientMergeStatus.MANUAL) {
      // Either the file did not parse, or the format is one we refuse to edit blind (TOML). Both
      // end the same way: say so, and hand over the exact block.
      steps.push({
        title,
        target: detected.configPath,
        status: StepStatus.MANUAL,
        detail: `add this to ${detected.configPath} by hand:\n${clientSnippet(spec)}`,
      });
      continue;
    }
    steps.push({
      title,
      target: detected.configPath,
      status: StepStatus.APPLY,
      detail: `register reticle with ${spec.label}`,
      write: { path: detected.configPath, content: merged.content },
    });
  }
  return steps;
}

/** One global registration per detected agent (Claude + Cursor). Falls back to a manual note. */
function mcpSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) {
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.SKIP,
        // Names everything it turns off. `--no-mcp` reads like "skip one step" and skips three: the
        // registration, the agent rule files, and the /reticle command. A gate running with this flag
        // therefore covers far less than its name suggests, which is worth saying out loud.
        detail:
          '--no-mcp — also skips the agent rule files (CLAUDE.md / AGENTS.md / .cursor) and the /reticle command',
      },
    ];
  }
  // Claude and Cursor first (they have their own registration paths), then every other detected
  // client. A machine with Cursor AND Windsurf gets both — registering only the first one found is
  // how a user ends up with Reticle in the editor they were not using.
  const steps = [...stepsForAgents(input, (a) => a.mcpStep), ...otherClientSteps(input)];
  if (0 === steps.length) {
    // No agent detected. mcpManual already carries the Windows cmd fallback — do not append it again.
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.MANUAL,
        detail: mcpManual(),
      },
    ];
  }
  const windowsNote = windowsMcpNoteStep(input);
  if (windowsNote !== null) steps.push(windowsNote);
  return steps;
}

const WINDOWS_MCP_TITLE = 'Windows MCP spawn';

/** Windows only. The reported install never reached mcpManual because `claude mcp add` succeeded. */
function windowsMcpNoteStep(input: PlanInput): Step | null {
  if (input.platform !== NodePlatform.WINDOWS) return null;
  return {
    title: WINDOWS_MCP_TITLE,
    target: MCP_TARGET,
    status: StepStatus.NOTICE,
    detail: mcpWindowsNote(),
  };
}

const SLASH_COMMAND_TITLE = 'The /reticle command';

/**
 * Nothing to do for this command file: it already holds the CURRENT body, or it is not ours at all.
 *
 * Gating on mere existence froze the command at whatever release wrote it. Rewriting anything found
 * there would be worse — a human may have claimed `/reticle` for their own prompt — so a file without
 * our signature is left exactly as it is.
 */
function commandIsSettled(content: string | null | undefined): boolean {
  if (null === content || content === undefined) return false;
  return content === SLASH_COMMAND_BODY || !content.includes(SLASH_COMMAND_SIGNATURE);
}

/**
 * `/reticle` — the entry point SKILL.md promises in three places and nothing ever created, so it
 * silently did nothing in every tool.
 *
 * CURRENT, not merely present — same reason as the Cursor rule: a command file frozen at whatever
 * release created it is a command that can never be improved for anyone who already ran init. The
 * whole file is Reticle's, so a stale one is rewritten.
 */
function commandStepFor(
  path: string,
  present: boolean,
  content: string | null | undefined,
): Step | null {
  if (!present) return null;
  return commandIsSettled(content)
    ? {
        title: SLASH_COMMAND_TITLE,
        target: path,
        status: StepStatus.ALREADY,
        detail: 'command already exists',
      }
    : {
        title: SLASH_COMMAND_TITLE,
        target: path,
        status: StepStatus.APPLY,
        detail: 'type /reticle to verify one flow in the browser',
        write: { path, content: SLASH_COMMAND_BODY },
      };
}

function claudeCommandStep(input: PlanInput): Step | null {
  return commandStepFor(
    agentFile(input, CLAUDE_COMMAND_PATH),
    input.claudeCli,
    input.claudeCommandContent,
  );
}

function cursorCommandStep(input: PlanInput): Step | null {
  const cursorGlobal = (input.detectedClients ?? []).some((c) => c.id === McpClient.CURSOR);
  const present = true === input.cursorProjectPresent || (cursorGlobal && !input.claudeCli);
  return commandStepFor(agentFile(input, CURSOR_COMMAND_PATH), present, input.cursorCommandContent);
}

const AGENT_RULE_TITLE = 'Agent verification rule';
const AGENT_RULE_DETAIL = 'teach the agent to verify features with Reticle after building them';
const RETICLE_MD_TITLE = 'Full agent rules';
const RETICLE_MD_DETAIL =
  'the reference the always-loaded rule points at (when NOT to verify, recovery, feedback)';

function claudeRuleStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  const path = agentFile(input, CLAUDE_MD_PATH);
  const r = mergeMarkedInstruction(input.claudeMdContent);
  if (r.status === AgentRuleStatus.ALREADY) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in CLAUDE.md',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path, content: r.content },
  };
}

/**
 * The Cursor rule is a PROJECT file, so it is written only when Cursor plausibly works on THIS
 * project — the repo has a `.cursor/` dir, or Cursor is the only agent found. `~/.cursor` merely
 * existing on the machine meant every Claude Code user got an unexplained `.cursor/rules/reticle.mdc`
 * committed into their repo. (Global MCP registration is different: it is global, and stays.)
 */
function cursorRuleStep(input: PlanInput): Step | null {
  const cursorGlobal = (input.detectedClients ?? []).some((c) => c.id === McpClient.CURSOR);
  if (!cursorGlobal && true !== input.cursorProjectPresent) return null;
  if (input.cursorProjectPresent !== true && input.claudeCli) return null;
  // The whole file is Reticle's — init created it — so a stale one is REWRITTEN rather than merged.
  // Comparing content is what makes the rule updatable; comparing existence made it permanent.
  const path = agentFile(input, CURSOR_RULE_PATH);
  if (input.cursorRuleContent === cursorRuleFile()) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in .cursor/rules',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path, content: cursorRuleFile() },
  };
}

/**
 * Every coding agent `reticle init` knows how to wire itself into, and the three surfaces it wires:
 * the global MCP registration, the project rule file that makes the agent USE Reticle, and the
 * `/reticle` command.
 *
 * One list, because those three surfaces used to enumerate Claude and Cursor separately in three
 * places — so supporting a fourth agent meant finding all three and getting each right. Adding one
 * is now an entry here plus its builders; each builder answers null when that agent is not present
 * for this user or this project, which is also how "no agent detected" falls through to the
 * cross-agent AGENTS.md.
 *
 * Deliberately functions rather than data: registering with Claude runs its CLI while Cursor merges
 * a JSON file, and pretending those are the same shape would cost more than it saves.
 */
const AgentId = {
  CLAUDE: 'claude',
  CURSOR: 'cursor',
} as const;
type AgentId = (typeof AgentId)[keyof typeof AgentId];

interface AgentIntegration {
  readonly id: AgentId;
  /** Global MCP registration. Omit when the generic `otherClientSteps` loop handles it. */
  readonly mcpStep?: (input: PlanInput) => Step | null;
  /** The project instruction file this agent re-reads every session. */
  readonly ruleStep: (input: PlanInput) => Step | null;
  /** The project slash-command file, for agents that have a command surface. */
  readonly commandStep: (input: PlanInput) => Step | null;
}

const AGENT_INTEGRATIONS: readonly AgentIntegration[] = [
  {
    id: AgentId.CLAUDE,
    mcpStep: claudeMcpStep,
    ruleStep: claudeRuleStep,
    commandStep: claudeCommandStep,
  },
  {
    id: AgentId.CURSOR,
    ruleStep: cursorRuleStep,
    commandStep: cursorCommandStep,
  },
];

/** The steps one surface contributes across every known agent, in registry order. */
function stepsForAgents(
  input: PlanInput,
  surface: (a: AgentIntegration) => ((input: PlanInput) => Step | null) | undefined,
): Step[] {
  return AGENT_INTEGRATIONS.map((a) => surface(a)?.(input) ?? null).filter(
    (s): s is Step => s !== null,
  );
}

/** The `/reticle` command file for every agent that has a command surface and is present here. */
function slashCommandSteps(input: PlanInput): Step[] {
  return stepsForAgents(input, (a) => a.commandStep);
}

/**
 * `AGENTS.md`, always. It is the file every agent that is not Claude or Cursor reads.
 *
 * This used to be a FALLBACK, written only when no agent was detected. So a repo set up on a machine
 * with Claude Code got `CLAUDE.md` and nothing else, and the next person to open it with Codex,
 * Copilot, Amp, Gemini or any other agent found a fully instrumented app whose rules were addressed
 * to somebody else's tool. The detection tells you which agent is running the install; it says
 * nothing about which agents will open the repository afterwards.
 */
function agentsMdStep(input: PlanInput): Step {
  const r = mergeMarkedInstruction(input.agentsMdContent);
  const path = agentFile(input, AGENTS_MD_PATH);
  if (r.status === AgentRuleStatus.ALREADY) {
    return {
      title: AGENT_RULE_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in AGENTS.md',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path, content: r.content },
  };
}

/**
 * `RETICLE.md`, the reference the always-loaded blocks point at.
 *
 * Written whole rather than merged, because `init` owns the entire file: there is no user content to
 * preserve, and the marker dance exists only for files somebody else already writes in.
 */
function reticleMdStep(input: PlanInput): Step {
  const path = agentFile(input, RETICLE_MD_PATH);
  const content = reticleMdFile();
  if (input.reticleMdContent === content) {
    return {
      title: RETICLE_MD_TITLE,
      target: path,
      status: StepStatus.ALREADY,
      detail: 'full rules already current',
    };
  }
  return {
    title: RETICLE_MD_TITLE,
    target: path,
    status: StepStatus.APPLY,
    detail: RETICLE_MD_DETAIL,
    write: { path, content },
  };
}

/**
 * The behavioral rules that make the agent actually USE Reticle, and know when not to.
 *
 * Every detected agent's own file, plus `AGENTS.md` for the ones that will open this repo later, plus
 * `RETICLE.md` holding the reference half. Rides with the MCP wiring: `--no-mcp` opts out of
 * registering the tools AND of every rule file, because rules for tools the agent cannot reach are
 * noise.
 */
function agentRuleSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) return [];
  return [...stepsForAgents(input, (a) => a.ruleStep), agentsMdStep(input), reticleMdStep(input)];
}

/**
 * What to say when the install command fails.
 *
 * pnpm's `minimumReleaseAge` refuses any release younger than the configured window — a deliberate
 * supply-chain policy, not a bug — with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Unpinned it silently
 * resolves to an OLDER version instead, which is how an app ends up running a 2.2.1 SDK against a
 * 2.3.0 daemon: the connection succeeds, the protocol disagrees, and the failure surfaces as -32000
 * with nothing naming a version. Pinning turns that into this loud failure, which is the better
 * trade — but only if the message says what to do about it.
 */
/**
 * Said out loud when the exact-version install failed and the unpinned one worked.
 *
 * It used to assert a cause it cannot know. Every one of nine fixture apps got the same sentence —
 * "the registry refused 2.5.0 (pnpm's minimumReleaseAge holds new releases back)" — when the actual
 * cause on that run was that the version did not exist yet, and the remedy offered was a `pnpm
 * config` command handed to a yarn 1 project that will never read it.
 *
 * This note is built at PLAN time, before anything runs, and `io.exec` returns a bare boolean, so
 * the apply layer has no failure text to hand back either. The honest move is therefore to report
 * the CONSEQUENCE (which is certain and is the part that bites) and offer the remedy that belongs to
 * the manager actually in use — rather than name a cause that is one possibility among several.
 */
function unpinnedRetryNote(version: string | undefined, pm: PackageManager): string {
  const wanted = version === undefined ? 'the exact version' : version;
  // Kept verbatim for pnpm, where minimumReleaseAge is a real and common cause with a real remedy.
  const remedy =
    pm === PackageManager.PNPM
      ? ' One common cause on pnpm is minimumReleaseAge holding a new release back; if pnpm ' +
        'reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, either wait out the window or allow these ' +
        'packages: pnpm config set minimumReleaseAgeExclude "@reticlehq/*"'
      : '';
  return (
    `the pinned install of ${wanted} failed, so the newest version the registry WOULD accept was ` +
    `installed instead. That may not match the daemon — if the agent reports protocol errors, check ` +
    `\`versionSkew\` in reticle_sessions.${remedy}`
  );
}

function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const packages = pinnedPackages(
    frameworkPackages(input.detection.framework, input.detection.uiLibrary),
    input.options.sdkVersion,
  );
  const command = installCommand(pm, packages);
  if (!input.options.install) {
    return {
      title: 'Install dependencies',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  const parts = installCommandParts(pm, packages);
  return {
    title: 'Install dependencies',
    target: 'package.json',
    status: StepStatus.APPLY,
    detail: command,
    exec: {
      command: parts.command,
      args: parts.args,
      fallback: `${command}\n\n${installFailureHint(pm)}`,
    },
    // Unpinned. pnpm resolves the newest MATURE version there, which is how a project with a
    // release-age hold gets a working install instead of no install.
    retry: {
      ...installCommandParts(
        pm,
        frameworkPackages(input.detection.framework, input.detection.uiLibrary),
      ),
      note: unpinnedRetryNote(input.options.sdkVersion, pm),
    },
  };
}

const RETICLE_CONFIG_TITLE = 'Reticle config';
const AGENT_ROOT_CONFIG_TITLE = 'Reticle config (agent root)';

/**
 * The SECOND `.reticle.json`, in the directory the agent runs from.
 *
 * `.reticle.json` is not app wiring — nothing in the app reads it. The CLI and `reticle mcp` read it
 * from their own CWD (see cli-port), and that CWD is the repo root, not the app directory a redirect
 * wired. Reported from the field: an app in `frontend/` on a non-default bridge port left the root
 * with no config at all, so `reticle mcp` fell back to 4400 — which on that machine was ANOTHER
 * project's daemon, and `reticle_sessions` would have listed a different app's tabs while the wired
 * app sat unseen. Nothing in the report said so; every step was green.
 *
 * Written in BOTH places rather than moved: a human standing in the app runs `reticle status` there,
 * and the two files are byte-identical, so neither can disagree with the other about the port or the
 * project identity.
 */

function agentRootConfigStep(input: PlanInput, content: string): Step[] {
  const root = input.agentFileRoot;
  if (root === undefined || 0 === root.length) return [];
  const path = agentFile(input, RETICLE_CONFIG_FILE);
  const existingProject = projectIdOf(input.agentRootConfigSource);
  const wantedProject = projectIdOf(content);
  /**
   * A monorepo has more than one app and the root can only point at one of them.
   *
   * ABSENT and CONFLICTING used to share this branch, so the second got the first's treatment and
   * its reassuring wording. Reported from the field: two instrumented apps, a root config naming
   * the first, and `init --app <the second>` repointed the root with no warning -- after which an
   * agent started at the root reads one project's config and drives another. That is the
   * silent-wrong-target failure this product exists to prevent, shipped by its own installer.
   *
   * Neither answer is ours to pick. Overwriting discards the other app's identity; skipping quietly
   * leaves the agent aimed away from the app just wired. So the conflict is NAMED and nothing is
   * written -- the app's own config is still correct either way, so the app is fully instrumented
   * and only the root pointer is left for a human to decide.
   */
  if (
    existingProject !== undefined &&
    wantedProject !== undefined &&
    existingProject !== wantedProject
  ) {
    return [
      {
        title: AGENT_ROOT_CONFIG_TITLE,
        target: path,
        status: StepStatus.NOTICE,
        detail:
          `left alone: it names project "${existingProject}", not "${wantedProject}". An agent ` +
          'started here would read that project and drive this one. Point it at whichever app ' +
          'this agent should verify, or run the agent from the app directory.',
      },
    ];
  }
  if (input.agentRootConfigSource === content) {
    return [
      {
        title: AGENT_ROOT_CONFIG_TITLE,
        target: path,
        status: StepStatus.ALREADY,
        detail: 'the agent already reads the same project config',
      },
    ];
  }
  return [
    {
      title: AGENT_ROOT_CONFIG_TITLE,
      target: path,
      status: StepStatus.APPLY,
      detail:
        'the same config where the agent runs — `reticle mcp` reads it from ITS cwd, and without ' +
        'it the agent talks to whatever daemon is on the default port',
      write: { path, content },
    },
  ];
}

function reticleConfigStep(input: PlanInput, content: string): Step {
  if (true === input.reticleConfigExists) {
    const problem = existingConfigProblem(input.reticleConfigSource);
    if (problem !== undefined) {
      // `ℹ`, not `·`: the step is done and something about the result still stops things working,
      // which is the one mark that says "there is something here to read".
      return {
        title: RETICLE_CONFIG_TITLE,
        target: RETICLE_CONFIG_FILE,
        status: StepStatus.NOTICE,
        detail: problem,
      };
    }
    // The one thing a re-run can still learn: which channel the user actually arrived through.
    // See configWithInstallSource — it only ever ADDS a field that is absent.
    const backfilled = configWithInstallSource(input.reticleConfigSource, declaredInstallSource());
    if (backfilled !== undefined) {
      return {
        title: RETICLE_CONFIG_TITLE,
        target: RETICLE_CONFIG_FILE,
        status: StepStatus.APPLY,
        detail: 'record which install route this project came through',
        write: { path: RETICLE_CONFIG_FILE, content: backfilled },
      };
    }
    return {
      title: RETICLE_CONFIG_TITLE,
      target: RETICLE_CONFIG_FILE,
      status: StepStatus.ALREADY,
      detail: '.reticle.json already exists',
    };
  }
  return {
    title: RETICLE_CONFIG_TITLE,
    target: RETICLE_CONFIG_FILE,
    status: StepStatus.APPLY,
    detail: 'write project config (framework + port)',
    write: { path: RETICLE_CONFIG_FILE, content },
  };
}

/**
 * The project config, in every directory that has to read it: the app's, and — after a redirect —
 * the one the agent runs from. One content string for both, so they cannot disagree; an existing
 * app-side config wins over a freshly derived one, or a re-run would copy a DIFFERENT identity up.
 */
function reticleConfigSteps(input: PlanInput): Step[] {
  const existing = input.reticleConfigSource;
  const content =
    true === input.reticleConfigExists && null !== existing && existing !== undefined
      ? existing
      : reticleConfigContent(
          input.detection.framework,
          input.options.port,
          input.options.projectId,
          // Only when it is actually known. Writing `unknown` would be indistinguishable from a
          // config written before this field existed, and the two mean different things.
          declaredInstallSource(),
        );
  return [reticleConfigStep(input, content), ...agentRootConfigStep(input, content)];
}

/**
 * A step that says out loud when the app isn't React. SvelteKit already carries its own unverified
 * note, so it isn't doubled up here.
 */
function uiLibraryStep(input: PlanInput): Step[] {
  const lib = input.detection.uiLibrary;
  // Nuxt and SvelteKit each carry their own unverified wording inside the recipe, so a second,
  // more generic notice beside it would only argue with the specific one.
  const framework = input.detection.framework;
  if (
    lib === UiLibrary.REACT ||
    framework === Framework.SVELTEKIT ||
    framework === Framework.NUXT
  ) {
    return [];
  }
  if (lib === UiLibrary.UNKNOWN) return [];
  return [
    {
      title: `${lib} is UNVERIFIED`,
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: unverifiedUiLibraryNote(lib),
    },
  ];
}

export function buildPlan(input: PlanInput): Plan {
  const steps: Step[] = [
    ...cspStep(input),
    ...mcpSteps(input),
    ...agentRuleSteps(input),
    ...slashCommandSteps(input),
    ...uiLibraryStep(input),
    installStep(input),
    ...reticleConfigSteps(input),
  ];
  steps.push(...frameworkSteps(input));
  return { framework: input.detection.framework, uiLibrary: input.detection.uiLibrary, steps };
}
