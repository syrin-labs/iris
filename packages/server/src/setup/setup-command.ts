/**
 * The wire: everything init established, plus the world, plus the phases.
 *
 * Kept apart from cli.ts so the assembly is readable in one place and so `handleInit` stays the
 * three lines it was. The only decision here is which effects to hand over; the sequencing lives in
 * run-setup.ts and the pieces it calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planAgentConfigs, type PlatformPaths } from './agent-configs.js';
import { AppShape, readShape } from './desktop-shape.js';
import { stopOnInterrupt } from './interrupt.js';
import { applyAgentPlan, applyAgentSkills } from './agent-writer.js';
import { ApprovalOutcome, grantAutoApproval } from './auto-approve.js';
import { agentIo } from './agent-io.js';
import { EnsureDaemon, ensureDaemon, nodeEnsureDaemonDeps } from './ensure-daemon.js';
import { openInBrowser } from '../cli/cli-launch.js';
import { chooseDriver, DRIVERS, shouldEscalate } from './drive-plan.js';
import { driveWith } from './drive-agent.js';
import {
  binaryExists,
  flowsSaved,
  listSessions,
  OwnedDevServer,
  probePage,
} from './node-effects.js';
import {
  runSetupPhases,
  type SetupEffects,
  type SetupInput,
  type SetupOutcome,
} from './run-setup.js';

/** The capabilities file init scaffolds, in the order a project is likely to have it. */
const CAPABILITY_FILES = ['reticle-dev.tsx', 'reticle-dev.ts', 'reticle-dev.jsx', 'reticle-dev.js'];

interface SetupCommandInput extends Omit<SetupInput, 'shape'> {
  /** Where setup was invoked, which is not the app directory in a monorepo. */
  readonly invokedAt: string;
  readonly bridgePort: number;
  readonly env: Readonly<Record<string, string>>;
  readonly flow?: string | undefined;
  readonly driveBudgetUsd: number;
  readonly driveModel?: string | undefined;
  readonly escalateWeakFlow: boolean;
  /** Register the MCP server with the coding agents init does not itself reach. */
  readonly registerAgents: boolean;
}

/** `electron` in either dependency list, read the same way init's desktop doctor reads it. */
function hasElectronDependency(dir: string): boolean {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if ('object' !== typeof pkg || null === pkg) return false;
    const p = pkg as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return undefined !== { ...p.dependencies, ...p.devDependencies }['electron'];
  } catch {
    return false;
  }
}

/**
 * Register with the agents `init` does not reach, and leave the skill where one loads skills from.
 *
 * init covers eight clients and only where it finds them installed, which leaves VS Code's USER
 * scope unwritten — it exists on machines today, and init only ever writes the project-scope file,
 * so a VS Code user has no tools outside the directory they ran init in.
 */
export function registerOtherAgents(print: (line: string) => void): void {
  const platform = process.platform as keyof PlatformPaths;
  const home = homedir();
  const results = applyAgentPlan(
    planAgentConfigs({ home, platform, exists: agentIo.exists, readFile: agentIo.readFile }),
    agentIo,
  );
  const wrote = results.filter((r) => 'created' === r.action || 'merged' === r.action);
  if (0 < wrote.length) {
    print(
      `registered the MCP server with ${wrote.length} more agent(s): ${wrote.map((r) => r.name).join(', ')}`,
    );
  }
  // A format we will not rewrite is somebody's to edit, so it has to be said rather than skipped.
  for (const manual of results.filter((r) => 'manual' === r.action)) {
    print(`${manual.name}: ${manual.why} — add the reticle entry to ${manual.file} by hand.`);
  }
  const skills = applyAgentSkills(agentIo, { home, platform });
  if (0 < skills.length) print(`wrote the /reticle skill for ${skills.length} agent(s)`);

  // Registration alone still leaves an Accept dialog in front of every call, and a verification run
  // makes dozens of them: the loop is only autonomous once the tools are pre-approved.
  const approvals = grantAutoApproval(agentIo, { home, platform });
  const granted = approvals.filter((a) => ApprovalOutcome.GRANTED === a.outcome);
  if (0 < granted.length) {
    print(
      `pre-approved the reticle tools in ${granted.map((a) => a.name).join(', ')} — no Accept prompt per call`,
    );
  }
  for (const noted of approvals.filter((a) => undefined !== a.warn)) {
    print(`${noted.name}: ${String(noted.warn)}`);
  }
}

interface SetupCommandResult extends SetupOutcome {
  /** Set when a weak flow was re-recorded with the stronger model. */
  readonly escalated?: { readonly from: string; readonly to: string } | undefined;
  readonly driveTurns?: number | undefined;
  readonly driveCostUsd?: number | undefined;
}

/**
 * Run the phases against the real world.
 *
 * The dev server is stopped on every ending except success, where it is handed to the user: an
 * instrumented app they can watch is the deliverable, and killing it would leave them with config
 * files and a dead tab.
 */
