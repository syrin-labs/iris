import { describe, expect, it } from 'vitest';
import { EventType, Verified, VerifiedReason, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { SessionManager } from '../session/session.js';
import { createFakeSession } from '../session/fake-session.js';

/**
 * `reticle_assert` must SURFACE a contradiction, not merely be able to find one.
 *
 * Found by mutation: replacing `findContradictions(...)` with `[]` inside `assertVerdict` failed
 * ZERO tests — while gutting `findContradictions` ITSELF fails 23. The detector is thoroughly
 * covered; the wire from it into the tool an agent actually calls was bare.
 *
 * This is the flagship behaviour of the product, and it was verified by hand tonight against the
 * `swallowed-500-generate` fixture — UI renders success, the wire returned 500:
 *
 *   pass: true, verified: "no", verifiedReason: "contradicted",
 *   contradictions: [{ claim: 'the app fired "compose:generated"',
 *                      counter: "1 request(s) in the same window failed",
 *                      detail: "POST /api/generate-script → 500" }]
 *
 * `pass:true` with `verified:"no"` IS the product. Had that plumbing regressed, every one of those
 * verdicts would have silently become a clean green and no test would have said a word.
 *
 * Third instance of one pattern in three passes (see #227 occludedBy, #228 bufferHealth): a
 * well-tested producer, consumers that stub it, and nothing on the delegation between them.
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

/** The live shape: a success signal fired while the request behind it failed. */
const FALSE_GREEN: ReticleEvent[] = [
  ev(EventType.SIGNAL, { name: 'compose:generated' }),
  ev(EventType.NET_REQUEST, {
    method: 'POST',
    url: 'http://localhost:8787/api/generate-script',
    status: 500,
  }),
];

interface Verdict {
  pass: boolean;
  verified?: string;
  verifiedReason?: string;
  contradictions?: { claim: string; counter: string; detail?: string }[];
}

const assertSignal = { predicate: { kind: 'signal', name: 'compose:generated' }, timeout_ms: 0 };

describe('reticle_assert surfaces a contradiction it found', () => {
  it('refuses to call a passing assertion verified when a channel disagrees', async () => {
    const r = (await tool(ReticleTool.ASSERT).handler(
      depsWith(FALSE_GREEN),
      assertSignal,
    )) as Verdict;
    expect(r.pass, 'the signal really did fire — the assertion itself holds').toBe(true);
    expect(r.verified).toBe(Verified.NO);
    expect(r.verifiedReason).toBe(VerifiedReason.CONTRADICTED);
  });

  it('returns the contradiction itself, naming the request that disagreed', async () => {
    // The verdict alone says "something disagreed". Only the detail says WHAT, which is the
    // difference between a dead end and a fix.
    const r = (await tool(ReticleTool.ASSERT).handler(
      depsWith(FALSE_GREEN),
      assertSignal,
    )) as Verdict;
    const detail = (r.contradictions ?? [])
      .map((c) => `${c.claim} ${c.counter} ${c.detail ?? ''}`)
      .join(' ');
    expect(detail).toContain('compose:generated');
    expect(detail).toContain('500');
  });

  it('stays clean when the same request SUCCEEDED — no contradiction to report', async () => {
    // The control. A plumbing that reported a contradiction unconditionally would turn every green
    // into an unknown, which is the opposite failure and just as damaging.
    // The DOM_ADDED matters and is not padding: a write that succeeds while the client shows no
    // movement is ITSELF a contradiction (`response-ignored`), and rightly so. Leaving it out
    // produced a "clean" case that was not clean — the engine caught me constructing a bad control.
    const ok: ReticleEvent[] = [
      ev(EventType.SIGNAL, { name: 'compose:generated' }),
      ev(EventType.NET_REQUEST, {
        method: 'POST',
        url: 'http://localhost:8787/api/generate-script',
        status: 200,
      }),
      ev(EventType.DOM_ADDED, { role: 'generic', name: '' }, 6),
    ];
    const r = (await tool(ReticleTool.ASSERT).handler(depsWith(ok), assertSignal)) as Verdict;
    expect(r.pass).toBe(true);
    expect(r.verifiedReason).toBe(VerifiedReason.PROVED);
    expect(r.contradictions ?? []).toHaveLength(0);
  });
});
