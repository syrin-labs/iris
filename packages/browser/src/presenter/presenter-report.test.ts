import { describe, expect, it } from 'vitest';
import { emptyImpactCounts, emptyImpactRecords, estimateImpactSavings } from '@reticlehq/core';
import type { ImpactDefect, ImpactScope, ImpactSnapshot } from '@reticlehq/core';
import { PresenterReport, reportBodyHtml, reportPanelHtml } from './presenter-report.js';
import {
  buildLinkedInShareUrl,
  buildShareText,
  buildXShareUrl,
  compactDuration,
  compactNumber,
} from './presenter-report-copy.js';

function scope(
  over: Partial<ReturnType<typeof emptyImpactCounts>> = {},
  defects: ImpactDefect[] = [],
): ImpactScope {
  const counts = { ...emptyImpactCounts(), ...over };
  return {
    counts,
    days: [{ date: '2026-08-20', counts }],
    records: { ...emptyImpactRecords(), longestRunMs: 92_000 },
    savings: estimateImpactSavings(counts),
    since: 0,
    defects,
  };
}

const defect = (over: Partial<ImpactDefect> = {}): ImpactDefect => ({
  at: 1,
  title: 'Sign In',
  ...over,
});

describe('the impact report', () => {
  it('leads with what it refused to pass, and shows unknowns rather than hiding them', () => {
    const html = reportBodyHtml(
      scope({ calls: 40, verdicts: 12, passed: 9, failed: 2, unknown: 1 }),
    );
    // Not "defects caught": a failed verdict is equally the shape of a wrong assertion, and a
    // verification tool must not overclaim in that direction. What is true of both is that Reticle
    // refused to pass them.
    expect(html).toContain('refused to pass');
    expect(html).toContain('unknown');
  });

  /**
   * An estimate may not pass for a count. The report labels it and carries the comparison it was
   * measured against, because a saving without its denominator is a slogan.
   */
  it('labels every estimate and keeps its basis on the element', () => {
    const html = reportBodyHtml(scope({ calls: 10, verdicts: 6, failed: 2, tokensReturned: 500 }));
    expect(html).toContain('estimate');
    expect(html).toContain('vs an agent reading the app through screenshots');
    expect(html).toContain('vs one re-prompt cycle per defect caught');
  });

  it('says nothing at all before anything has been recorded', () => {
    expect(reportBodyHtml(scope())).toContain('Nothing recorded yet');
  });
});

/**
 * The only place the product tells an unlinked user a dashboard exists.
 *
 * Before this, every dashboard mention in the HUD was gated on `dashboardUrl`, which is read from a
 * repo's cloud.json — so the person who had never linked, the only one who needed telling, was the
 * one person never told. The rest of these tests exist because the fix for that is one line away
 * from being a nag, and a nag in a verification tool costs more trust than the conversion is worth.
 */
describe('what an UNLINKED user is told about the dashboard', () => {
  const withVerdicts = scope({ calls: 40, verdicts: 12, passed: 9, failed: 2, unknown: 1 });

  it('names the one command, once, when there is a record worth keeping', () => {
    const html = reportBodyHtml(withVerdicts);
    expect(html).toContain('This record stops at this machine.');
    expect(html).toContain('reticle login');
    // Once. A second mention in the same panel is where a line becomes a nag.
    expect(html.split('reticle login').length - 1).toBe(1);
  });

  it('goes silent the moment the repo is linked', () => {
    // A linked user is already reporting; telling them to log in is noise that reads as a bug.
    const html = reportBodyHtml(withVerdicts, 'https://app.reticle.sh/o/acme');
    expect(html).not.toContain('This record stops at this machine.');
  });

  it('offers nothing when there is nothing yet to keep', () => {
    // Gated on a VERDICT, not on tool calls: somebody who has driven the app but proved nothing has
    // not yet received the thing this offers to preserve, and an offer to keep nothing is an advert.
    expect(reportBodyHtml(scope({ calls: 40 }))).not.toContain(
      'This record stops at this machine.',
    );
    expect(reportBodyHtml(scope())).not.toContain('This record stops at this machine.');
  });
});

