import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { BUFFER_EVICTION_WARNING, SessionState, Verified, VerifiedReason } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';
import { EventType, type ReticleEvent } from '@reticlehq/core';

/**
 * The worst answer a verification layer can give is a confident green that rests on evidence it no
 * longer has. `reticle_assert { kind:'console', absent:true }` concludes "no errors" from the ring
 * buffer — which evicts on an age and size cap — so on a flow longer than the buffer's window, an
 * error logged early is gone by the time the assertion runs, and the verdict is `pass:true`.
 *
 * reticle_console has always disclosed this for the same window. The verdict path, which is the one
 * an agent actually gates on, did not. These tests pin the disclosure onto the verdict.
 *
 * The block stays OMITTED when nothing was dropped: silence has to keep meaning "the buffer was
 * intact", or it becomes noise on every healthy call and gets ignored.
 */
function depsWithBuffer(
  dropped: number,
  lastActSource?: string,
  lost = false,
  events: ReticleEvent[] = [],
): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: ((): LastAct => {
      const a = new LastAct();
      a.markSource(lastActSource);
      return a;
    })(),
    bufferHealth: () => ({ total: 12, dropped }),
    lostSince: () => lost,
    blindSpots: () => ({}),
    eventsSince: () => events,
    queryEvents: () => Promise.resolve(events),
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const absentConsole = {
  predicate: { kind: 'console', level: 'error', absent: true },
  timeout_ms: 0,
};

describe('a verdict reached over an evicted buffer says so', () => {
  it('reticle_assert discloses eviction on a PASSING absence assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(7), absentConsole)) as {
      pass: boolean;
      buffer?: { dropped: number; note: string };
    };
    expect(result.pass).toBe(true);
    expect(result.buffer?.dropped).toBe(7);
    expect(result.buffer?.note).toBe(BUFFER_EVICTION_WARNING);
  });

  it('stays silent when the buffer is intact — silence must keep meaning trustworthy', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(0), absentConsole)) as {
      pass: boolean;
      buffer?: unknown;
    };
    expect(result.pass).toBe(true);
    expect(result.buffer).toBeUndefined();
  });

  it('declares buffer in its output schema, or a strict client never sees it', () => {
    for (const name of [ReticleTool.ASSERT, ReticleTool.WAIT_FOR]) {
      expect(Object.keys(tool(name).outputSchema ?? {})).toContain('buffer');
    }
  });
});

/**
 * A failure with no ELEMENT still has a place to send the agent.
 *
 * "the signal never fired", "the request was never made", "the store did not change" have no DOM node
 * to map to a component — so the file:line work that covers element failures leaves exactly the
 * failures that most need explaining with no destination. But the handler that should have fired the
 * signal lives with the control that was clicked, and the act path already captures that control's
 * source. Carrying it onto the verdict turns "nothing happened" into "nothing happened, and the code
 * that should have made it happen is here".
 *
 * Only on RED, and only when an act actually preceded the assertion.
 */
describe('a non-element failure still names a file', () => {
  const missingSignal = {
    predicate: { kind: 'signal', name: 'compose:generated' },
    timeout_ms: 0,
  };

  it("attaches the last acted control's source to a failing signal assertion", async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, 'src/views/Compose.tsx:60'),
      missingSignal,
    )) as { pass: boolean; source?: string };
    expect(result.pass).toBe(false);
    expect(result.source).toBe('src/views/Compose.tsx:60');
  });

  it('does not attach it to a PASSING assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, 'src/views/Compose.tsx:60'),
      { predicate: { kind: 'console', level: 'error', absent: true }, timeout_ms: 0 },
    )) as { pass: boolean; source?: string };
    expect(result.pass).toBe(true);
    expect(result.source).toBeUndefined();
  });

  it('says nothing when no act preceded the assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(0), missingSignal)) as {
      pass: boolean;
      source?: string;
    };
    expect(result.pass).toBe(false);
    expect(result.source).toBeUndefined();
  });
});

/**
 * The `buffer` block above discloses the RAW drop counter, and ring-buffer.ts says in as many words
 * that the counter cannot answer "was the capture clean": it moves for the age eviction that runs on
 * every push and for the churn floor that is sacrificed on purpose. `lostSince` is the honest input —
 * did this buffer evict SCARCE evidence belonging to the window opened at `since`.
 *
 * act_and_wait passes it as `truncated`, and `decideVerified` turns a dirty capture into UNKNOWN /
 * unclean_capture, because the evidence is ABSENT rather than negative. reticle_assert never consulted
 * it, on the reasoning that it "observes an already-open window" — but eviction happens on push,
 * regardless of who opened the window, and assert reads the same buffer over an arbitrary `since`.
 *
 * So the same loss in the same window returned `unknown` through one half of the verdict surface and
 * `yes` through the other — and assert is the half agents call most. An absence assertion is where it
 * bites hardest: the evicted error is exactly the evidence that would have made it fail.
 */
