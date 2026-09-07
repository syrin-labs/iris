/**
 * The HUD's defect list, driven with hostile input.
 *
 * This panel renders text that came from the APP UNDER TEST — an element's accessible name, a
 * verdict's failure reason — into an HTML string, inside somebody else's page. It is the one part of
 * Reticle where the content is not ours, so every interesting case is about what happens when that
 * content is not what we assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyImpactCounts,
  emptyImpactRecords,
  estimateImpactSavings,
  IMPACT_DEFECT_LIMIT,
} from '@reticlehq/core';
import type { ImpactDefect, ImpactScope, ImpactSnapshot } from '@reticlehq/core';
import { PresenterReport, reportBodyHtml, reportPanelHtml } from './presenter-report.js';

const scope = (defects: ImpactDefect[]): ImpactScope => {
  const counts = { ...emptyImpactCounts(), calls: 10, failed: defects.length };
  return {
    counts,
    days: [{ date: '2026-08-26', counts }],
    records: emptyImpactRecords(),
    savings: estimateImpactSavings(counts),
    since: 0,
    defects,
  };
};

const defect = (over: Partial<ImpactDefect> = {}): ImpactDefect => ({
  at: 1,
  title: 'Sign In',
  ...over,
});

const mount = (): { root: HTMLElement; report: PresenterReport } => {
  const root = document.createElement('div');
  root.innerHTML = reportPanelHtml();
  document.body.appendChild(root);
  const report = new PresenterReport();
  report.mount(root);
  return { root, report };
};

const snapshot = (defects: ImpactDefect[], dashboardUrl?: string): ImpactSnapshot => ({
  schemaVersion: 1,
  project: scope(defects),
  global: scope(defects),
  ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
});

const painted = (defects: ImpactDefect[], dashboardUrl?: string): HTMLElement => {
  const { root, report } = mount();
  report.setSnapshot(snapshot(defects, dashboardUrl));
  report.open();
  return root;
};

describe('text from the app under test is never markup', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    "'; DROP TABLE flows;--",
    '</span><iframe src=javascript:alert(1)>',
    '<style>body{display:none}</style>',
  ];

  for (const payload of payloads) {
    it(`renders ${payload.slice(0, 22)} as text`, () => {
      const root = painted([defect({ title: payload })]);
      expect(root.querySelector('.reticle-report-defects img')).toBeNull();
      expect(root.querySelector('.reticle-report-defects script')).toBeNull();
      expect(root.querySelector('.reticle-report-defects iframe')).toBeNull();
      expect(root.querySelector('.reticle-report-defects svg')).toBeNull();
      expect(root.querySelector('.reticle-report-defect-title')?.textContent).toBe(payload);
    });
  }

  it('escapes the DETAIL as well as the title', () => {
    const root = painted([defect({ detail: '<img src=x onerror=alert(1)>' })]);
    expect(root.querySelector('.reticle-report-defects img')).toBeNull();
    expect(root.querySelector('.reticle-report-defect-detail')?.textContent).toContain('<img');
  });

  it('escapes the SOURCE line, which is the app’s own build output', () => {
    const root = painted([defect({ source: '<img src=x onerror=alert(1)>:1' })]);
    expect(root.querySelector('.reticle-report-defects img')).toBeNull();
  });

  it('does not let a payload break out of the panel and eat the page', () => {
    const root = painted([defect({ title: '</div></div><h1>OWNED</h1>' })]);
    expect(root.querySelector('h1')).toBeNull();
  });

  it('cannot smuggle an attribute onto the surrounding element', () => {
    const root = painted([defect({ title: '" onmouseover="alert(1)' })]);
    const el = root.querySelector('.reticle-report-defect-title');
    expect(el?.getAttribute('onmouseover')).toBeNull();
    expect(el?.textContent).toBe('" onmouseover="alert(1)');
  });
});

describe('the link out is not a way to run code', () => {
  it('renders NO link at all for a javascript: url', () => {
    // A dashboardUrl comes from cloud.json — a file in the repo, so it is INPUT. Escaping the quotes
    // stops it breaking out of the attribute and does nothing about the SCHEME, so this used to be a
    // clickable code-execution link inside the developer's own app, injected there by Reticle.
    const root = painted([defect()], 'javascript:alert(1)');
    expect(root.querySelector('.reticle-report-defects-more')).toBeNull();
  });

  it('refuses every other scheme a dashboard cannot live on', () => {
    for (const url of [
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      const root = painted([defect()], url);
      expect(root.querySelector('.reticle-report-defects-more'), url).toBeNull();
    }
  });

  it('refuses something that is not a url at all', () => {
    expect(painted([defect()], '/issues').querySelector('.reticle-report-defects-more')).toBeNull();
  });

  it('still renders http and https, which is what a dashboard actually is', () => {
    for (const url of ['https://console.test/issues', 'http://localhost:4321/issues']) {
      const root = painted([defect()], url);
      expect(root.querySelector('.reticle-report-defects-more'), url).not.toBeNull();
    }
  });

  it('keeps noopener, so the new tab cannot reach back', () => {
    const root = painted([defect()], 'https://console.test/issues');
    expect(root.querySelector('.reticle-report-defects-more')?.getAttribute('rel')).toContain(
      'noopener',
    );
  });

  it('escapes a url containing a quote rather than breaking the attribute', () => {
    const root = painted([defect()], 'https://console.test/i?x="><img src=x>');
    expect(root.querySelector('.reticle-report-defects img')).toBeNull();
  });
});

describe('the list stays a short list', () => {
  it('never renders more than the cap, however many arrive', () => {
    const many = Array.from({ length: 500 }, (_, i) => defect({ at: i, title: `d${String(i)}` }));
    const root = painted(many);
    expect(root.querySelectorAll('.reticle-report-defect').length).toBe(IMPACT_DEFECT_LIMIT);
  });

  it('renders a 50KB title without throwing', () => {
    const root = painted([defect({ title: 'x'.repeat(50_000) })]);
    expect(root.querySelector('.reticle-report-defect-title')?.textContent?.length).toBe(50_000);
  });

  it('renders unicode and emoji intact', () => {
    const root = painted([defect({ title: 'Sign In 🔭 決済' })]);
    expect(root.querySelector('.reticle-report-defect-title')?.textContent).toBe('Sign In 🔭 決済');
  });
});

describe('shapes the panel must survive', () => {
  it('renders nothing at all when nothing has broken', () => {
    expect(painted([]).querySelector('.reticle-report-defects-wrap')).toBeNull();
  });

  it('renders a defect with no detail and no source', () => {
    const root = painted([defect()]);
    expect(root.querySelector('.reticle-report-defect-detail')).toBeNull();
    expect(root.querySelector('.reticle-report-defect-source')).toBeNull();
    expect(root.querySelector('.reticle-report-defect-title')?.textContent).toBe('Sign In');
  });

  it('renders an EMPTY title without collapsing the row', () => {
    expect(painted([defect({ title: '' })]).querySelectorAll('.reticle-report-defect').length).toBe(
      1,
    );
  });

  it('survives a record written before defects existed', () => {
    /*
     * Zod's default applies when a record is PARSED, and the snapshot reaching this panel is pushed
     * straight from the daemon rather than round-tripped through the schema — so an older record
     * arrives with no `defects` field and used to throw, taking the whole report down with it.
     */
    // Built WITHOUT the field rather than deleting it: `delete` needs an optional operand, and the
    // shape under test is precisely a record that never had one.
    const { defects: _dropped, ...older } = scope([]);
    expect(() => reportBodyHtml(older as ImpactScope)).not.toThrow();
  });

  it('renders the REST of the report when the defect list is missing', () => {
    const { defects: _dropped, ...older } = scope([]);
    expect(reportBodyHtml(older as ImpactScope)).toContain('refused to pass');
  });

  it('repaints when a later snapshot arrives while the panel is open', () => {
    const { root, report } = mount();
    report.setSnapshot(snapshot([defect({ title: 'first' })]));
    report.open();
    report.setSnapshot(snapshot([defect({ at: 2, title: 'second' }), defect({ title: 'first' })]));
    expect(root.querySelector('[data-reticle-report-body]')?.textContent).toContain('second');
  });

  it('switching to the machine-wide scope keeps the list rendered', () => {
    const { root, report } = mount();
    report.setSnapshot(snapshot([defect({ title: 'Sign In' })]));
    report.open();
    root.querySelector<HTMLButtonElement>('[data-reticle-report-scope]')?.click();
    expect(root.querySelector('[data-reticle-report-body]')?.textContent).toContain('Sign In');
  });
});