/**
 * The public card is a different audience from the private report.
 *
 * Estimated savings are the most-mocked class of number in AI tooling, and a percentile without a
 * denominator gets called misleading - so the post carries what the user's own setup CAUGHT, and
 * publishes its unknowns.
 */
describe('the share text', () => {
  it('leads with verdicts and defects, and never carries an estimate', () => {
    const text = buildShareText(scope({ verdicts: 217, failed: 9, unknown: 14 }), 'checkout-app');
    expect(text).toContain('217');
    expect(text).toContain('9 checks it refused to pass');
    expect(text).toContain('unknown');
    expect(text).toContain('checkout-app');
    expect(text).not.toMatch(/saved|estimate/i);
  });

  it('builds an X intent and a LinkedIn share that carry only what each platform accepts', () => {
    const x = buildXShareUrl('hello world');
    expect(x).toContain('twitter.com/intent/tweet');
    expect(x).toContain('text=hello+world');
    // No handle is configured, so none is claimed.
    expect(x).not.toContain('via=');
    // LinkedIn ignores every text parameter, so only the url is sent.
    expect(buildLinkedInShareUrl()).toBe(
      'https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Freticle.sh',
    );
  });

  it('formats numbers and durations the way a person reads them', () => {
    expect(compactNumber(940)).toBe('940');
    expect(compactNumber(4200)).toBe('4.2k');
    expect(compactNumber(2_400_000)).toBe('2.4M');
    expect(compactDuration(92_000)).toBe('1m');
    expect(compactDuration(7_500_000)).toBe('2h 5m');
  });
});

/**
 * The record arrives as a pushed command, so the panel must accept it the same way the state
 * machine accepts a presenter push - and must have something to show the moment it is opened.
 */
