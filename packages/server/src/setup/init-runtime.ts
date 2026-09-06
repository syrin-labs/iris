/**
 * What `init` does after the files are written, and how it decides whether to.
 *
 * Lives here rather than in cli.ts because it is a cohesive unit with its own reasons, and because
 * cli.ts is a dispatcher: a command that grew a second half should not make the file that routes
 * every command harder to read.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import type { InitResult } from '../init/run.js';
import { confirmInstall, nodeConfirmDeps } from '../init/confirm.js';
import { writeLicenseKey } from './license-key.js';
import { registerOtherAgents, runSetupCommand } from './setup-command.js';
import { bridgeOccupied } from './bridge-port.js';
import { relaunchDecision } from './relaunch.js';
import { claudeTranscriptExists, codexSessionFor } from './transcripts.js';
import { probePresence } from '../daemon/port-presence.js';
import { probeDaemon } from '../mcp/proxy-daemon-probe.js';
import { fetchStatus } from '../cli/cli-launch.js';
import { collectEnv, DEFAULT_DRIVE_BUDGET_USD, DEFAULT_PHASE_TIMEOUT_MS } from './setup-options.js';

/** How often the runtime phases look again: fast enough not to be the wait, slow enough to be free. */
const POLL_MS = 250;

/** Just enough of the parsed command to decide and run. */
interface InitRuntimeArgs {
  readonly port: number | undefined;
  readonly dryRun: boolean;
  readonly filesOnly?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly drive?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly agents?: boolean | undefined;
  /**
   * `--no-mcp`. It governs agent registration too, and pre-approval with it.
   *
   * The flag's own help says it skips MORE than the server registration, "because all three only
   * make sense once the tools are reachable" — and a pre-approval rule for a server the machine was
   * told not to register is the clearest case of that. It went unread when the registration moved
   * here, so a run that asked us to leave the machine's config alone wrote to four files in the
   * user's home. The install gate caught it, because the gate runs with --no-mcp.
   */
  readonly mcp?: boolean | undefined;
  readonly flow?: string | undefined;
  readonly env?: string[] | undefined;
  readonly url?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  /** Restart the calling client so IT gets the tools — see relaunch.ts. */
  readonly relaunch?: boolean | undefined;
  readonly driveModel?: string | undefined;
  readonly licenseKey?: string | undefined;
}

/** Registration is global MCP wiring, so both flags that disown it are read here. */
function wantsAgents(parsed: InitRuntimeArgs): boolean {
  return false !== parsed.agents && false !== parsed.mcp;
}

interface RuntimePrintIo {
  readonly print: (line: string) => void;
}

const licenseIo = {
  exists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string => readFileSync(path, 'utf8'),
  writeFile: (path: string, contents: string): void => writeFileSync(path, contents),
};

/**
 * Carry on from a finished `init`, or stop where it used to.
 *
 * `--files-only` is what init did before it learned to boot the app, and a dry run is a preview:
 * both keep the old ending. Everyone else gets the rest, because writing files was never the same
 * thing as an install working.
 */
