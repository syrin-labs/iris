/**
 * Asking a child agent to drive the app, and reading what it says back.
 *
 * The drive needs a model, and the model does not need to be the caller. A client reads its MCP
 * server list once at startup and cannot reload it, so an agent that has just run `init` does not
 * yet have the reticle_* tools — which is why the hand-driven procedure asks for a restart, and why
 * three runs in five ended there having shown the user nothing. A child process started after init
 * reads the list init just wrote. No restart, no lost context, no waiting on a human.
 *
 * Two details here are not stylistic, and both cost a real run to learn.
 */

import { spawnSync } from 'node:child_process';
import { ASSERTED, readAssertionsGrade, type DriverSpec } from './drive-plan.js';

/** Ten minutes. Long, because the drive is a model working, and bounded, because it can wedge. */
const DRIVE_TIMEOUT_MS = 10 * 60_000;
/** Only the Reticle surface, unless the capabilities file has to be finished first. */
const RETICLE_TOOLS = 'mcp__reticle';
const CAPABILITY_TOOLS = 'mcp__reticle,Read,Edit,Write';

export interface DriveRequest {
  readonly url: string;
  readonly sessionId: string;
  /** The journey to drive, in the caller's own words. Absent means the child picks one. */
  readonly flow?: string | undefined;
  /** The capabilities file, when the session says it was never finished. */
  readonly unfinishedCapabilitiesFile?: string | undefined;
  /** The tab is hidden or throttled, so the child should not blame the app for a frozen page. */
  readonly tabThrottled: boolean;
  readonly budgetUsd: number;
  readonly model?: string | undefined;
}

interface DriveReport {
  /** The agent's own account, kept verbatim and never treated as a pass on its own. */
  readonly text: string;
  readonly grade?: string | undefined;
  readonly turns?: number | undefined;
  readonly costUsd?: number | undefined;
  /** Set when the run was cut short, naming where it had got to. */
  readonly incomplete?: string | undefined;
}

/**
 * Findings are the point, not the verdict.
 *
 * A green verdict demonstrates the mechanism. What people remember is Reticle telling them
 * something they did not know — measured on a real app, a drive's own assertion passed and Reticle
 * overruled it on a 504 fired inside the action window, which the drive then reported rather than
 * explaining away. That only happens if the drive is asked for it: asked for a verdict alone, it
 * returns a verdict alone, and everything else the page did goes unmentioned.
 */

/**
 * The task LEADS.
 *
 * Measured: with the situation first and a capabilities dump in the middle, a model answered "I
 * don't see an actual task or request from you yet" and drove nothing — one turn, no verdict, and
 * setup reported success. Context goes after the ask, never before it.
 */
export function buildDrivePrompt(req: DriveRequest): string {
  const task = undefined === req.flow ? 'drive one user flow' : `drive THIS flow — ${req.flow}`;
  const capabilities =
    undefined === req.unfinishedCapabilitiesFile
      ? ''
      : `\n\nFIRST: this session reports hasCapabilities:false, so ${req.unfinishedCapabilitiesFile} was scaffolded and never finished. Register whatever the app's state is readable through, and list the testids your flow touches. EDIT ONLY THAT FILE. This is somebody's repository, not a scratch copy: if the app is broken in a way that blocks the drive (a build error, a missing asset, an auth wall), say so and stop. That is a finding worth having and it is theirs to fix.`;
  const throttled = req.tabThrottled
    ? '\n\nNOTE: this tab is hidden or throttled, so timers and rAF are clamped. If an action seems to land on a page that never advances, that is why — say so rather than reporting `unknown` as if the app were at fault.'
    : '';
  return (
    `TASK: ${task} in this running app and produce a verdict. Do it now; do not ask questions, there is nobody to answer.\n\n` +
    `The app is at ${req.url} and Reticle session ${req.sessionId} is connected to it.${capabilities}${throttled}\n\n` +
    'In as few calls as you can: ONE reticle_snapshot({mode:"interactive"}) for the whole flow, ' +
    'reticle_act_sequence for every fill and intermediate click in one call, then ONE ' +
    'reticle_act_and_wait({ref,action,until}) — that is the call that produces the verdict, and ' +
    '`until` names the expected consequence BEFORE the action fires. Then reticle_state() once. ' +
    'Wrap it in reticle_record start/stop and reticle_flow_save.\n\n' +
    `Then CHECK the grade reticle_flow_save returns. Anything other than \`${ASSERTED}\` means the ` +
    'flow only ACTS: it will pass even when the feature is broken, and this setup replays that flow ' +
    'on every later run, so an unasserted flow becomes a permanent green. If it is weaker, record ' +
    'again with an `until` that names a consequence the action CHANGES.\n\n' +
    'Then, whatever the verdict says: call reticle_observe ONCE and report anything the app did that ' +
    'its owner would want to know. A console error, a failed or slow request, an unhandled ' +
    'rejection, a state that did not update, a request fired twice. Give the `file:line` wherever ' +
    'you have it. A flow that passed with a 500 behind it is not a clean app, and this is the part ' +
    'they cannot see for themselves — it is the most useful thing you will produce, so do not skip ' +
    'it because the verdict was green.\n\n' +
    'Report in this order: FINDINGS first (or "nothing else worth reporting" if the page really was ' +
    'clean), then the flow name, the verdict, and assertions.grade. A verdict of "unknown" or ' +
    '"no-fault" is NOT a pass — say so plainly rather than weakening the check until it passes.'
  );
}

