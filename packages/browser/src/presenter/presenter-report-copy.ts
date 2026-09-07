import { ImpactSnapshotSchema, type ImpactScope, type ImpactSnapshot } from '@reticlehq/core';

/**
 * What the report SAYS, kept away from how it looks.
 *
 * The wording here is the product's only claim about its own worth, so it is written once, in one
 * place, and tested. Two audiences, two registers:
 *
 *  - The REPORT is private. It is the user's own data, so it can carry everything, estimates
 *    included, as long as each estimate shows what it is measured against.
 *  - The SHARE card is public, and the research on developer stat-cards is blunt about what happens
 *    to a public card that leads with vendor savings: estimated token/time savings are the most
 *    mocked class of number in AI tooling (JetBrains measured ~10% against a viral 65% claim), and
 *    percentiles without a denominator get called misleading. So the card leads with what the
 *    user's own setup CAUGHT, and publishes its unknowns - the credibility move, and the thing a
 *    scoreboard would never do.
 */

/** Reticle's own links, as they appear in the report footer. */
export const REPORT_LINKS = {
  DOCS: 'https://docs.reticle.sh',
  SITE: 'https://reticle.sh',
  GITHUB: 'https://github.com/reticlehq/reticle',
  DISCORD: 'https://discord.gg/BwAbzv9ZRz',
} as const;

/**
 * The X handle used for `via=` on a share.
 *
 * Empty until somebody who owns the account fills it in, and the share URL omits the parameter
 * while it is - a guessed handle credits a stranger, and there is no way for code to know.
 */
export const SHARE_VIA_HANDLE = '';

export const REPORT_TEXT = {
  TITLE: 'Impact',
  PROJECT: 'This project',
  GLOBAL: 'Everything on this machine',
  /**
   * What `counts.failed` actually is: a verdict whose declared consequence did not hold.
   *
   * It used to read "defects caught before you saw them", which overclaims in the one direction a
   * verification tool must never overclaim. A failed verdict is not proof of a defect in the app —
   * it is equally the shape of an assertion that was wrong. Measured in the field: an agent
   * asserted a clean console on an app with ordinary dev-mode logging, the verdict went red, and
   * the panel reported a defect nobody had found.
   *
   * The honest word is what Reticle DID: it refused to pass them. That is true of the assertion
   * error and the real bug alike, and it still reads as the tool having done its job.
   */
  HERO_DEFECTS: 'checks Reticle refused to pass',
  VERDICTS: 'Verdicts',
  PASSED: 'passed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  UNKNOWN_HELP:
    'Reticle drove the app and could not tell what happened. Not a pass - shown, not hidden.',
  CALLS: 'Tool calls',
  TOKENS: 'Tokens returned',
  DRIVING: 'Time driving',
  SESSIONS: 'Sessions',
  STREAK: 'day streak',
  LONGEST: 'Longest run',
  SAVED_TOKENS: 'Tokens saved',
  SAVED_MINUTES: 'Time saved',
  ESTIMATE_TAG: 'estimate',
  CHART: 'Verdicts, last 30 days',
  DEFECTS: 'What broke',
  DEFECTS_MORE: 'Manage all of them on the dashboard',
  /**
   * What an UNLINKED user is told, and the only place the product tells them.
   *
   * The dashboard link renders only when `dashboardUrl` exists, which means only once a repo is
   * already linked — so the person most likely to want one, watching this record climb on their own
   * machine, was never told it existed. The single mention anywhere else is a daemon log line.
   *
   * Stated as a FACT about where the record lives, not as a pitch. It sits at the foot of a panel
   * somebody opened on purpose, so it informs rather than interrupts, and it appears only once
   * there is a verdict worth keeping — an offer to preserve nothing is just an advert.
   */
  LOCAL_ONLY: 'This record stops at this machine.',
  LOCAL_ONLY_ACTION: 'reticle login',
  LOCAL_ONLY_TAIL: 'keeps it, and lets a team see it.',
  DEFECTS_NONE: 'Nothing has failed a declared consequence yet.',
  EMPTY: 'Nothing recorded yet. Drive the app once and this fills in.',
  SHARE: 'Share',
  COPY: 'Copy',
  COPIED: 'Copied',
  REFER: 'Send to a friend',
} as const;

/** "4.2k", "1.3M" - a number a person reads at a glance rather than counts digits in. */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** "2h 14m", "47m", "38s" - the same duration vocabulary the activity strip uses. */
export function compactDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  return 0 === m % 60 ? `${String(h)}h` : `${String(h)}h ${String(m % 60)}m`;
}

/**
 * The post itself.
 *
 * Leads with defects caught, then the verdict split INCLUDING unknowns, then the superlative. No
 * estimated savings, no percentile, no leaderboard: those are the four things the evidence says get
 * a dev-tool card mocked rather than shared.
 */
export function buildShareText(scope: ImpactScope, projectName?: string): string {
  const c = scope.counts;
  const where = projectName !== undefined && projectName.length > 0 ? ` on ${projectName}` : '';
  const lines = [
    `My agent verified its own work ${String(c.verdicts)} times${where}.`,
    `${String(c.failed)} checks it refused to pass before I looked at any of them.`,
  ];
  if (c.unknown > 0) {
    lines.push(
      `${String(c.unknown)} came back "unknown" - it drove the app and could not tell. That is the number I watch.`,
    );
  }
  if (scope.records.longestRunMs > 0) {
    lines.push(`Longest unattended run: ${compactDuration(scope.records.longestRunMs)}.`);
  }
  return lines.join('\n');
}

/** X share intent. `via` is omitted while no handle is configured. */
export function buildXShareUrl(text: string): string {
  const params = new URLSearchParams({ text, url: REPORT_LINKS.SITE });
  if (SHARE_VIA_HANDLE.length > 0) params.set('via', SHARE_VIA_HANDLE);
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

/**
 * LinkedIn share.
 *
 * `share-offsite` takes a url and NOTHING else - the title/summary parameters were deprecated in
 * 2018 and are ignored, so the caption has to reach the composer some other way. The report copies
 * it to the clipboard before opening this, which is the only path that works without asking the
 * user for posting permissions.
 */
export function buildLinkedInShareUrl(): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(REPORT_LINKS.SITE)}`;
}

/** What a referral says: the tool, not the sender's numbers. */
export function buildReferralText(): string {
  return `I have been verifying my agent's work from inside the running app with Reticle - it returns pass/fail with the file:line to fix. ${REPORT_LINKS.SITE}`;
}

/** Narrow an unknown push payload to a snapshot. Invalid shapes are ignored, never rendered. */
export function parseImpactSnapshot(value: unknown): ImpactSnapshot | undefined {
  const parsed = ImpactSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
