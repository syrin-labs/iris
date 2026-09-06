import { describe, expect, it, beforeEach } from 'vitest';
import { SnapshotMode } from '@reticlehq/core';
import { buildSnapshot } from './snapshot.js';

/**
 * An empty tree must not read as an empty page (#672).
 *
 * Reported from the field: inside a lease, `reticle_snapshot` returned `{ tree: "", nodes: 0 }` for
 * BOTH `interactive` and `full` on a fully rendered page, while `reticle_query({ by: "role" })` on
 * that same page found 44 buttons and 12 textboxes — every one of them `visible: false`. It cost the
 * reporter about six tool calls and a large console dump to establish that the page was fine and the
 * snapshot was wrong, and the flow then had to be driven off query refs.
 *
 * `leanSkipped` already answers this for leanness and is lean-only by construction, so `full` had no
 * explanation available to it at all. These pin the count that gives it one — and, as much, pin what
 * must NOT be counted, because a number that appears on every ordinary page tells a reader nothing
 * on the one page that needs it.
 */
describe('hiddenSkipped — an empty tree that says why', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('counts a display:none subtree that emptied the tree', () => {
    document.body.innerHTML = '<div style="display:none"><button>One</button></div>';
    const r = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(r.nodes).toBe(0);
    expect(r.tree).toBe('');
    expect(r.hiddenSkipped).toBe(1);
  });

  it('counts an aria-hidden subtree', () => {
    document.body.innerHTML = '<div aria-hidden="true"><button>One</button></div>';

    expect(buildSnapshot({ mode: SnapshotMode.FULL }).hiddenSkipped).toBe(1);
  });

  it('counts a subtree hidden by the hidden attribute', () => {
    document.body.innerHTML = '<div hidden><button>One</button></div>';

    expect(buildSnapshot({ mode: SnapshotMode.FULL }).hiddenSkipped).toBe(1);
  });

  it('answers for `full`, the mode leanSkipped cannot speak to', () => {
    // The half of the report that had no diagnostic at all: `leanSkipped` is only set in a lean
    // mode, so a full snapshot of a wholly hidden page returned "" and nothing else.
    document.body.innerHTML = '<div aria-hidden="true"><button>One</button></div>';
    const r = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(r.leanSkipped).toBeUndefined();
    expect(r.hiddenSkipped).toBe(1);
  });

  it('is absent, not zero, on a healthy page', () => {
    // Absence is the signal, exactly as it is for leanSkipped and visibleDialogs: a field that is
    // always present is one a reader stops reading.
    document.body.innerHTML = '<div><button>One</button></div>';
    const r = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.hiddenSkipped).toBeUndefined();
  });

  it('does not count the tags the tree is supposed to omit', () => {
    // <script>/<style> are absent from every snapshot ever taken and explain nothing about a page.
    // Counting them would put a number on every ordinary page and make it mean nothing on this one.
    document.body.innerHTML =
      '<script>var a = 1;</script><style>.a{color:red}</style><div><button>One</button></div>';
    const r = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.hiddenSkipped).toBeUndefined();
  });

  it('counts the subtree root once, not the elements underneath it', () => {
    // A hidden root is never descended into, so the elements below it are never seen to be counted.
    // Stated here so the number is read as what it is rather than as an element count.
    document.body.innerHTML =
      '<div aria-hidden="true"><button>One</button><button>Two</button><input></div>';

    expect(buildSnapshot({ mode: SnapshotMode.FULL }).hiddenSkipped).toBe(1);
  });

  it('counts each hidden sibling separately', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>One</button></div>' +
      '<div style="display:none"><button>Two</button></div>' +
      '<div hidden><button>Three</button></div>';

    expect(buildSnapshot({ mode: SnapshotMode.FULL }).hiddenSkipped).toBe(3);
  });
});

/**
 * The overlay explainer must not fail closed in its own failure case.
 *
 * `overlayHidingPage` picked the modal with `isVisible`, which is the right primary test — it tells
 * an open modal from a closed one left in the DOM. But in the state #672 describes, EVERY node
 * computes hidden, the modal with them, so the one function that explains an empty tree went silent
 * exactly when the tree was emptiest. The reporter's dialog had just opened and was in the React
 * tree; the snapshot offered no explanation for its absence.
 *
 * The candidate's own visibility was never the evidence. The evidence is every other child of body
 * carrying `aria-hidden="true"`, which is a focus trap's signature, and that gate is unchanged.
 */
describe('overlayHidingPage when the modal itself computes hidden (#672)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('still explains the empty page when the modal does not compute visible', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>Buy now</button></div>' +
      '<div style="opacity:0"><div role="dialog" aria-label="Confirm"><button>OK</button></div></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(status.overlayHidingPage).toBeDefined();
  });

  it('still requires the rest of the page to be aria-hidden', () => {
    // The gate that carries the actual evidence. Without it the fallback would explain any page
    // holding a closed dialog as an overlay problem, which is a confident wrong answer.
    document.body.innerHTML =
      '<div><button>Buy now</button></div>' +
      '<div style="opacity:0"><div role="dialog" aria-label="Confirm"><button>OK</button></div></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(status.overlayHidingPage).toBeUndefined();
  });

  it('prefers a visible modal when there is one', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>Buy now</button></div>' +
      '<div><div role="dialog" aria-label="Confirm"><button>OK</button></div></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.FULL });

    expect(status.overlayHidingPage).toBeDefined();
  });
});
