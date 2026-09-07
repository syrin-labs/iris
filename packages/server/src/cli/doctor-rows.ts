/**
 * The row labels `reticle doctor` can print, and the one place that pads them into a column.
 *
 * These were free strings before, hand-padded at every call site across three modules
 * (`cli-doctor.ts`, `doctor-daemon-line.ts`, `doctor-sessions-line.ts`). Two problems with that,
 * and the second is the one that motivated #340:
 *
 * 1. The padding was maintained by eye. Every label happened to be padded to the same column, but
 *    nothing enforced it, and a label longer than the column would have quietly broken the
 *    alignment of one row in a checklist whose whole readability is the column.
 * 2. Nothing connected the labels to the docs pages that reproduce doctor's output. A row could be
 *    added, renamed or removed and the three pages showing sample output would go on describing the
 *    old vocabulary, with no gate noticing. `doctor` is the command a stuck user runs, and the docs
 *    are what they read when its output does not match what they were told to expect.
 *
 * The label set is exported so the docs guard can derive its expectation from the command rather
 * than from a hand-kept list, which is the direction that catches the case that actually bites: a
 * row added and never documented.
 *
 * NOT every row prints on every run. `version` prints only on skew, `port check` only on a
 * mismatch, `sibling` only when a well-known Reticle port other than ours has a listener,
 * `desktop` only on a desktop project, and `sessions` only when a daemon answered. The
 * vocabulary is therefore "what this command can print", not "what one run printed" — a guard built
 * by scraping a single invocation would silently stop covering the conditional rows, which are
 * exactly the ones a reader is least likely to have seen before.
 */

/** Every row label `doctor` can emit. Values are the literal text at the head of the row. */
export const DoctorRow = {
  NODE: 'node',
  CHROMIUM: 'chromium',
  DAEMON: 'daemon',
  VERSION: 'version',
  SESSIONS: 'sessions',
  /**
   * The agent-to-daemon hop, which every other row here is blind to.
   *
   * Reported from the field: a user with the SDK injected, the overlay visible, a live session on
   * the daemon and every tool listed in their client was still told by three separate agents that
   * Reticle was not present. Their words: "four green checkmarks that don't add up to a working
   * verification." Every row in this list checks a COMPONENT; none checked a LINK.
   */
  AGENT_LINK: 'agent link',
  BRIDGE_PORT: 'bridge port',
  PORT_CHECK: 'port check',
  SIBLING: 'sibling',
  DAEMON_LOG: 'daemon log',
  TRACING: 'tracing',
  DESKTOP: 'desktop',
} as const;

type DoctorRowLabel = (typeof DoctorRow)[keyof typeof DoctorRow];

export const DOCTOR_ROW_LABELS: readonly DoctorRowLabel[] = Object.values(DoctorRow);

/** Indent every row carries, before the label. */
const INDENT = '  ';

/**
 * Width the label column pads to.
 *
 * Derived from the longest label rather than hardcoded, so adding a longer row realigns the whole
 * checklist instead of breaking one line of it. With the current set the longest is `bridge port`
 * (11), so this is 13 — byte-identical to the hand-padding it replaces. A test pins that, so a
 * change to the column is a deliberate, visible change rather than an invisible reflow.
 */
export const LABEL_COLUMN =
  DOCTOR_ROW_LABELS.reduce((widest, label) => Math.max(widest, label.length), 0) + 2;

/** Build one `doctor` row: the standard indent, the label padded to the column, then `rest`. */
export function doctorRow(label: DoctorRowLabel, rest: string): string {
  return `${INDENT}${label.padEnd(LABEL_COLUMN)}${rest}`;
}
