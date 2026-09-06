import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementState, REDACTED_VALUE, SnapshotMode } from '@reticlehq/core';
import { getAccessibleName, getRole, getStates } from './a11y.js';
import { buildSnapshot } from './snapshot.js';
import { ATTR_VALUE_MAX, matchQuery, runQuery } from './query.js';
import { registerCapabilities } from '../registry/capabilities.js';
import { executeAction } from '../actions/actions.js';
import { refs } from './refs.js';

function render(html: string): void {
  document.body.innerHTML = html;
}

describe('a11y', () => {
  it('computes implicit roles', () => {
    render('<button>Go</button><a href="/x">Home</a><input type="checkbox" />');
    const [button, link, checkbox] = [
      document.querySelector('button'),
      document.querySelector('a'),
      document.querySelector('input'),
    ];
    expect(getRole(button as Element)).toBe('button');
    expect(getRole(link as Element)).toBe('link');
    expect(getRole(checkbox as Element)).toBe('checkbox');
  });

  it('derives accessible name from content, label, and aria-label', () => {
    render(`
      <button>Pay $42</button>
      <label>Email <input id="e" /></label>
      <button aria-label="Close dialog">×</button>
    `);
    expect(getAccessibleName(document.querySelector('button') as Element)).toBe('Pay $42');
    expect(getAccessibleName(document.getElementById('e') as Element)).toBe('Email');
    expect(getAccessibleName(document.querySelectorAll('button')[1] as Element)).toBe(
      'Close dialog',
    );
  });

  it('reports disabled and checked states', () => {
    render('<button disabled>X</button><input type="checkbox" checked />');
    expect(getStates(document.querySelector('button') as Element)).toContain(ElementState.DISABLED);
    expect(getStates(document.querySelector('input') as Element)).toContain(ElementState.CHECKED);
  });
});