export async function continueAfterInit(
  parsed: InitRuntimeArgs,
  result: InitResult,
  io: RuntimePrintIo,
  cwd: string,
): Promise<void> {
  const port = parsed.port ?? RETICLE_DEFAULT_PORT;

  // Before anything else: the key belongs in .env whichever way this run ends, and the CLI folds a
  // project-local .env into the environment on every invocation.
  if (undefined !== parsed.licenseKey) {
    const written = writeLicenseKey(cwd, parsed.licenseKey, licenseIo);
    io.print(written.message);
  }

  if (true === parsed.filesOnly || parsed.dryRun) {
    // Registration and pre-approval still run here, and this is the ONLY route an existing user
    // has: nothing reaches back into a machine that installed Reticle a version ago, so the
    // upgrade path is re-running init, and the light form of init has to be enough to carry it.
    // A dry run writes nothing anywhere, including here.
    if (true === parsed.filesOnly && wantsAgents(parsed)) registerOtherAgents(io.print);
    return confirmInstall(result, io, nodeConfirmDeps(port)).then(() => {
      if (!result.ok) process.exit(1);
    });
  }

  const context = result.context;
  if (context === undefined) {
    // Nothing was established, so there is nothing to run against. init has already said why.
    process.exit(1);
  }
  // A PENDING connect step is not a reason to skip the runtime phase, and treating it as one made
  // `init` stop with "paste this snippet" while never looking at the app.
  //
  // `result.ok` is exactly `!connectPending`, so every project whose instrumentation needs a manual
  // step — a plain-HTML app, anything with no recognised build config — exited here. The user was
  // told to do something by hand and told nothing about whether their server was even up, whether
  // the snippet had landed, or which url was checked. The runtime phase answers all three, and its
  // answers are the actionable ones: "nothing is serving http://…", "the SDK is NOT in the page".
  //
  // The run still ends non-zero: the phase returns `ok: false` when no session appears, and a
  // session appearing means the manual step WAS done and the app really did connect — which is a
  // green worth reporting, not one to suppress.

  // What a restart should do, decided and printed. Never performed: opening a terminal is not
  // something a one-shot command should do behind a flag, and the half worth having is the refusal —
  // `--resume` on an id with no transcript opens an EMPTY conversation that looks exactly like it
  // worked. See relaunch.ts.
  if (true === parsed.relaunch) {
    io.print(
      relaunchDecision({
        ...(undefined === process.env['CLAUDE_CODE_SESSION_ID']
          ? {}
          : { claudeSessionId: process.env['CLAUDE_CODE_SESSION_ID'] }),
        ...(undefined === codexSessionFor(cwd) ? {} : { codexSessionId: codexSessionFor(cwd) }),
        transcriptExists: claudeTranscriptExists,
        cwd,
      }).message,
    );
    io.print('');
  }

  // Before the connect wait, never after: a bridge held by a stranger makes a session impossible,
  // so going ahead spends the entire budget and then reports what reads as an instrumentation
  // problem — the one place that is fine. See bridge-port.ts.
  const refusal = bridgeOccupied(
    await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus }),
    port,
  );
  if (refusal !== undefined) {
    io.print(refusal);
    process.exit(1);
  }

  return runSetupCommand(
    {
      appDir: context.appDir,
      invokedAt: cwd,
      bridgePort: port,
      env: collectEnv(parsed.env ?? []),
      openBrowser: false !== parsed.open,
      drive: false !== parsed.drive,
      registerAgents: wantsAgents(parsed),
      escalateWeakFlow: true,
      driveBudgetUsd: DEFAULT_DRIVE_BUDGET_USD,
      phaseTimeoutMs:
        undefined === parsed.timeoutSeconds
          ? DEFAULT_PHASE_TIMEOUT_MS
          : parsed.timeoutSeconds * 1000,
      // Only when the caller actually said so — see connectBudgetMs. Omitted, the shape's policy
      // keeps deciding, so nobody who passed nothing waits less than they used to.
      ...(undefined === parsed.timeoutSeconds
        ? {}
        : { connectBudgetMs: parsed.timeoutSeconds * 1000 }),
      pollMs: POLL_MS,
      ...(undefined === context.devCommand ? {} : { devCommand: context.devCommand }),
      ...(undefined === parsed.flow ? {} : { flow: parsed.flow }),
      ...(undefined === parsed.url ? {} : { suppliedUrl: parsed.url }),
      ...(undefined === parsed.driveModel ? {} : { driveModel: parsed.driveModel }),
    },
    (line) => io.print(line),
  ).then((outcome) => {
    // One object, so an agent reads a result instead of interpreting a report.
    if (true === parsed.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      if (!outcome.ok) process.exit(1);
      return;
    }
    io.print('');
    // The drive's own account, whether it ended well or not. Discarding it left a run that reached
    // the drive, produced something, and told the reader nothing about what it found.
    if (undefined !== outcome.verdict && '' !== outcome.verdict) {
      io.print(outcome.verdict);
      io.print('');
    }
    if (outcome.ok && !outcome.flowSaved) {
      // Success, and no flow. Saying "a flow was driven" here would replace a wrong exit code with
      // a wrong sentence, which is the worse of the two: the exit code is read by CI and the
      // sentence is read by a person deciding whether their app is verified. It is not.
      io.print(`✓ ${outcome.url ?? 'the app'} is instrumented and connected — but NOT verified.`);
      for (const [i, step] of outcome.fallback.entries()) io.print(`   ${String(i + 1)}. ${step}`);
      return;
    }
    if (outcome.ok) {
      io.print(
        `✓ setup complete — ${outcome.url ?? 'the app'} is instrumented and a flow was driven.`,
      );
      // A passing flow shows the mechanism working. What the run SAW is the part nobody can get for
      // themselves, and it deserves a line of its own rather than a paragraph that gets skimmed.
      io.print(
        '  Read the FINDINGS above before moving on: a flow can pass with a failed request or a ' +
          'console error behind it, and that is the app, not the check.',
      );
      return;
    }
    // A run that produced no verdict did not succeed, and the exit code is the one place a caller
    // reads that without parsing anything.
    io.print('⚠ setup did not finish. To carry on from here:');
    for (const [i, step] of outcome.fallback.entries()) io.print(`   ${i + 1}. ${step}`);
    process.exit(1);
  });
}
