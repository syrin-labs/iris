import { span } from '../trace.js';
import {
  ActionType,
  CRAWL_DEFAULTS,
  CrawlAnomalyKind,
  DANGEROUS_ACTION_CONFIRM_ARG,
  EventType,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { crawlEmptyNote } from './crawl-empty.js';
import {
  parseInteractive,
  asRecord,
  asNumber,
  asString,
  sourceOf,
} from '../tools/tools-helpers.js';
import { ReticleTool } from '../tools/tool-names.js';
import { findContradictions } from '../events/contradictions.js';

/** The slice of Session the crawler needs — so tests inject a fake without a live browser. */
export interface CrawlSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  elapsed(): number;
  eventsSince(cursor: number): ReticleEvent[];
  /**
   * Which document is on screen now, so a finding is never drawn from a page the crawl has already
   * navigated away from. Optional for the same reason `beginAction` is: a test fake supplies a
   * minimal session, and its absence leaves the scoping inert rather than broken.
   */
  readonly currentDocumentId?: string | undefined;
  /** Which round of source edits is in force, so a finding drawn entirely from pre-edit evidence
   *  says so. Optional for the same reason `currentDocumentId` is. */
  readonly currentEditEpoch?: number | undefined;
  /** The page under test, so a third-party beacon cannot be reported against a control. Optional
   *  for the same reason `currentDocumentId` is. */
  readonly url?: string | undefined;
  /**
   * Attribution window around each click. Optional so a caller can supply a minimal session, but a real
   * session MUST provide it: without a window the click's own effects carry no actionId, and an
   * unattributed ref-bearing event is learned as ambient background churn. A crawl clicks up to 25
   * controls, so it can single-handedly teach the settle oracle to ignore the regions the app actually
   * reacts in — turning a later `{kind:"settled"}` into a false green.
   */
  beginAction?(tool: string, args: Record<string, unknown>): void;
  finishAction?(error?: string, settled?: boolean, settleMs?: number): void;
}

type CrawlSleep = (ms: number) => Promise<void>;

export interface CrawlAnomaly {
  /**
   * A single-channel fault (something bad in one stream) or a CONTRADICTION (two channels
   * disagreeing about the same click). The second kind is why an autonomous crawl is worth more
   * than a human clicking the same buttons: a person sees only the screen, so a UI that advanced
   * while its write failed looks like success to them and always will.
   *
   * `CrawlAnomalyKind` and `ContradictionKind` are what THIS package puts here, and both are still
   * enforced at the emit sites below. The type is a plain string because a rule registered by a
   * consumer contributes kinds this package has never heard of, and a closed union here would mean
   * a consumer's private vocabulary had to ship in the free product to be reportable.
   */
  kind: string;
  /** The control that triggered it. */
  ref: string;
  desc: string;
  detail: string;
  /**
   * Where the control is written, as `file:line`.
   *
   * A crawl reports problems across a whole app, so it is the output most likely to be read as a
   * work list — and "e42 does nothing" is a work list item that starts with a search. The location
   * comes free: the crawl already clicks each control, and an act result carries the source captured
   * alongside its anchor. Absent in production builds and apps without the build plugin.
   */
  source?: string;
}

/** Said out loud when the page was larger than one snapshot, so a clean sweep cannot mean "all clear". */
export const CAPPED_SNAPSHOT_NOTE =
  'the page exceeded one snapshot, so controls past the cap were never seen — interactiveFound is a floor, not a total; re-run with a narrower `scope` to cover the rest';

/**
 * Said out loud when the crawl's OWN clicks put controls on the page that it then never visited.
 *
 * The enumeration happens once, before the first click, so a control that only exists after a login,
 * a modal or a tab switch is invisible to this run. Measured on the bench app: a crawl of the login
 * screen visited three controls, its click on "Sign in" produced seven more, and it returned
 * `truncated: false` with an empty anomaly list and nine of twelve steps unused. Read as a sweep,
 * that is a clean bill of health for an app the crawl never entered.
 *
 * The same words as the capped-snapshot case on purpose — it is the same idea (interactiveFound is a
 * floor) reached by a different route, and a second vocabulary for it would just be more to learn.
 */
function revealedControlsNote(count: number): string {
  return (
    `the page changed as you clicked: ${String(count)} control(s) that did not exist when this crawl ` +
    'started were never visited — interactiveFound is a floor, not a total; re-run the crawl from ' +
    'the state you are now in to cover them'
  );
}