describe('snapshot', () => {
  it('renders a semantic tree with refs for interactive elements', () => {
    render(`
      <main>
        <h1>Checkout</h1>
        <form aria-label="Payment">
          <input aria-label="Card number" />
          <button>Pay $42.00</button>
        </form>
      </main>
    `);
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('heading "Checkout"');
    expect(snap.tree).toContain('button "Pay $42.00"');
    expect(snap.tree).toMatch(/textbox "Card number" \(ref=e\d+\)/);
    expect(snap.status.route).toBeDefined();
  });

  it('pierces open shadow DOM so web-component content is visible', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.textContent = 'Shadow Save';
    shadow.appendChild(btn);
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('Shadow Save');
  });

  it('interactive mode lists only actionable elements', () => {
    render('<div><h1>Title</h1><button>Click</button></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).toContain('button "Click"');
    expect(snap.tree).not.toContain('heading');
  });

  it('a missing scope snapshots NOTHING and flags scopeMissing — never a whole-page fallback', () => {
    render('<main><button>Real</button></main>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL, scope: '#modal-gone' });
    expect(snap.scopeMissing).toBe(true);
    expect(snap.tree).toBe(''); // did NOT fall back to snapshotting the whole page
    expect(snap.tree).not.toContain('Real');
  });

  it('a resolving scope snapshots that subtree without scopeMissing', () => {
    render('<div id="panel"><button>Inside</button></div><button>Outside</button>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL, scope: '#panel' });
    expect(snap.scopeMissing).toBeUndefined();
    expect(snap.tree).toContain('Inside');
    expect(snap.tree).not.toContain('Outside');
  });

  it('includes text content of generic containers so silent content removal is visible', () => {
    // KPI-card shape: generic divs with no role/name carry the value text. Without this,
    // removing a card is invisible to the snapshot (the silent-DOM benchmark blind spot).
    render('<div class="kpi"><div>Deploys</div><div>1240</div></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('Deploys');
    expect(snap.tree).toContain('1240');
  });

  it('a snapshot changes when a generic text node is removed (detects the regression)', () => {
    render('<section><div>Alpha</div><div>Beta</div></section>');
    const before = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    const section = document.querySelector('section');
    const last = section?.lastElementChild ?? null;
    if (section !== null && last !== null) section.removeChild(last);
    const after = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    expect(before).not.toBe(after);
    expect(after).not.toContain('Beta');
  });

  it('keeps interactive mode lean: omits generic text content', () => {
    render('<div>JustText</div><button>Go</button>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('JustText');
    expect(snap.tree).toContain('button "Go"');
  });

  it('interactive mode keeps live regions: an alert is the app SAYING the action failed', () => {
    // Drove a real login against bench-app: the click returned ok/settled with a DOM mutation, and
    // interactive mode — the mode the tool description recommends for being ~3x smaller — showed
    // the same three controls as before. The error text was only in FULL. An agent that follows
    // the advice it is given is structurally blind to the failure it just caused.
    render(
      '<form><input aria-label="Email"><button>Sign in</button></form><div role="alert">Invalid email or password</div>',
    );
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).toContain('Invalid email or password');
  });

  it('interactive mode keeps an aria-live region even when the role is not alert', () => {
    render('<div aria-live="polite">Saved 3 of 5</div><button>Go</button>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).toContain('Saved 3 of 5');
  });

  it('interactive mode still drops ordinary text: the exemption is announcements only', () => {
    render('<div aria-live="off">Muted</div><div>Chatter</div><button>Go</button>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('Chatter');
    expect(snap.tree).not.toContain('Muted'); // aria-live="off" is explicitly NOT an announcement
    expect(snap.tree).toContain('button "Go"');
  });

  it('emits a layout signature for grid containers so a CLS/layout regression is visible', () => {
    // A layout regression (column count change) leaves the role+text tree identical — only
    // the computed layout differs. The signature makes that visible (a11y-only tools cannot).
    render('<div style="display:grid;grid-template-columns:1fr 1fr"><span>a</span></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('grid-cols:');
  });

  it('the layout signature changes when grid columns change (detects the regression)', () => {
    render('<main style="display:grid;grid-template-columns:1fr 1fr"><span>x</span></main>');
    const before = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.style.gridTemplateColumns = '1fr 1fr 1fr';
    const after = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    expect(before).not.toBe(after);
  });

  it('omits the layout signature in interactive mode (kept lean)', () => {
    render('<div style="display:grid;grid-template-columns:1fr 1fr"><button>Go</button></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('grid-cols:');
  });
});

describe('query', () => {
  beforeEach(() => {
    render(`
      <button>Pay</button>
      <button disabled>Submit</button>
      <div role="dialog" aria-label="Order confirmed">Done</div>
    `);
  });

  it('matches by role + name', () => {
    const result = matchQuery({ role: 'button', name: 'Pay' });
    expect(result.matched).toBe(true);
    expect(result.elements[0]?.name).toBe('Pay');
  });

  it('filters by state', () => {
    const enabled = matchQuery({ role: 'button', name: 'Submit' }, ElementState.ENABLED);
    expect(enabled.matched).toBe(false);
    const disabled = matchQuery({ role: 'button', name: 'Submit' }, ElementState.DISABLED);
    expect(disabled.matched).toBe(true);
  });

  it('matches a dialog by role', () => {
    expect(matchQuery({ role: 'dialog' }).matched).toBe(true);
  });

  it('honors name in the by+value form (regression)', () => {
    // by:'role'+value:'button'+name must not return every button.
    const result = matchQuery({ by: 'role', value: 'button', name: 'Pay' });
    expect(result.count).toBe(1);
    expect(result.elements[0]?.name).toBe('Pay');
  });

  it('matches testid exactly, not as a substring (regression)', () => {
    document.body.innerHTML =
      '<div data-testid="toast">t</div><button data-testid="show-toast">b</button>';
    // "toast" must NOT also match "show-toast".
    expect(matchQuery({ by: 'testid', value: 'toast' }).count).toBe(1);
    expect(matchQuery({ testid: 'toast' }).elements[0]?.role).toBe('generic');
  });
});

describe('query empty hint', () => {
  beforeEach(() => {
    render('');
  });

  it('returns presentTestids containing other testids on a zero-match query', () => {
    render('<div data-testid="cart-list"></div><div data-testid="cart-total"></div>');
    const r = runQuery({ role: 'button', name: 'Checkout' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.presentTestids).toEqual(expect.arrayContaining(['cart-list', 'cart-total']));
  });

  it('omits the hint on a successful match (shape unchanged)', () => {
    render('<button>Pay</button>');
    const r = runQuery({ role: 'button', name: 'Pay' });
    expect(r.elements.length).toBeGreaterThan(0);
    expect(r.hint).toBeUndefined();
  });

  it('flags knownEmptyState when a registered testid is present', () => {
    registerCapabilities({ testids: ['cart-empty-region'] });
    render('<div data-testid="cart-empty-region">No items</div>');
    const r = runQuery({ by: 'testid', value: 'no-such-id' });
    expect(r.hint?.knownEmptyState).toBe(true);
  });

  it('reports knownEmptyState false when present testids are not registered', () => {
    render('<div data-testid="f4-unregistered-thing"></div>');
    const r = runQuery({ by: 'testid', value: 'no-such-id' });
    expect(r.hint?.knownEmptyState).toBe(false);
  });

  it('caps presentTestids at 12 and de-dupes', () => {
    render(
      Array.from({ length: 20 }, (_, i) => `<div data-testid="t${i}"></div>`).join('') +
        '<div data-testid="t0"></div>',
    );
    const r = runQuery({ role: 'button', name: 'nope' });
    expect(r.hint?.presentTestids).toHaveLength(12);
  });

  /**
   * The field report this came from: a label rendered with `v-html` spans several child nodes, so
   * `by: text` — which reads an element's OWN text nodes — matched nothing while the string was
   * plainly on screen. The verdict was identical to "never rendered", and the drive ended in a bug
   * report against an app that had worked.
   */
  it('names the container when the wanted text is split across children', () => {
    render(
      '<div id="row"><span>Move to </span><span>Reticle </span><span>Repro Folder</span></div>',
    );
    const r = runQuery({ text: 'Move to Reticle Repro Folder' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.splitText).toBeDefined();
    expect(r.hint?.splitText?.ref).toBeDefined();
  });

  it('picks the DEEPEST container, not the first one that contains the string', () => {
    // Every ancestor up to <body> contains the string; naming <body> is not a locator.
    render('<main><section><p id="tight"><b>Half</b><i> and half</i></p></section></main>');
    const r = runQuery({ text: 'Half and half' });
    const ref = r.hint?.splitText?.ref;
    expect(ref).toBeDefined();
    const resolved = runQuery({ scope: ref, self: true });
    expect(resolved.elements[0]?.text).toContain('Half and half');
  });

  it('omits splitText on an ordinary text miss', () => {
    // The string is genuinely absent — the clause must not fire, or it stops meaning anything.
    render('<div><span>something else entirely</span></div>');
    const r = runQuery({ text: 'not on this page at all' });
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('omits splitText when the miss was not a text search', () => {
    render('<div><span>Save</span><span> changes</span></div>');
    const r = runQuery({ role: 'button', name: 'Save changes' });
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('reflects location in route', () => {
    history.pushState({}, '', '/cart?x=1');
    const r = runQuery({ role: 'button', name: 'nope' });
    expect(r.hint?.route).toBe('/cart?x=1');
  });

  it('names a present region by its aria-labelledby TEXT, not the raw element id', () => {
    render(`
      <h2 id="cart-heading">Your Cart</h2>
      <ul role="list" aria-labelledby="cart-heading"><li role="listitem">item</li></ul>
    `);
    const r = runQuery({ role: 'button', name: 'nope' });
    const listRegion = r.hint?.presentRegions.find((reg) => 'list' === reg.role);
    expect(listRegion?.name).toBe('Your Cart'); // resolved text, not "cart-heading"
  });
});

describe('actions', () => {
  it('clicks a button via its ref', () => {
    render('<button>Go</button>');
    const button = document.querySelector('button') as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    const ref = refs.refFor(button);
    void executeAction(ref, 'click');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('fills an input and dispatches input/change', () => {
    render('<input />');
    const input = document.querySelector('input') as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    const ref = refs.refFor(input);
    void executeAction(ref, 'fill', { value: '4242' });
    expect(input.value).toBe('4242');
    expect(onInput).toHaveBeenCalled();
  });

  it('rejects with a clear error for a stale ref', async () => {
    render('<button>A</button>');
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    button.remove();
    await expect(executeAction(ref, 'click')).rejects.toThrow(/no longer resolves/);
  });
});

describe('query: open shadow roots and attribute projection', () => {
  beforeEach(() => {
    render('');
  });

  /** Attach an open shadow root containing `html` to a fresh host in the body. */
  const withShadow = (html: string, mode: ShadowRootMode = 'open'): HTMLElement => {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'shadow-host');
    document.body.append(host);
    host.attachShadow({ mode }).innerHTML = html;
    return host;
  };

  it('finds a testid inside an OPEN shadow root', () => {
    // A single root query does not pierce shadow DOM, so this returned zero on a healthy page, a miss
    // indistinguishable from a genuinely absent element.
    withShadow('<span data-testid="shadow-status">All systems nominal</span>');
    expect(matchQuery({ by: 'testid', value: 'shadow-status' }).count).toBe(1);
  });

  it('finds a role inside an OPEN shadow root', () => {
    withShadow('<button>Refresh status</button>');
    const r = matchQuery({ by: 'role', value: 'button', name: 'Refresh status' });
    expect(r.count).toBe(1);
  });

  it('does NOT reach into a CLOSED shadow root', () => {
    // element.shadowRoot is null by design; the SDK reports this as a blind spot rather than
    // pretending to see through it.
    withShadow('<span data-testid="sealed">hidden</span>', 'closed');
    expect(matchQuery({ by: 'testid', value: 'sealed' }).count).toBe(0);
  });

  it('does not double-count an element reachable from both the host and the root', () => {
    withShadow('<span data-testid="once">x</span>');
    expect(matchQuery({ by: 'testid', value: 'once' }).count).toBe(1);
  });

  it('projects requested attributes so links and images can be inventoried', () => {
    render('<a href="/pricing" data-testid="nav-pricing">Pricing</a>');
    const r = matchQuery({ by: 'testid', value: 'nav-pricing', attrs: ['href'] });
    expect(r.elements[0]?.attrs).toEqual({ href: '/pricing' });
  });

  it('omits attributes the element does not carry rather than emitting empty strings', () => {
    render('<a href="/x" data-testid="l">L</a>');
    const r = matchQuery({ by: 'testid', value: 'l', attrs: ['href', 'src', 'target'] });
    expect(r.elements[0]?.attrs).toEqual({ href: '/x' });
  });

  it('omits attrs entirely when none were requested (shape unchanged for existing callers)', () => {
    render('<a href="/x" data-testid="l">L</a>');
    expect(matchQuery({ by: 'testid', value: 'l' }).elements[0]?.attrs).toBeUndefined();
  });

  it('REDACTS credential-bearing attributes — projection must not become an exfiltration path', () => {
    render('<div data-testid="w" data-auth-token="sk-live-abc123" data-page="3"></div>');
    const r = matchQuery({ by: 'testid', value: 'w', attrs: ['data-auth-token', 'data-page'] });
    expect(r.elements[0]?.attrs?.['data-auth-token']).toBe(REDACTED_VALUE);
    expect(r.elements[0]?.attrs?.['data-page']).toBe('3');
  });

  it('caps a long attribute value so one huge href cannot blow the response budget', () => {
    render(`<a href="/${'x'.repeat(5000)}" data-testid="big">B</a>`);
    const href = matchQuery({ by: 'testid', value: 'big', attrs: ['href'] }).elements[0]?.attrs?.[
      'href'
    ];
    expect((href ?? '').length).toBeLessThanOrEqual(ATTR_VALUE_MAX + 1);
  });
});

// `mode:"interactive"` is a ROLE filter, and most production UI carries no roles. Measured on
// MarkText, a production Electron editor: interactive returned an empty tree where full found 47
// nodes, because its block picker is `<div>`s. An empty tree reads as an empty page, and the tool
// description recommends this mode as the default — so the cheap view said there was nothing to
// drive.
//
// `data-testid` was tried as the fix, on the premise that it is "a handle its author put there to be
// driven". Measured against our own instrumented bench app, that premise is false: the lean tree on
// its dashboard went to 16 nodes and 175 tokens, and EIGHT of them were display elements —
// kpi-deploys, kpi-success, kpi-p95, kpi-services, area-chart, activity-feed, brand. Half the
// "interactive" view was things you cannot act on, and the mode roughly doubled to carry them. A
// testid marks what a TEST cares about, which is a superset of what a driver can use, and it did not
// help MarkText either — its controls carry no testid.
//
// What actually fixed MarkText is `leanSkipped`: the count turns an empty tree into "look again in
// full mode", and it costs one number. The testid still supplies a NAME and a ref where an element
// has no accessible name, so a display element remains addressable in `full` — read it there, or
// query it directly.
describe('interactive mode stays the actionable view', () => {
  it('excludes a role-less div that only carries a data-testid', () => {
    document.body.innerHTML = `<div data-testid="kpi-deploys">40</div><div>just text</div>`;
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('kpi-deploys');
    expect(snap.tree).not.toContain('just text');
  });

  // The count is what turns an empty tree into "look again in full mode", and it is the part of the
  // MarkText fix that survives. It counts MEANINGFUL nodes only — a bare div with no name, role or
  // layout is not meaningful in either mode, so a named one is the shape that exercises this.
  it('counts what it passed over, so an empty tree is not an empty page', () => {
    document.body.innerHTML = `<div aria-label="block picker"><span>x</span></div>`;
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree.trim()).toBe('');
    expect(snap.leanSkipped ?? 0).toBeGreaterThan(0);
  });

  it('keeps a real control with no role, when it has one', () => {
    document.body.innerHTML = `<button data-testid="go">Go</button>`;
    expect(buildSnapshot({ mode: SnapshotMode.INTERACTIVE }).tree).toContain('Go');
  });

  // A testid does not put an element into `full` either, and does not name one there.
  //
  // Naming testid-bearing generics and minting a ref for them read well in isolation — a bare
  // `- generic` is visible and unaddressable — but `full` is the DEFAULT mode and the price is paid
  // on every snapshot. Measured A/B on the bench app's dashboard, same view, same build otherwise:
  // 65 nodes and 622 tokens with it, 58 nodes and 540 without. +15% on the most-called read, for
  // handles the caller almost always already knows.
  //
  // `reticle_query { by: "testid" }` addresses these directly and cost 31 tokens for one element,
  // which is the right tool for a value you want to ASSERT on rather than drive.
  it('does not add a testid-only container to full mode', () => {
    document.body.innerHTML = `<div data-testid="area-chart"><svg></svg></div>`;
    expect(buildSnapshot({ mode: SnapshotMode.FULL }).tree).not.toContain('area-chart');
  });

  // Content is never lost: a div whose only content is text still shows that text.
  it('still shows the text of a text-only testid div', () => {
    document.body.innerHTML = `<div data-testid="kpi-deploys">40</div>`;
    expect(buildSnapshot({ mode: SnapshotMode.FULL }).tree).toContain('40');
  });

  // An element with a real accessible name is untouched by any of this.
  it('keeps a named generic in full mode', () => {
    document.body.innerHTML = `<div aria-label="Reticle agent session"><span>x</span></div>`;
    expect(buildSnapshot({ mode: SnapshotMode.FULL }).tree).toContain('Reticle agent session');
  });

  it('still excludes ordinary content, so the mode stays lean', () => {
    document.body.innerHTML = `<p>a paragraph</p><span>a span</span>`;
    expect(buildSnapshot({ mode: SnapshotMode.INTERACTIVE }).tree.trim()).toBe('');
  });
});
