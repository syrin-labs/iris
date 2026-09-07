/**
 * Who drives the app, and whether what they left behind is worth keeping.
 *
 * The drive is the only part of setup that needs a model, and the only part that can succeed
 * expensively and leave something worthless. Both of those are decisions, so both live here where
 * they can be tested without spending anything.
 */

/** What a driver needs to build its own invocation. */
interface DriveInvocation {
  /** The tools the drive may use, comma-separated, in Claude Code's spelling. */
  readonly tools: string;
  readonly budgetUsd: number;
  readonly model: string | undefined;
  /** Passed as an argument only by drivers whose promptVia is 'arg'. */
  readonly prompt: string;
}

/**
 * An agent CLI that can be asked to drive, in preference order.
 *
 * Each carries its OWN argv, because they share nothing. A table that lists four drivers and builds
 * one CLI's flags for all of them does not support four drivers: it supports one and fails the
 * others with an unknown-flag error, which is what this looked like before.
 */
export interface DriverSpec {
  readonly id: string;
  readonly bin: string;
  /** How its prompt is delivered. Gemini and Codex take it as an argument; the rest read stdin. */
  readonly promptVia: 'stdin' | 'arg';
  /** Its own flags, in its own spelling. */
  readonly argv: (invocation: DriveInvocation) => string[];
  /** NDJSON, for the one CLI that streams it. Everything else reports prose. */
  readonly streamsNdjson: boolean;
  /** True where the invocation is documented but has not been watched driving a real app here. */
  readonly unverified?: boolean;
}

export const DRIVERS: readonly DriverSpec[] = [
  {
    id: 'claude',
    bin: 'claude',
    promptVia: 'stdin',
    streamsNdjson: true,
    argv: ({ tools, budgetUsd, model }) => [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      tools,
      ...(undefined === model ? [] : ['--model', model]),
      '--max-budget-usd',
      String(budgetUsd),
      // stream-json, not json: `json` emits nothing until the run completes, so a drive killed at
      // the timeout left no trace of where it had got to.
      '--output-format',
      'stream-json',
      '--verbose',
    ],
  },
  {
    id: 'codex',
    bin: 'codex',
    // `codex exec` is its headless form and takes the prompt positionally.
    promptVia: 'arg',
    streamsNdjson: false,
    unverified: true,
    argv: ({ prompt, model }) => [
      'exec',
      ...(undefined === model ? [] : ['--model', model]),
      prompt,
    ],
  },
  {
    id: 'opencode',
    bin: 'opencode',
    // `opencode run [message..]`, verified against its own --help on this machine.
    promptVia: 'arg',
    streamsNdjson: false,
    unverified: true,
    argv: ({ prompt, model }) => [
      'run',
      ...(undefined === model ? [] : ['--model', model]),
      prompt,
    ],
  },
  {
    id: 'cursor-agent',
    bin: 'cursor-agent',
    promptVia: 'arg',
    streamsNdjson: false,
    unverified: true,
    argv: ({ prompt, model }) => [
      '-p',
      ...(undefined === model ? [] : ['--model', model]),
      '--output-format',
      'text',
      prompt,
    ],
  },
  {
    id: 'gemini',
    bin: 'gemini',
    // Gemini takes its prompt as the value of -p, and gates MCP servers by name.
    promptVia: 'arg',
    streamsNdjson: false,
    unverified: true,
    argv: ({ prompt, model }) => [
      '-p',
      prompt,
      ...(undefined === model ? [] : ['--model', model]),
      '--allowed-mcp-server-names',
      'reticle',
      '--output-format',
      'text',
    ],
  },
];

/**
 * The first driver that is present AND runs.
 *
 * The second half is the one that has bitten: a CLI can be on PATH and broken — a half-installed
 * codex whose vendor binary is missing exits non-zero on every invocation — and driving with one of
 * those produces an empty session that looks exactly like success.
 */
export function chooseDriver(
  drivers: readonly DriverSpec[],
  probe: (bin: string) => { readonly present: boolean; readonly runs: boolean },
): DriverSpec | null {
  for (const d of drivers) {
    const { present, runs } = probe(d.bin);
    if (present && runs) return d;
  }
  return null;
}

/** The grade `reticle_flow_save` reported, read out of the drive's own prose. */
export function readAssertionsGrade(text: string | undefined): string | undefined {
  const source = text ?? '';
  return (
    /assertions?\.?grade\W+`?([a-z-]+)/i.exec(source)?.[1] ??
    /grade\W+`?([a-z-]+)/i.exec(source)?.[1]
  );
}

/** The only grade that makes a saved flow worth replaying. */
export const ASSERTED = 'asserted';

interface EscalationInput {
  readonly escalationEnabled: boolean;
  /** Set only when a faster model was chosen, since escalation means retrying without it. */
  readonly fasterModel: string | undefined;
  readonly flowSaved: boolean;
  readonly grade: string | undefined;
}

/**
 * Whether to re-record with the stronger model.
 *
 * Measured: a faster model reaches the same `verified: "yes"` about three times quicker and leaves
 * an `assertion-free` or `presence-only` flow in three runs out of four. Such a flow only ACTS, so
 * it passes even when the feature is broken — and setup replays saved flows on every later run,
 * which turns one weak recording into a permanent green. Presenting that as a trade for the user to
 * choose is worse than spending a second drive on it.
 */
export function shouldEscalate(input: EscalationInput): boolean {
  if (!input.escalationEnabled) return false;
  if (undefined === input.fasterModel) return false;
  if (!input.flowSaved) return false;
  if (undefined === input.grade) return false;
  return ASSERTED !== input.grade;
}
