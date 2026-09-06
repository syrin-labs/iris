/**
 * Skew has to reach the AGENT, on whatever tool it happens to be calling.
 *
 * Reticle is three independently-installed pieces that talk to each other: the SDK in the page, the
 * daemon holding the bridge, and the MCP server the agent spawns. They are versioned separately and
 * upgraded separately, so any pair can drift — and each pair fails the same silent way, since the
 * wire protocol still matches and only BEHAVIOUR disagrees.
 *
 * Every check built so far reported into a place nobody looks: SDK skew landed in
 * `reticle_sessions.versionSkew`, which an agent driving a flow never calls, and daemon skew went to
 * a CLI log line no agent reads. So an agent could work for an entire session against a mismatched
 * pair, see tools behave oddly, and never be told the one fact that explains it.
 *
 * This is the delivery channel: skew rides out on the NEXT tool result, whatever that tool is —
 * the same reasoning the update nudge already uses ("an out-of-date install is worth mentioning
 * whatever the agent is doing"). Once per distinct message, so a long session is told, not nagged.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  noteVersionSkew,
  takeVersionSkew,
  takeVersionSkewOnto,
  resetVersionSkew,
} from './version-nudge.js';

beforeEach(() => resetVersionSkew());

describe('version-skew nudge', () => {
  it('has nothing to say when nothing is skewed', () => {
    expect(takeVersionSkew()).toBeUndefined();
  });

  it('delivers the skew once, then stops — told, not nagged', () => {
    // A real message, as describeSkew builds it — the carrier passes it through verbatim, and
    // whether it names a concrete fix is asserted where it is BUILT (version-skew.test.ts).
    noteVersionSkew('sdk', 'the page runs 2.2.1 but the daemon is 2.4.1. Run `reticle update`.');
    const first = takeVersionSkew();
    expect(first?.pair).toBe('sdk');
    expect(first?.action).toContain('2.2.1');
    expect(takeVersionSkew()).toBeUndefined();
  });

  it('splices pending skew onto a thrown-tool error, and drops the feedback ask', () => {
    // The Playwright-timeout case: an unrecognized error used to invite a bug report, so the
    // caller debugs a CDP string instead of the mismatched pair that caused it.
    noteVersionSkew('sdk', 'the page runs 2.2.1 but the daemon is 2.4.1. Run `reticle update`.');
    const out = takeVersionSkewOnto({
      error: 'Timeout 30000ms exceeded.',
      feedback: 'This error is not one Reticle recognizes',
    });
    expect(out['version_skew']).toEqual({
      pair: 'sdk',
      action: 'the page runs 2.2.1 but the daemon is 2.4.1. Run `reticle update`.',
    });
    expect(out['feedback']).toBeUndefined();
    expect(out['recovery']).toContain('reticle update');
    expect(out['error']).toBe('Timeout 30000ms exceeded.');
    expect(takeVersionSkew()).toBeUndefined();
  });

  it('keeps a recognized recovery and still attaches the envelope', () => {
    noteVersionSkew('sdk', 'page 2.2.1 vs daemon 2.4.1');
    const out = takeVersionSkewOnto({
      error: "command 'snapshot' timed out after 8000ms",
      recovery: 'ask the human to bring the tab to the front',
    });
    expect(out['recovery']).toBe('ask the human to bring the tab to the front');
    expect(out['version_skew']).toBeDefined();
  });

  it('leaves an error payload alone when nothing is skewed', () => {
    const payload = { error: 'Timeout 30000ms exceeded.', feedback: 'ask' };
    expect(takeVersionSkewOnto(payload)).toEqual(payload);
  });

  it('re-arms for a DIFFERENT skew — a second tab on a third version is news', () => {
    noteVersionSkew('sdk', 'page 2.2.1 vs daemon 2.4.1');
    takeVersionSkew();
    noteVersionSkew('sdk', 'page 2.3.0 vs daemon 2.4.1');
    expect(takeVersionSkew()?.action).toContain('2.3.0');
  });

  it('does not repeat the SAME skew when the same tab reconnects', () => {
    noteVersionSkew('sdk', 'page 2.2.1 vs daemon 2.4.1');
    takeVersionSkew();
    noteVersionSkew('sdk', 'page 2.2.1 vs daemon 2.4.1');
    expect(takeVersionSkew()).toBeUndefined();
  });

  it('reports each PAIR independently — the SDK and the daemon are different upgrades', () => {
    noteVersionSkew('sdk', 'page 2.2.1 vs daemon 2.4.1');
    noteVersionSkew('daemon', 'daemon 2.3.0 vs mcp server 2.4.1');
    const pairs = [takeVersionSkew()?.pair, takeVersionSkew()?.pair].sort();
    expect(pairs).toEqual(['daemon', 'sdk']);
    expect(takeVersionSkew()).toBeUndefined();
  });
});