describe('the pushed impact record reaches the panel', () => {
  it('renders what the daemon pushed', async () => {
    document.body.innerHTML = '';
    const { Presenter } = await import('./presenter.js');
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const counts = { ...emptyImpactCounts(), calls: 9, verdicts: 4, passed: 3, failed: 1 };
    p.handlePush({
      name: 'impact',
      args: {
        snapshot: {
          schemaVersion: 1,
          projectName: 'demo',
          project: {
            counts,
            days: [{ date: '2026-08-20', counts }],
            records: { ...emptyImpactRecords(), streakDays: 2 },
            savings: estimateImpactSavings(counts),
            since: 0,
          },
          global: {
            counts,
            days: [],
            records: emptyImpactRecords(),
            savings: estimateImpactSavings(counts),
            since: 0,
          },
        },
      },
    });
    const btn = document.querySelector('[data-reticle-report-btn]');
    (btn as HTMLElement | null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const body = document.querySelector('[data-reticle-report-body]');
    expect(body?.textContent, 'the pushed record is what the panel shows').toContain(
      'refused to pass',
    );
    expect(body?.textContent).toContain('1');
    p.destroy();
  });
});

/**
 * Reading the report while the agent works is the whole point of it being live.
 *
 * The chat is opened by `expand`, which the agent triggers at session start - so routing that
 * through the same path a person uses closed the report every time the agent touched the app.
 */
describe('the report survives agent activity', () => {
  it('stays open while the agent drives, and yields when a person asks for the chat', async () => {
    document.body.innerHTML = '';
    const { Presenter } = await import('./presenter.js');
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const overlay = document.querySelector('div[data-reticle-overlay]');
    const btn = document.querySelector('[data-reticle-report-btn]');
    (btn as HTMLElement | null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-report'), 'the report is open').toBe('1');
    // The agent drives: a log row, a status, another session start - none of it is a dismissal.
    p.status('Clicking button "Deploy"');
    p.sessionStart();
    expect(overlay?.getAttribute('data-reticle-report'), 'agent activity leaves it alone').toBe(
      '1',
    );
    // A person asking for the chat does take the slot.
    document
      .querySelector('[data-reticle-chat-toggle]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-report'), 'the chat takes the slot back').toBe('0');
    p.destroy();
  });
});

/**
 * Three panels, one anchor: chat, settings and the report all hang above the toolbar, so opening
 * any of them from the toolbar has to clear the other two. Anything less stacks glass on glass.
 */
describe('the slot above the toolbar holds one panel', () => {
  it('each toolbar panel closes the others', async () => {
    document.body.innerHTML = '';
    const { Presenter } = await import('./presenter.js');
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const overlay = document.querySelector('div[data-reticle-overlay]');
    const click = (sel: string): void =>
      void document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click('[data-reticle-report-btn]');
    expect(overlay?.getAttribute('data-reticle-report')).toBe('1');
    click('[data-reticle-settings-btn]');
    expect(overlay?.getAttribute('data-reticle-settings'), 'settings opened').toBe('1');
    expect(overlay?.getAttribute('data-reticle-report'), 'settings closed the report').toBe('0');
    click('[data-reticle-report-btn]');
    expect(overlay?.getAttribute('data-reticle-report'), 'the report opened again').toBe('1');
    expect(overlay?.getAttribute('data-reticle-settings'), 'the report closed settings').toBe('0');
    click('[data-reticle-chat-toggle]');
    expect(overlay?.getAttribute('data-reticle-chat'), 'the chat opened').toBe('1');
    expect(overlay?.getAttribute('data-reticle-report'), 'the chat closed the report').toBe('0');
    p.destroy();
  });
});

/**
 * The lit icon says which panel is open, so it has to follow the panel and not the click.
 *
 * Set at click time, a button stayed lit after the panel it opened was closed by the next one:
 * two icons active over one panel.
 */
describe('the toolbar shows which panel is open', () => {
  it('lights exactly one toggle as panels replace each other', async () => {
    document.body.innerHTML = '';
    const { Presenter } = await import('./presenter.js');
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const click = (sel: string): void =>
      void document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const active = (sel: string): string | null =>
      document.querySelector(sel)?.getAttribute('data-active') ?? null;
    // The toolbar only exists once the HUD is expanded, which is how a person reaches these.
    click('[data-reticle-fab]');
    click('[data-reticle-chat-min]');
    click('[data-reticle-report-btn]');
    await Promise.resolve();
    expect(active('[data-reticle-report-btn]'), 'the report is lit').toBe('1');
    click('[data-reticle-settings-btn]');
    await Promise.resolve();
    expect(active('[data-reticle-settings-btn]'), 'settings is lit').toBe('1');
    expect(active('[data-reticle-report-btn]'), 'the report is not').toBe('0');
    click('[data-reticle-chat-toggle]');
    await Promise.resolve();
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-chat'), 'the chat opened').toBe('1');
    expect(active('[data-reticle-chat-toggle]'), 'the chat is lit').toBe('1');
    expect(active('[data-reticle-settings-btn]'), 'settings is not').toBe('0');
    p.destroy();
  });
});

/**
 * The toolbar has a fixed number of slots.
 *
 * Copy and Export arrive when a session ends, and the bar was already full - so the last icon
 * rendered outside the pill. They take the slots Pause and End vacate, since neither can act on a
 * session that has already ended.
 */
describe('the toolbar keeps its width when a session ends', () => {
  it('gives copy and export the slots that pause and end vacate', async () => {
    const { SHELL_CSS } = await import('./presenter-shell-styles.js');
    // jsdom applies no stylesheet, so the rule itself is the contract: on `ended`, the two controls
    // that can no longer act are hidden and the two run-artifact controls take their places. Without
    // this the bar carries eleven icons in a pill sized for nine and the last renders outside it.
    expect(SHELL_CSS).toContain(
      '[data-reticle-state="ended"] [data-reticle-hud] [data-reticle-pause]',
    );
    expect(SHELL_CSS).toContain(
      '[data-reticle-state="ended"] [data-reticle-hud] [data-reticle-end]',
    );
    expect(SHELL_CSS).toMatch(
      /\[data-reticle-state="ended"\][^{]*reticle-tb-btn--export\{display:inline-flex/,
    );
  });
});

/**
 * Pausing must not switch the HUD's colour off.
 *
 * Three rules predating the status theme forced `--reticle-accent` to a fixed grey on paused,
 * ended and waiting - so every lit control lost its colour the moment a session stopped, which is
 * exactly when someone is looking at the HUD to find out what happened.
 */
describe('paused and ended keep the status colour', () => {
  it('does not wash the accent out to a hard-coded grey', async () => {
    const { SHELL_CSS } = await import('./presenter-shell-styles.js');
    expect(SHELL_CSS, 'the old grey override is gone').not.toContain('--reticle-accent:#e5e5e5');
    expect(SHELL_CSS).not.toContain('--reticle-accent:#d4d4d4');
    expect(SHELL_CSS, 'the accent follows the state colour').toContain(
      '--reticle-accent:var(--reticle-state)',
    );
  });
});

/**
 * The short list of what broke.
 *
 * The hero number says HOW MANY; this says WHICH ONES, which is the difference between a statistic
 * and something a person can act on. The link is the only place the free tool points at the paid
 * one, so it must appear exactly when there IS one and never nag when there is not.
 */
describe('what broke', () => {
  it('names the defects, not just how many there were', () => {
    const html = reportBodyHtml(scope({ calls: 5, failed: 1 }, [defect({ title: 'Sign In' })]));
    expect(html).toContain('Sign In');
    expect(html).toContain('What broke');
  });

  it('shows the reason and the source line beside the name', () => {
    const html = reportBodyHtml(
      scope({ calls: 5, failed: 1 }, [
        defect({ detail: 'the route never changed', source: 'src/login.tsx:42' }),
      ]),
    );
    expect(html).toContain('the route never changed');
    expect(html).toContain('src/login.tsx:42');
  });

  it('escapes text that came from the app under test', () => {
    // The title is an element's accessible name — the CONTENT of somebody else's page, rendered
    // into this panel's innerHTML. It is the first app-derived string the report has ever shown.
    const html = reportBodyHtml(
      scope({ calls: 5, failed: 1 }, [defect({ title: '<img src=x onerror=alert(1)>' })]),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('shows NO link when the project is not linked to a workspace', () => {
    // The free tool is complete on its own. An unlinked project gets its list and no advertisement.
    const html = reportBodyHtml(scope({ calls: 5, failed: 1 }, [defect()]));
    expect(html).not.toContain('dashboard');
  });

  it('links to the dashboard when there is one', () => {
    const html = reportBodyHtml(
      scope({ calls: 5, failed: 1 }, [defect()]),
      'https://console.test/issues?project=web',
    );
    expect(html).toContain('https://console.test/issues?project=web');
    expect(html).toContain('Manage all of them on the dashboard');
  });

  it('counts the rest only when there IS a rest — 3 shown of 3 is not "and more"', () => {
    const three = [defect({ title: 'a' }), defect({ title: 'b' }), defect({ title: 'c' })];
    const exact = reportBodyHtml(scope({ calls: 9, failed: 3 }, three), 'https://console.test/i');
    expect(exact).not.toContain('(3)');
    const more = reportBodyHtml(scope({ calls: 9, failed: 40 }, three), 'https://console.test/i');
    expect(more).toContain('(40)');
  });

  it('renders nothing at all when nothing has broken', () => {
    const html = reportBodyHtml(scope({ calls: 5, passed: 5 }));
    expect(html).not.toContain('What broke');
  });
});

/**
 * The JOIN: a snapshot arriving from the daemon, through the real controller, into painted DOM.
 *
 * Every test above checks the render FUNCTION. This one mounts the panel the user actually opens,
 * hands it the shape the daemon really pushes, and reads what ends up on screen — because a correct
 * renderer wired to the wrong field paints nothing, and a function test cannot tell you that.
 *
 * It exists because this hop turned out to be the one an agent cannot drive: Reticle deliberately
 * hides its own presenter chrome from the tool surface, so `reticle_query` cannot see the toolbar
 * button and no verdict can be drawn against this panel. Mounted DOM is the strongest check left.
 */
describe('a snapshot from the daemon, painted', () => {
  const mountPanel = (): { root: HTMLElement; report: PresenterReport } => {
    const root = document.createElement('div');
    root.innerHTML = reportPanelHtml();
    document.body.appendChild(root);
    const report = new PresenterReport();
    report.mount(root);
    return { root, report };
  };

  const snapshotWith = (defects: ImpactDefect[], dashboardUrl?: string): ImpactSnapshot => ({
    schemaVersion: 1,
    project: scope({ calls: 12, verdicts: 4, passed: 2, failed: 2 }, defects),
    global: scope({ calls: 99, verdicts: 9, passed: 7, failed: 2 }, defects),
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
  });

  it('paints the defects the daemon sent into the open panel', () => {
    const { root, report } = mountPanel();
    report.setSnapshot(
      snapshotWith([
        { at: 1, title: 'Sign in', detail: "expected '/billing'", source: 'src/Login.tsx:81' },
      ]),
    );
    report.open();
    const body = root.querySelector('[data-reticle-report-body]')?.textContent ?? '';
    expect(body).toContain('Sign in');
    expect(body).toContain("expected '/billing'");
    expect(body).toContain('src/Login.tsx:81');
  });

  it('renders the link as a real anchor pointing at the dashboard', () => {
    const { root, report } = mountPanel();
    report.setSnapshot(snapshotWith([{ at: 1, title: 'Sign in' }], 'https://console.test/issues'));
    report.open();
    const link = root.querySelector<HTMLAnchorElement>('.reticle-report-defects-more');
    expect(link?.getAttribute('href')).toBe('https://console.test/issues');
    // Opening someone else's origin from inside their app: both, or the new tab can reach back.
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('paints no link at all when the project is not linked', () => {
    const { root, report } = mountPanel();
    report.setSnapshot(snapshotWith([{ at: 1, title: 'Sign in' }]));
    report.open();
    expect(root.querySelector('.reticle-report-defects-more')).toBeNull();
  });

  it('escapes app-derived text on the way into the live DOM, not just in the string', () => {
    const { root, report } = mountPanel();
    report.setSnapshot(snapshotWith([{ at: 1, title: '<img src=x onerror=alert(1)>' }]));
    report.open();
    // The payload must have landed as TEXT: no element created, and the characters still readable.
    expect(root.querySelector('.reticle-report-defects img')).toBeNull();
    expect(root.querySelector('.reticle-report-defect-title')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('repaints in place when a later snapshot arrives while the panel is open', () => {
    // The daemon pushes on every tool call, so a panel left open must follow the record rather than
    // freeze on whatever it held when it was opened.
    const { root, report } = mountPanel();
    report.setSnapshot(snapshotWith([{ at: 1, title: 'first' }]));
    report.open();
    report.setSnapshot(
      snapshotWith([
        { at: 2, title: 'second' },
        { at: 1, title: 'first' },
      ]),
    );
    const body = root.querySelector('[data-reticle-report-body]')?.textContent ?? '';
    expect(body).toContain('second');
  });

  it('switches to the machine-wide scope when the toggle is pressed', () => {
    const { root, report } = mountPanel();
    report.setSnapshot(snapshotWith([{ at: 1, title: 'Sign in' }]));
    report.open();
    root.querySelector<HTMLButtonElement>('[data-reticle-report-scope]')?.click();
    const body = root.querySelector('[data-reticle-report-body]')?.textContent ?? '';
    expect(body).toContain('Sign in');
  });
});
