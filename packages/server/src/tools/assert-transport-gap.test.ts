import { describe, expect, it } from 'vitest';
import { EventType, Verified, VerifiedReason } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { SessionManager } from '../session/session.js';
import type { ReticleEvent } from '@reticlehq/core';
import { createFakeSession } from '../session/fake-session.js';

/**
 * A window the browser dropped events in must not grade `proved`.
 *
 * `RATE_LIMITED` — the BRIDGE sampling because events arrived faster than its per-second cap — is
 * already the one blind spot that `impeachesCapture`, on the reasoning that a green over a window
 * you did not fully see "would only describe what was observed". `TRANSPORT_OVERFLOW` is the exact
 * same loss on the other side of the wire: the browser's own queue overflowed and threw events
 * away. It was read in journal rollups and nowhere on the verdict path, so the identical condition
 * downgraded a verdict from one side of the socket and was invisible from the other.
 *
 * This is the gap-marker half of #117: the SDK knows it lost events, and none of that reached the
 * rule that decides whether a green can be trusted.
 */
function depsWith(events: ReticleEvent[]): ToolDeps {
  const session = createFakeSession({
    bufferHealth: () => ({ total: 12, dropped: 0 }),
    eventsSince: () => events,
    queryEvents: () => Promise.resolve(events),
    elapsed: () => 1000,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
  });
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

function ev(type: EventType, data: Record<string, unknown>, t = 5): ReticleEvent {
  return { t, type, sessionId: 'demo', data };
}

/** A signal the assertion below matches, so `pass` is true and only the VERDICT is under test. */
const SIGNAL = ev(EventType.SIGNAL, { name: 'saved' });

const assertSaved = { predicate: { kind: 'signal', name: 'saved' }, timeout_ms: 0 };

interface Verdict {
  pass: boolean;
  verified?: string;
  verifiedReason?: string;
  because?: string;
}

describe('a verdict over a window the browser dropped events in', () => {
  it('is not `proved` when the transport queue overflowed', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWith([SIGNAL, ev(EventType.TRANSPORT_OVERFLOW, { dropped: 34 })]),
      assertSaved,
    )) as Verdict;
    expect(result.pass, 'the assertion itself still held').toBe(true);
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('says how many events went missing, so the caveat is actionable', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWith([SIGNAL, ev(EventType.TRANSPORT_OVERFLOW, { dropped: 34 })]),
      assertSaved,
    )) as Verdict;
    expect(String(result.because)).toContain('34');
  });

  it('still grades the same window `proved` when nothing was dropped', async () => {
    // The negative control. Without it this fix could downgrade every verdict and still look green.
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWith([SIGNAL]),
      assertSaved,
    )) as Verdict;
    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.YES);
    expect(result.verifiedReason).toBe(VerifiedReason.PROVED);
  });

  it('a TRUNCATED channel does NOT impeach — it names its channel and is routine churn', async () => {
    // Deliberate line. A DOM-mutation flood truncates on any busy page; treating that as "I lost
    // data" would caveat every verdict on every real app, and a caveat that is always present is
    // one nobody reads. TRANSPORT_OVERFLOW is the honest "arbitrary events are gone" marker.
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWith([SIGNAL, ev(EventType.TRUNCATED, { channel: 'dom', dropped: 900 })]),
      assertSaved,
    )) as Verdict;
    expect(result.verified).toBe(Verified.YES);
  });
});