export async function runSetupCommand(
  input: SetupCommandInput,
  print: (line: string) => void,
): Promise<SetupCommandResult> {
  if (input.registerAgents) registerOtherAgents(print);

  // Before the app is booted, because the app's whole job from here is to dial this port. Without
  // it the phases wait out their budget and then report the SDK as the thing that failed.
  const daemon = await ensureDaemon(input.bridgePort, nodeEnsureDaemonDeps());
  if (EnsureDaemon.UNAVAILABLE === daemon) {
    print(
      `could not start the Reticle daemon on port ${String(input.bridgePort)}, so nothing is listening for the app to connect to. Run \`npx @reticlehq/server serve --port ${String(input.bridgePort)}\` and try again.`,
    );
  }

  // Which shell this is decides three things the phases would otherwise get wrong: opening a
  // browser (harmful for desktop, where the app's own window is the client), waiting for an HTTP
  // port (a Tauri webview has none), and how long the app gets to appear (a cold `tauri dev` builds
  // Rust first). The same evidence init's desktop doctor reads.
  const shape = readShape({
    hasTauriConf: existsSync(join(input.appDir, 'src-tauri', 'tauri.conf.json')),
    hasElectronDep: hasElectronDependency(input.appDir),
  });
  if (AppShape.WEB !== shape) print(`detected a ${shape} app`);

  const server = new OwnedDevServer();
  // Both roots, because in a monorepo `.reticle/` sits at the app root rather than where setup ran.
  const flowRoots = [input.invokedAt, input.appDir];
  let lastDrive: ReturnType<typeof driveWith> | undefined;
  let escalated: { from: string; to: string } | undefined;

  const effects: SetupEffects = {
    startDevServer: (command, cwd) => {
      print(`starting: ${command}`);
      server.start(command, cwd, input.env);
      return Promise.resolve();
    },
    devServerOutput: () => server.output(),
    devServerExited: () => server.exited(),
    devServerQuietForMs: () => server.quietForMs(),
    observedPorts: () => server.listeningPorts(),
    probePage,
    openBrowser: async (url) => {
      const failure = await openInBrowser(url);
      if (null !== failure) {
        print(
          `could not open a browser (${failure}). On a machine with none — CI, a container, an SSH ` +
            'session — take a tab Reticle owns instead: reticle_run({ tool: "reticle_lease", args: ' +
            `{ action: "acquire", url: "${url}" } }).`,
        );
      }
    },
    listSessions: () => listSessions(input.bridgePort),
    // Asked before the drive rather than inferred from its result: "nothing to drive with" and
    // "drove and proved nothing" are different answers and only the second is a failure.
    driverAvailable: () =>
      null !==
      chooseDriver(DRIVERS, (bin) => ({ present: binaryExists(bin), runs: binaryExists(bin) })),
    drive: (url, session) => {
      const driver = chooseDriver(DRIVERS, (bin) => ({
        present: binaryExists(bin),
        // Present is not enough: a CLI that does not run produces an empty session that looks
        // exactly like success.
        runs: binaryExists(bin),
      }));
      if (null === driver) return Promise.resolve(null);
      // Only when the SESSION says they were never finished. init fills this file for a
      // conventional app — it detects a state library and the testids — so opening it otherwise
      // spends a turn on work already done, and grants write access nobody needed.
      const capabilitiesFile =
        false === session.hasCapabilities
          ? CAPABILITY_FILES.map((f) => join(input.appDir, 'src', f)).find((p) => existsSync(p))
          : undefined;
      print('');
      print(
        `  ▸ WATCH ${url} NOW — the HUD is on, and you are about to see Reticle drive your app.`,
      );
      print('');
      const request = {
        url,
        sessionId: session.sessionId,
        tabThrottled: false,
        budgetUsd: input.driveBudgetUsd,
        ...(undefined === input.flow ? {} : { flow: input.flow }),
        ...(undefined === input.driveModel ? {} : { model: input.driveModel }),
        ...(undefined === capabilitiesFile ? {} : { unfinishedCapabilitiesFile: capabilitiesFile }),
      };
      lastDrive = driveWith(driver, request, input.appDir);

      // A weak flow only ACTS, so it passes when the feature is broken — and setup replays saved
      // flows, which turns one weak recording into a permanent green. Re-record it rather than
      // hand the trade to the user.
      if (
        shouldEscalate({
          escalationEnabled: input.escalateWeakFlow,
          fasterModel: input.driveModel,
          flowSaved: flowsSaved(flowRoots),
          ...(undefined === lastDrive.grade ? { grade: undefined } : { grade: lastDrive.grade }),
        })
      ) {
        print(
          `the saved flow graded \`${lastDrive.grade ?? 'unknown'}\` — re-recording with the default model`,
        );
        const stronger = driveWith(driver, { ...request, model: undefined }, input.appDir);
        escalated = { from: lastDrive.grade ?? 'unknown', to: stronger.grade ?? 'unknown' };
        if (undefined !== stronger.grade) lastDrive = stronger;
      }
      if (undefined !== lastDrive.incomplete) {
        print(`the drive did not finish, and ${lastDrive.incomplete}`);
      }
      return Promise.resolve('' === lastDrive.text ? null : lastDrive.text);
    },
    flowsSaved: () => flowsSaved(flowRoots),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    note: print,
  };

  // A `finally` does not run on SIGINT, and this phase owns a detached dev server — see interrupt.ts.
  const releaseSignals = stopOnInterrupt(() => {
    server.stop();
  }, process);
  try {
    const outcome = await runSetupPhases({ ...input, shape }, effects);
    // The app stays up only when there is something worth watching.
    if (outcome.ok) server.handOver();
    return {
      ...outcome,
      ...(undefined === escalated ? {} : { escalated }),
      ...(undefined === lastDrive?.turns ? {} : { driveTurns: lastDrive.turns }),
      ...(undefined === lastDrive?.costUsd ? {} : { driveCostUsd: lastDrive.costUsd }),
    };
  } finally {
    releaseSignals();
    server.stop();
  }
}