export interface CrawlReport {
  interactiveFound: number;
  stepsRun: number;
  anomalies: CrawlAnomaly[];
  counts: {
    consoleErrors: number;
    failedRequests: number;
    deadControls: number;
    contradictions: number;
  };
  /** Descriptions of the controls actually clicked. */
  visited: string[];
  /** True when coverage was bounded — by the step budget, or by the page exceeding one snapshot. */
  truncated: boolean;
  /** Present only when the snapshot itself was capped, i.e. controls exist that were never listed. */
  coverageNote?: string;
}

export interface CrawlOptions {
  maxSteps?: number;
  settleMs?: number;
  scope?: string;
  confirmDangerous?: boolean;
}

/** Any buffer event that proves the app reacted to a click (vs a dead/no-op control). */
function isActivity(e: ReticleEvent): boolean {
  return (
    e.type === EventType.NET_REQUEST ||
    e.type === EventType.DOM_ADDED ||
    e.type === EventType.DOM_REMOVED ||
    e.type === EventType.DOM_ATTR ||
    e.type === EventType.DOM_TEXT ||
    e.type === EventType.ROUTE_CHANGE ||
    e.type === EventType.SIGNAL ||
    e.type === EventType.ANIM_START ||
    e.type === EventType.ANIM_END
  );
}

function isConsoleError(e: ReticleEvent): boolean {
  return e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT;
}

function failedRequests(events: ReticleEvent[], floor: number): ReticleEvent[] {
  return events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST) return false;
    const status = asNumber(e.data['status']);
    return status !== undefined && status >= floor;
  });
}

/**
 * The autonomous "smart monkey". Discovers every reachable interactive control once,
 * then clicks each (bounded by maxSteps) and classifies the reaction into anomalies — console
 * errors, failed requests, and DEAD controls (dispatched but the app did nothing). Pure
 * orchestration over a CrawlSession: no browser/Node imports, fully unit-testable with a fake.
 * Single-pass by design (no re-discovery) so it always terminates and never explodes on navigation.
 */

/**
 * Controls whose correct behaviour IS to do nothing when clicked.
 *
 * Read off the same descriptor the crawler already has, so no extra round trip: `[disabled]` is inert
 * by definition, an already `[checked]` radio/checkbox is idempotent, and clicking a text field
 * focuses it rather than changing anything.
 */
export function legitimatelyInert(desc: string): boolean {
  if (desc.includes('[disabled]')) return true;
  if (desc.includes('[checked]')) return true;
  // Inputs, and the ARIA LIVE-REGION roles.
  //
  // `alert`, `status`, `log`, `timer` and `marquee` exist to be READ — a screen reader announces
  // them and nothing is meant to happen when one is clicked. Clicking twice and seeing nothing is
  // therefore correct behaviour, and reporting it as `dead-control` accuses a working app.
  //
  // Found by driving a real app: the demo reported `dead-control — alert "Invalid email or
  // password"`, which is a login form correctly telling somebody their password was wrong. That is
  // the most expensive kind of false positive there is — the strongest claim the crawler makes,
  // about an app that was working, and on the path a new user meets first.
  //
  // `alertdialog` is deliberately NOT here: it is interactive, and a word boundary keeps it out.
  return /\b(textbox|searchbox|combobox|spinbutton|alert|status|log|timer|marquee)\b/.test(desc);
}

/**
 * How many interactive controls exist now that did not exist when the crawl enumerated.
 *
 * Keyed on ref, which is the element's identity: a control that re-rendered keeps its ref and is not
 * new, and one that vanished simply does not appear. Returns 0 rather than throwing if the snapshot
 * fails — this is a disclosure, and failing the whole crawl to report on coverage would be worse
 * than the silence it is fixing.
 */