/**
 * NDJSON, one event per line.
 *
 * `--output-format json` emits nothing until the run completes, so a drive killed at the timeout
 * left no trace of what it had been doing — measured four times on one app, every one reporting
 * "the drive produced no output". Streaming turns that into evidence, because spawnSync hands back
 * the stdout it collected before killing the child.
 */
export function readDriveOutput(out: string): DriveReport {
  const events: Record<string, unknown>[] = [];
  for (const line of String(out).split('\n')) {
    if ('' === line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if ('object' === typeof parsed && null !== parsed)
        events.push(parsed as Record<string, unknown>);
    } catch {
      /* a truncated final line is what a killed run looks like */
    }
  }
  const finished = [...events].reverse().find((e) => undefined !== e['total_cost_usd']);
  if (undefined !== finished) {
    const text = 'string' === typeof finished['result'] ? finished['result'] : '';
    return {
      text,
      ...(undefined === readAssertionsGrade(text) ? {} : { grade: readAssertionsGrade(text) }),
      ...('number' === typeof finished['num_turns'] ? { turns: finished['num_turns'] } : {}),
      ...('number' === typeof finished['total_cost_usd']
        ? { costUsd: finished['total_cost_usd'] }
        : {}),
    };
  }
  return { text: '', incomplete: describeUnfinished(events) };
}

/** Where a killed run had got to, from the last thing it did. */
function describeUnfinished(events: readonly Record<string, unknown>[]): string {
  for (const event of [...events].reverse()) {
    if ('assistant' !== event['type']) continue;
    const message = event['message'];
    const content =
      'object' === typeof message && null !== message
        ? (message as { content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if ('object' !== typeof part || null === part) continue;
      const p = part as { type?: unknown; name?: unknown; text?: unknown };
      if ('tool_use' === p.type && 'string' === typeof p.name)
        return `it was calling \`${p.name}\``;
      if ('text' === p.type && 'string' === typeof p.text)
        return `the last thing it said was: ${p.text.slice(0, 300)}`;
    }
  }
  return 'it produced no events at all';
}

/**
 * The prompt goes on STDIN.
 *
 * `--allowedTools` is variadic: with the prompt passed positionally after it, the flag swallowed
 * the prompt as another tool name and the run exited in two seconds having done nothing, with the
 * error on stderr — which the caller was discarding. No flag ordering is safe across four CLIs.
 */
export function driveWith(driver: DriverSpec, req: DriveRequest, cwd: string): DriveReport {
  const tools = undefined === req.unfinishedCapabilitiesFile ? RETICLE_TOOLS : CAPABILITY_TOOLS;
  const prompt = buildDrivePrompt(req);
  const args = driver.argv({
    tools,
    budgetUsd: req.budgetUsd,
    model: req.model,
    prompt,
  });
  const child = spawnSync(driver.bin, args, {
    cwd,
    encoding: 'utf8',
    timeout: DRIVE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    // Only for the drivers that read it. Passing stdin to one that takes the prompt as an argument
    // is harmless, but passing it as an argument to one that reads stdin is not: `--allowedTools`
    // is variadic and swallowed a positional prompt, and the run exited in two seconds having done
    // nothing at all.
    ...('stdin' === driver.promptVia ? { input: prompt } : {}),
  });
  const stdout = child.stdout ?? '';
  const report = driver.streamsNdjson ? readDriveOutput(stdout) : readPlainOutput(stdout);
  if ('' !== report.text || undefined !== report.incomplete) return report;
  const stderr = String(child.stderr ?? '')
    .trim()
    .split('\n')
    .slice(-3)
    .join(' ');
  return {
    text: '',
    incomplete: '' === stderr ? 'it produced no output at all' : stderr.slice(0, 300),
  };
}

/** Everything that is not Claude Code reports prose, so the report IS its output. */
export function readPlainOutput(out: string): DriveReport {
  const text = String(out).trim();
  if ('' === text) return { text: '', incomplete: 'it produced no output at all' };
  const grade = readAssertionsGrade(text);
  return { text, ...(undefined === grade ? {} : { grade }) };
}
