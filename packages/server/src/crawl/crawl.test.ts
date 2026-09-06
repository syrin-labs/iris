import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  CrawlAnomalyKind,
  EventType,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { crawl, type CrawlSession, legitimatelyInert } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();

interface RefScript {
  events?: { type: EventType; data?: Record<string, unknown> }[];
  dispatched?: boolean;
  /** What the browser captured alongside the anchor when this control was clicked. */
  source?: { file: string; line: number };
}

/** A scripted CrawlSession: SNAPSHOT returns `tree`; each ACT pushes that ref's scripted events. */
function fakeSession(
  tree: string,
  perRef: Record<string, RefScript>,
  snapshotTruncated = false,
): CrawlSession {
  let clock = 0;
  const buffer: ReticleEvent[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  return {
    elapsed: () => clock,
    eventsSince: (since) => buffer.filter((e) => e.t > since),
    command: (name, args = {}) => {
      if (name === ReticleCommand.SNAPSHOT) return ok({ tree, truncated: snapshotTruncated });
      if (name === ReticleCommand.ACT) {
        const ref = 'string' === typeof args['ref'] ? args['ref'] : '';
        clock += 1;
        for (const e of perRef[ref]?.events ?? []) {
          buffer.push({ t: clock, type: e.type, sessionId: 's', data: e.data ?? {} });
        }
        const src = perRef[ref]?.source;
        return ok({
          dispatched: perRef[ref]?.dispatched ?? true,
          ...(src === undefined ? {} : { source: src }),
        });
      }
      return ok({});
    },
  };
}

const tree = (lines: string[]): string => lines.join('\n');
const domActivity = { events: [{ type: EventType.DOM_ADDED }] };

describe('crawl — autonomous smart-monkey', () => {
  it('1: a healthy app yields zero anomalies and visits every control', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)', 'link "Home" (ref=e2)']), {
      e1: domActivity,
      // A healthy nav RENDERS its destination. This fixture used to emit a bare ROUTE_CHANGE and
      // nothing else, which measured against a real dashboard is not what a working link looks like
      // (a working one emitted domAdded + two requests) — it is precisely what a link to a BLANK
      // page looks like. Left as it was, the fixture asserted that arriving nowhere is healthy.
      e2: { events: [{ type: EventType.ROUTE_CHANGE }, { type: EventType.DOM_ADDED }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.interactiveFound).toBe(2);
    expect(r.stepsRun).toBe(2);
    expect(r.anomalies).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.visited).toEqual(['button "Save"', 'link "Home"']);
  });

  /**
   * The counter-test to the fixture change above, and the defect it exists for.
   *
   * A real merchant dashboard had NINE nav links that route to a blank page. `crawl` drove all nine
   * and reported `deadControls: 0` — correct by its own definition, because a route change is
   * activity and the control plainly worked. What was missing was any check on where it ARRIVED.
   */
  it('1b: a link that routes to a blank page is an anomaly, though the control is not dead', async () => {
    const session = fakeSession(tree(['link "Invoices" (ref=e1)']), {
      e1: { events: [{ type: EventType.ROUTE_CHANGE }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.deadControls).toBe(0); // the link worked — it navigated
    expect(r.anomalies.map((a) => a.kind)).toEqual([ContradictionKind.ROUTE_RENDERED_NOTHING]);
  });

  it('1c: a same-page skip link is not a blank destination', async () => {
    const session = fakeSession(tree(['link "Skip to content" (ref=e1)']), {
      e1: {
        events: [
          {
            type: EventType.ROUTE_CHANGE,
            data: {
              from: 'http://localhost:5173/app',
              to: 'http://localhost:5173/app#main-content',
              pathname: '/app',
              search: '',
              hash: '#main-content',
            },
          },
        ],
      },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies.map((a) => a.kind)).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  it('2: a console error during a click is reported with its control', async () => {
    const session = fakeSession(tree(['button "Boom" (ref=e1)']), {
      e1: { events: [{ type: EventType.CONSOLE_ERROR, data: { message: 'kaboom' } }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.consoleErrors).toBe(1);
    expect(r.anomalies[0]).toMatchObject({
      kind: CrawlAnomalyKind.CONSOLE_ERROR,
      ref: 'e1',
      desc: 'button "Boom"',
      detail: 'kaboom',
    });
  });

  it('3: a failed request (status ≥ 400) is reported', async () => {
    const session = fakeSession(tree(['button "Order" (ref=e1)']), {
      e1: {
        events: [
          { type: EventType.NET_REQUEST, data: { method: 'POST', url: '/api/order', status: 500 } },
        ],
      },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.failedRequests).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.FAILED_REQUEST);
    expect(r.anomalies[0]?.detail).toContain('/api/order');
  });

  it('4: a dispatched click with no reaction is a DEAD control', async () => {
    const session = fakeSession(tree(['button "Nothing" (ref=e1)']), { e1: { events: [] } });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.deadControls).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.DEAD_CONTROL);
    expect(r.anomalies[0]?.detail).toContain('TWICE');
  });

  it('4b: a control that is silent ONCE but alive on the retry is NOT dead', async () => {
    // The confirmation half of the rule. "Your button does nothing" is the strongest claim the
    // crawler makes and the one a reader acts on immediately, so one silent sample must not be
    // enough. Measured on a fixture whose FIXED twin has a working primary CTA: the crawl called it
    // dead on 2 of 3 runs, always a control the drive had already clicked successfully moments
    // earlier. A false positive here is the most expensive kind there is — this tier is what a
    // verdict is built from.
    let clicks = 0;
    const buffer: ReticleEvent[] = [];
    let clock = 0;
    const session: CrawlSession = {
      elapsed: () => clock,
      eventsSince: (since) => buffer.filter((e) => e.t > since),
      command: (name, args = {}) => {
        if (name === ReticleCommand.SNAPSHOT)
          return Promise.resolve({
            kind: 'command_result' as const,
            id: 'c',
            ok: true,
            result: { tree: tree(['button "Flaky" (ref=e1)']), truncated: false },
          });
        if (name === ReticleCommand.ACT && 'e1' === args['ref']) {
          clock += 1;
          clicks += 1;
          // Silent the first time, alive the second — a flake, not a dead control.
          if (clicks > 1)
            buffer.push({ t: clock, type: EventType.DOM_ADDED, sessionId: 's', data: {} });
          return Promise.resolve({
            kind: 'command_result' as const,
            id: 'c',
            ok: true,
            result: { dispatched: true },
          });
        }
        return Promise.resolve({ kind: 'command_result' as const, id: 'c', ok: true, result: {} });
      },
    };

    const r = await crawl(session, {}, noSleep);

    expect(clicks).toBe(2); // it actually took a second sample rather than trusting the first
    expect(r.counts.deadControls).toBe(0);
    expect(r.anomalies).toEqual([]);
  });

  it('5: a control that could not dispatch is NOT flagged dead', async () => {
    const session = fakeSession(tree(['button "Stale" (ref=e1)']), {
      e1: { events: [], dispatched: false },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.deadControls).toBe(0);
    expect(r.anomalies).toEqual([]);
  });

  it('6: a 200 request alone is activity, not an anomaly', async () => {
    const session = fakeSession(tree(['button "OK" (ref=e1)']), {
      e1: { events: [{ type: EventType.NET_REQUEST, data: { url: '/api/ok', status: 200 } }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies).toEqual([]);
    expect(r.counts.deadControls).toBe(0);
  });

  it('7: maxSteps bounds coverage and flags truncated', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `button "B${i}" (ref=e${i})`);
    const session = fakeSession(tree(lines), {});
    const r = await crawl(session, { maxSteps: 2 }, noSleep);
    expect(r.stepsRun).toBe(2);
    expect(r.visited).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.interactiveFound).toBe(5);
  });

  it('8: same-label but distinct controls (different refs) are each clicked (dedup by ref, not label)', async () => {
    // Two rows' "Delete"/"Dup" buttons share a label but are different controls — the smart-monkey
    // must click both, not collapse them by description (which under-covered list/table UIs).
    const session = fakeSession(tree(['button "Dup" (ref=e1)', 'button "Dup" (ref=e2)']), {
      e1: domActivity,
      e2: domActivity,
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.stepsRun).toBe(2);
    expect(r.visited).toEqual(['button "Dup"', 'button "Dup"']);
  });
});

/**
 * A crawl report is the output most likely to be read as a work list — it sweeps a whole app and
 * hands back everything broken. "e42 does nothing" is a work item that starts with a search, and the
 * location costs nothing to include: the crawl already clicks each control, and the act result
 * carries the source captured alongside its anchor.
 */
describe('crawl anomalies name the file the control is written in', () => {
  it('attaches source to a dead control', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)']), {
      e1: { events: [], source: { file: 'src/components/Toolbar.tsx', line: 44 } },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.DEAD_CONTROL);
    expect(r.anomalies[0]?.source).toBe('src/components/Toolbar.tsx:44');
  });

  it('attaches source to a console error and a failed request alike', async () => {
    const session = fakeSession(tree(['button "Pay" (ref=e1)']), {
      e1: {
        events: [
          { type: EventType.CONSOLE_ERROR, data: { message: 'boom' } },
          { type: EventType.NET_REQUEST, data: { method: 'POST', url: '/api/pay', status: 500 } },
        ],
        source: { file: 'src/views/Checkout.tsx', line: 88 },
      },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies.length).toBeGreaterThanOrEqual(2);
    for (const a of r.anomalies) expect(a.source).toBe('src/views/Checkout.tsx:88');
  });

  it('omits source when the app was not built with the stamp', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)']), { e1: { events: [] } });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies[0]?.source).toBeUndefined();
  });
});

/**
 * A crawl that swept a PREFIX of the page must not report like one that swept the page.
 *
 * The snapshot walk stops at its node cap and returns elements in document order, so on a large page
 * the controls past the cap were never listed — not merely unclicked. `interactiveFound` was that
 * post-cap count and `truncated` meant only "the step budget ran out", so a data grid with 900
 * controls could report 18 found, 18 clicked, 0 anomalies, truncated:false. That reads as "this app
 * is clean" and it is the strongest possible false green: the tool description promises it clicked
 * every reachable control.
 */
describe('crawl does not present a capped sweep as a complete one', () => {
  it('flags truncated when the snapshot itself was capped, even though every listed control was clicked', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)']), { e1: domActivity }, true);
    const r = await crawl(session, {}, noSleep);
    expect(r.stepsRun).toBe(1);
    expect(r.interactiveFound).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.coverageNote).toBeDefined();
  });

  it('says nothing extra when the whole page fitted in one snapshot', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)']), { e1: domActivity }, false);
    const r = await crawl(session, {}, noSleep);
    expect(r.truncated).toBe(false);
    expect(r.coverageNote).toBeUndefined();
  });
});

describe('a control that is SUPPOSED to do nothing is not an anomaly', () => {
  /**
   * Measured on a shipments console: all three of the crawler's anomalies were controls behaving
   * correctly — a `[disabled]` button, an already `[checked]` radio, and a text input. An anomaly
   * list that is 100% false on a real app is worse than none: the agent spends its budget disproving
   * it and learns to skip the field.
   */
  it.each([
    '- button "Hold selected" [disabled]',
    '- radio "all" [checked]',
    '- checkbox "select ATL-100000" [checked]',
    '- textbox "ref…"',
    '- searchbox "Search"',
    '- combobox "Carrier"',
  ])('treats %s as legitimately inert', (desc) => {
    expect(legitimatelyInert(desc)).toBe(true);
  });

  it.each([
    '- button "Totally Dead"',
    '- radio "draft"',
    '- link "Settlements"',
    '- checkbox "select ATL-100001"',
  ])('still judges %s — a dead one of these is a real finding', (desc) => {
    expect(legitimatelyInert(desc)).toBe(false);
  });
});
