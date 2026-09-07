/**
 * Which command starts this project, and should we start it ourselves?
 *
 * `init` finishes by telling the human to start or restart their dev server, in a closing
 * paragraph, in a terminal that is about to be cleared by the client restart it also asks for.
 * That is the second unmarked hand-off in the install, after the capabilities file, and it lands
 * on the same surface: prose nobody re-reads.
 *
 * Every fact needed to remove it is already in the project. `package.json` names the script; the
 * framework tells us the conventional port; a probe tells us whether something already answers
 * there. Nothing here needs a human.
 *
 * Kept as a PURE decision, separate from spawning, because the interesting part is the judgement —
 * which script, and whether to touch anything at all — and that is what wants testing. Spawning a
 * process is not.
 */

/** Script names a JS project uses to run itself, in the order we would pick them. */
export const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve'] as const;
const CANDIDATES = DEV_SCRIPT_NAMES;

export const DevScriptChoice = {
  /** Something already answers on the port. Use it; never replace a server the user is running. */
  ALREADY_SERVING: 'already-serving',
  /** We know the command and nothing is listening. Start it. */
  START: 'start',
  /** No script we recognise. Say so rather than guess a command. */
  NO_SCRIPT: 'no-script',
} as const;
export type DevScriptChoice = (typeof DevScriptChoice)[keyof typeof DevScriptChoice];

interface DevScriptPlan {
  choice: DevScriptChoice;
  /** The npm script name, when there is one. */
  script?: string;
  /** What a human would type, for the line we print. */
  command?: string;
}

/**
 * Pick the script and decide whether to run it.
 *
 * `serving` is the probe result, passed in rather than measured here so the decision stays pure.
 * When something is already answering we do not care which script exists: the rule is never to
 * start a second server, because the one that is running may be the user's, with their state in it.
 */
export function planDevScript(
  scripts: Readonly<Record<string, string>>,
  packageManager: string,
  serving: boolean,
): DevScriptPlan {
  if (serving) return { choice: DevScriptChoice.ALREADY_SERVING };
  const name = CANDIDATES.find((c) => 'string' === typeof scripts[c] && scripts[c] !== '');
  if (name === undefined) return { choice: DevScriptChoice.NO_SCRIPT };
  // `npm` needs `run`; the others take the script name directly. Getting this wrong prints a
  // command that fails, which is worse than printing nothing.
  const command = 'npm' === packageManager ? `npm run ${name}` : `${packageManager} ${name}`;
  return { choice: DevScriptChoice.START, script: name, command };
}

/**
 * The command to print for this project, straight from its `package.json`.
 *
 * Lives here rather than in `run.ts` because it is the same judgement as `planDevScript` with the
 * parsing attached, and `run.ts` is at its cohesion limit. Returns undefined for anything it cannot
 * read: this phrasing decides nothing, so it must never be able to break an install.
 */
export function devCommandFrom(pkg: unknown, packageManager: string): string | undefined {
  try {
    // Takes the PARSED manifest. It used to take the raw string and parse it a fourth time — the
    // caller now reads the file once, through a guard, so there is one place a malformed manifest
    // can be noticed and it is not this one.
    const scripts =
      'object' === typeof pkg && null !== pkg
        ? ((pkg as { scripts?: Record<string, string> }).scripts ?? {})
        : {};
    return planDevScript(scripts, packageManager, false).command;
  } catch {
    return undefined;
  }
}