describe('assert does not grade a window the buffer lost evidence from', () => {
  it('refuses a green when scarce evidence from this window was evicted', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true),
      absentConsole,
    )) as { verified?: string; verifiedReason?: string };
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('still grades normally when the window is intact', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, false),
      absentConsole,
    )) as { verified?: string; verifiedReason?: string };
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });

  // The counter moving is NOT loss from this window — that conflation is what made unclean_capture
  // the dominant cause of unknown in the field once already.
  it('a moving drop counter alone does not impeach the verdict', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(7, undefined, false),
      absentConsole,
    )) as { verified?: string };
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });
});

/**
 * ...but only for an ABSENCE claim, and this is the correction to the rule above.
 *
 * `#noteScarceLoss` fires for AGE eviction too — every non-churn event past the 60s cutoff — so
 * `lostSince(0)` is true on essentially any session older than a minute. The act path is unharmed
 * because its cursor is the action's own; `reticle_assert` takes a caller-chosen `since`, often 0.
 * Impeaching every verdict over a wide window turns "unknown" into the answer to everything, which
 * is the failure this repo has already paid for once.
 *
 * The distinction is the one absenceBlindSpotNote already draws. A POSITIVE assertion that passed
 * FOUND its evidence; events aged out elsewhere do not unmake it. An ABSENCE assertion concluded
 * "nothing is there" from a window that provably lost things, and the lost thing is exactly the
 * disproof.
 */
describe('buffer loss impeaches an absence claim, not every claim', () => {
  const netPresent = {
    predicate: { kind: 'net', urlContains: '/api' },
    timeout_ms: 0,
  };

  it('still grades a POSITIVE assertion over a window that aged out', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true),
      absentConsole,
    )) as { verified?: string };
    // the absence case stays unknown
    expect(result.verified).toBe(Verified.UNKNOWN);
  });

  // The predicate must actually HOLD here, or the test passes for the wrong reason: with no events a
  // positive assertion simply fails, and `no` is trivially "not unknown".
  const apiCall: ReticleEvent[] = [
    {
      t: 1,
      type: EventType.NET_REQUEST,
      sessionId: 'demo',
      data: { method: 'GET', url: 'http://localhost/api/items', status: 200, ok: true },
    },
  ];

  it('keeps a PASSING positive verdict green when the buffer merely aged', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true, apiCall),
      netPresent,
    )) as { verified?: string; pass?: boolean };
    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.YES);
  });
});

/**
 * `count: 0` is an absence claim, and the rule above did not know it (#668).
 *
 * `restsOnCompleteWindow` recognises `PredicateKind.NOT` and `absent: true`. It does not recognise
 * the third spelling of the same assertion — an exact cardinality of zero — so `{ kind: "net",
 * urlContains: "…", count: 0 }` was graded `yes` over a window the buffer had provably lost scarce
 * evidence from. That green rests entirely on the window being complete: the evicted call is exactly
 * the disproof, which is the definition the function's own doc comment gives for an absence claim.
 *
 * Reported by the second reporter on #668, in those words: `buffer.dropped` climbing well past `held`
 * on an `absent: true` / `count: 0` assertion, unable to tell whether their "no login request fired"
 * proof was real or an evicted-buffer artifact. They re-ran the whole flow on a fresh page to trust
 * it — which is what a verdict costs when it cannot say how sure it is.
 */
describe('an exact count of zero is an absence claim (#668)', () => {
  const noSignIn = {
    predicate: { kind: 'net', urlContains: '/api/auth/sign-in', count: 0 },
    timeout_ms: 0,
  };

  it('refuses a green when scarce evidence from this window was evicted', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true),
      noSignIn,
    )) as { pass?: boolean; verified?: string; verifiedReason?: string };

    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('still grades it normally when the window is intact', async () => {
    // The green must survive a clean window, or the fix has simply traded a false yes for a useless
    // unknown on every absence assertion anyone writes.
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, false),
      noSignIn,
    )) as { pass?: boolean; verified?: string };

    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.YES);
  });

  it('leaves a NON-zero count alone, which is a positive claim', async () => {
    // `count: 2` asserts calls were MADE. It found what it found, and events aged out elsewhere in
    // the buffer do not unmake them — the same reason a plain positive assertion is left alone.
    const twoCalls: ReticleEvent[] = [
      {
        t: 1,
        type: EventType.NET_REQUEST,
        sessionId: 'demo',
        data: { method: 'POST', url: 'http://localhost/api/save', status: 200, ok: true },
      },
      {
        t: 2,
        type: EventType.NET_REQUEST,
        sessionId: 'demo',
        data: { method: 'POST', url: 'http://localhost/api/save', status: 200, ok: true },
      },
    ];
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true, twoCalls),
      { predicate: { kind: 'net', urlContains: '/api/save', count: 2 }, timeout_ms: 0 },
    )) as { pass?: boolean; verified?: string };

    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.YES);
  });

  it('covers a signal count of zero too, which is the same claim on the other channel', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(0, undefined, true), {
      predicate: { kind: 'signal', name: 'checkout:submitted', count: 0 },
      timeout_ms: 0,
    })) as { pass?: boolean; verified?: string };

    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.UNKNOWN);
  });
});