async function countRevealed(
  session: CrawlSession,
  opts: CrawlOptions,
  before: ReadonlyArray<{ ref: string; desc: string }>,
): Promise<number> {
  const snap = await session.command(ReticleCommand.SNAPSHOT, {
    mode: 'interactive',
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  if (!snap.ok) return 0;
  const tree = ((snap.result ?? {}) as { tree?: string }).tree ?? '';
  const known = new Set(before.map((i) => (i.ref !== '' ? i.ref : i.desc)));
  return parseInteractive(tree).filter((i) => !known.has(i.ref !== '' ? i.ref : i.desc)).length;
}

/**
 * The confirmation half of the dead-control rule. Kept separate so the rule above reads as one
 * question, and so the second click gets its own window: reusing the first would let the first
 * click's own (absent) activity decide the second, which is not a second sample at all.
 *
 * `true` means "silent both times" — the only state the anomaly is reported in. Anything that goes
 * wrong here returns `false`: a confirmation that cannot run is not evidence, and the direction that
 * costs a missed finding is better than the one that invents one.
 */
async function stillSilent(
  session: CrawlSession,
  item: { ref: string; desc: string },
  settleMs: number,
  opts: { confirmDangerous?: boolean },
  sleep: CrawlSleep,
): Promise<boolean> {
  const since = session.elapsed();
  session.beginAction?.(ReticleTool.CRAWL, { ref: item.ref, action: ActionType.CLICK });
  try {
    const again = await session.command(ReticleCommand.ACT, {
      ref: item.ref,
      action: ActionType.CLICK,
      args: true === opts.confirmDangerous ? { [DANGEROUS_ACTION_CONFIRM_ARG]: true } : {},
    });
    await sleep(settleMs);
    // A control that has GONE (the first click removed it) is not a dead control — it did something.
    if (!again.ok || false === asRecord(again.result)['dispatched']) return false;
    return !session.eventsSince(since).some(isActivity);
  } catch {
    return false;
  } finally {
    session.finishAction?.();
  }
}

export async function crawl(
  session: CrawlSession,
  opts: CrawlOptions,
  sleep: CrawlSleep,
): Promise<CrawlReport> {
  const maxSteps = opts.maxSteps ?? CRAWL_DEFAULTS.MAX_STEPS;
  const settleMs = opts.settleMs ?? CRAWL_DEFAULTS.SETTLE_MS;

  const snap = await session.command(ReticleCommand.SNAPSHOT, {
    mode: 'interactive',
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  const snapshot = snap.ok ? ((snap.result ?? {}) as { tree?: string; truncated?: boolean }) : {};
  const tree = snapshot.tree ?? '';
  const items = parseInteractive(tree);
  // The snapshot walk stops at its node cap and returns a DOCUMENT-ORDER PREFIX, so on a large page
  // the controls it never reached are not merely unclicked — they were never seen. Reporting
  // `interactiveFound` without this would state a control count that is really a cap, and
  // `truncated:false` would positively assert that nothing was cut.
  const coverageCapped = true === snapshot.truncated;

  const anomalies: CrawlAnomaly[] = [];
  const visited: string[] = [];
  const counts = { consoleErrors: 0, failedRequests: 0, deadControls: 0, contradictions: 0 };
  const seen = new Set<string>();

  let stepsRun = 0;
  for (const item of items) {
    if (stepsRun >= maxSteps) break;
    // Dedupe by ref (the unique element), not by label — two "Delete"/"Edit" controls share a desc
    // but are different controls; collapsing them by label under-covers list/table UIs.
    const dedupeKey = item.ref !== '' ? item.ref : item.desc;
    if (seen.has(dedupeKey)) continue; // don't re-click the same control
    seen.add(dedupeKey);
    stepsRun += 1;
    visited.push(item.desc);

    const since = session.elapsed();
    session.beginAction?.(ReticleTool.CRAWL, { ref: item.ref, action: ActionType.CLICK });
    let act;
    try {
      // One span per control clicked, so a slow crawl names the control rather than reporting a
      // single multi-second total. The settle sleep below is INSIDE it deliberately: it is part of
      // what a step costs, and hiding it would make the fixed budget look free.
      act = await span('crawl.step', { ref: item.ref, desc: item.desc }, async () => {
        const clicked = await session.command(ReticleCommand.ACT, {
          ref: item.ref,
          action: ActionType.CLICK,
          args: true === opts.confirmDangerous ? { [DANGEROUS_ACTION_CONFIRM_ARG]: true } : {},
        });
        await sleep(settleMs);
        return clicked;
      });
    } finally {
      // Close on every exit so a throw cannot leak the window onto the next control's events.
      session.finishAction?.();
    }
    const events = session.eventsSince(since);
    // Captured at act time, so it survives a click that unmounts its own control.
    const src = sourceOf(asRecord(act?.result)['source']);
    const source = src === undefined ? {} : { source: `${src.file}:${String(src.line)}` };

    const errs = events.filter(isConsoleError);
    for (const e of errs) {
      counts.consoleErrors += 1;
      anomalies.push({
        kind: CrawlAnomalyKind.CONSOLE_ERROR,
        ref: item.ref,
        desc: item.desc,
        detail: asString(e.data['message']) ?? e.type,
        ...source,
      });
    }

    for (const e of failedRequests(events, CRAWL_DEFAULTS.FAILED_STATUS)) {
      counts.failedRequests += 1;
      const method = asString(e.data['method']) ?? '';
      const url = asString(e.data['url']) ?? '';
      const status = asNumber(e.data['status']);
      anomalies.push({
        kind: CrawlAnomalyKind.FAILED_REQUEST,
        ref: item.ref,
        desc: item.desc,
        detail: `${method} ${url} → ${status ?? ''}`.trim(),
        ...source,
      });
    }

    // CONTRADICTIONS: the channels disagree about what this click did. Reported per control, so a
    // crawl of an unknown app surfaces its false greens without anyone knowing where to look.
    // A crawl clicks controls that navigate, so its windows are the ones most likely to straddle a
    // document boundary — and a finding here is reported against a specific control by name.
    for (const c of findContradictions(events, {
      currentDocumentId: session.currentDocumentId,
      currentEditEpoch: session.currentEditEpoch,
      appOrigin: session.url,
      // The crawl's window IS one control's click, so it can name the floor the consequence rules
      // need — without it a crawl would report nothing about the UI moving, which is most of what a
      // crawl is for.
      actionSince: since,
    })) {
      counts.contradictions += 1;
      anomalies.push({
        kind: c.kind,
        ref: item.ref,
        desc: item.desc,
        detail: `${c.claim}, but ${c.counter} — ${c.detail}`,
        ...source,
      });
    }

    // DEAD: the click dispatched but the app produced no activity and no error to explain it.
    //
    // Unless the control is SUPPOSED to be inert. Measured on a shipments console: every one of the
    // crawler's three anomalies was a control behaving correctly — a `[disabled]` button, an already
    // `[checked]` radio, and a text input (a click focuses it; mutating would be the surprise). An
    // anomaly list that is 100% false on a real app is worse than no anomaly list, because the agent
    // spends its budget disproving it and learns to skip the field.
    //
    // Deliberately NOT fixed by counting focus as activity: focus moving is not the app reacting, and
    // treating it as such would make a genuinely dead button that takes focus look alive — trading
    // noise for the false negative this check exists to catch.
    const dispatched = asRecord(act.result)['dispatched'] !== false && act.ok;
    if (
      dispatched &&
      0 === errs.length &&
      !events.some(isActivity) &&
      !legitimatelyInert(item.desc)
    ) {
      // CONFIRM IT. One silent sample is a sample, not a fact, and this is the strongest claim the
      // crawler makes — "your button does nothing" is the finding a reader acts on immediately.
      //
      // Measured on a fixture whose FIXED twin has a working primary CTA: the crawl reported it dead
      // on 2 of 3 runs, always a control the drive had already clicked successfully moments earlier.
      // A false positive in this tier is the most expensive kind there is — it is the tier a verdict
      // is built from, and the twin column is the whole claim this product makes.
      //
      // A second click costs one round trip on the rare control that looked dead, and nothing at all
      // on every control that did not. A genuinely dead control is silent twice; the flake is not.
      if (await stillSilent(session, item, settleMs, opts, sleep)) {
        counts.deadControls += 1;
        anomalies.push({
          kind: CrawlAnomalyKind.DEAD_CONTROL,
          ref: item.ref,
          desc: item.desc,
          detail:
            'clicked TWICE and the app did nothing either time (no DOM/network/route/signal change)',
          ...source,
        });
      }
    }
  }

  // One more look, AFTER the clicks. The enumeration above happened before any of them, so anything
  // the crawl itself unlocked — a dashboard behind a login, a modal's contents, a tab's panel — was
  // never in `items` and never had a chance to be visited. Counted by ref against what was
  // enumerated, so a control that merely moved or re-rendered under the same ref is not miscounted
  // as new, and a surface that SHRANK (a modal closed) reports nothing, because nothing went
  // unvisited. Skipped when the snapshot was already capped: that case has its own note and a second
  // one would only muddy it.
  const revealed = coverageCapped ? 0 : await countRevealed(session, opts, items);

  return {
    interactiveFound: items.length,
    stepsRun,
    anomalies,
    counts,
    visited,
    // True when coverage was bounded for EITHER reason: the step budget ran out, or the page was
    // bigger than one snapshot. Conflating "I stopped early" with "I saw everything" is what turns a
    // partial sweep into "all controls healthy".
    truncated: items.length > stepsRun || coverageCapped || revealed > 0,
    ...(coverageCapped
      ? { coverageNote: CAPPED_SNAPSHOT_NOTE }
      : revealed > 0
        ? { coverageNote: revealedControlsNote(revealed) }
        : {}),
    // A bare `stepsRun: 0` made "the page had no controls" and "it had 34 and none were clicked" the
    // same answer. See crawl-empty.
    ...(() => {
      const note = crawlEmptyNote({
        interactiveFound: items.length,
        stepsRun,
        maxSteps,
        truncated: coverageCapped,
      });
      return note === undefined ? {} : { note };
    })(),
  };
}
