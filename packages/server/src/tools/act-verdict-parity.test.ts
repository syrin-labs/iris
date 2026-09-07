/**
 * Both verdict paths must look at the same evidence for the same question.
 *
 * `reticle_act_and_wait` is the tool the product tells agents to reach for first — it is named in
 * the MCP handshake, in SKILL.md, and in the cheatsheet. `reticle_assert` is the other one. They
 * answer the same question and they were not reading the same inputs: `assert` passed `prior` to
 * the contradiction engine and `act_and_wait` did not.
 *
 * `prior` is what makes `unit-mismatch` possible — the money false green, where a total renders 100x
 * off because a value in minor units is displayed as major. A scale error disagrees with a value the
 * API stated EARLIER in the session, so an action-scoped window can never contain both halves. No
 * `prior`, no comparison, no finding.
 *
 * So the flagship detector could not fire on the flagship path, and nothing anywhere said so: the
 * finding was not suppressed or downgraded, it was simply never produced. That is the same shape as
 * the three wiring defects already fixed this release — a capability that exists, is tested, and
 * never reaches the caller.
 *
 * This pins the property rather than the plumbing: whatever the two paths pass, they must agree on
 * the inputs that decide which contradiction kinds are REACHABLE.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlindSpotKind,
  ReticleCommand,
  SessionState,
  Verified,
  VerifiedReason,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { LastAct } from '../session/last-act.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

const src = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8');

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

function createParitySessionDeps(blindSpots: Record<string, number>): ToolDeps {
  const noEvents: ReticleEvent[] = [];
  const command = (name: string): Promise<CommandResult> => {
    if (name === ReticleCommand.MATCH) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q1',
        ok: true,
        result: { matched: false, count: 0, elements: [] },
      });
    }
    return Promise.resolve({
      kind: 'command_result',
      id: 'c1',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
    });
  };
  const session: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    recordAction: () => 'a1',
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => blindSpots,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}

describe('act_and_wait and assert see the same evidence', () => {
  const act = src('act-tools.ts');
  const assert = src('assert-verdict.ts');

  it('both paths pass `prior` to the contradiction engine', () => {
    // Without this on the act path, `unit-mismatch` cannot fire there at all.
    expect(act).toMatch(/findContradictions\([\s\S]{0,200}prior/);
    expect(assert).toMatch(/findContradictions\([\s\S]{0,120}prior/);
  });

  it('both compute `prior` as everything strictly before the window', () => {
    // Same definition on both sides — a `prior` that overlapped the window would let an event be
    // both the claim and the counter-evidence.
    const shape = /queryEvents\(\{ since: 0 \}\)\)\.filter\(\(e\) => e\.t < since\)/;
    expect(act).toMatch(shape);
    expect(assert).toMatch(shape);
  });

  it('act_and_wait still passes the action and its effect — prior is added, not swapped', () => {
    expect(act).toMatch(/findContradictions\([\s\S]{0,450}action: acted/);
    expect(act).toMatch(/findContradictions\([\s\S]{0,450}session\.lastAct\.effect\(\)/);
  });

  /**
   * The declaration the caller wrote before acting has to reach the detector on BOTH paths. A fix
   * that lived only on `act_and_wait` would leave `reticle_assert` — the other half of the verdict
   * surface — still reporting an expected failure as a contradiction.
   */
  it('both paths hand the caller-declared expectations to the contradiction engine', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaredExpectations\(/);
      expect(file).toMatch(/expectedFailures:/);
      expect(file).toMatch(/renderProved:/);
      expect(file).toMatch(/namedNetIsInFlight\(/);
      expect(file).toMatch(/namedRequestInFlight:/);
    }
  });

  /**
   * Both verdict paths have to say which document is on screen, or the engine scopes nothing.
   *
   * The scoping is inert without it — `isSameDocument` reads an unknown current document as "counts
   * as current", which is right for an older SDK and wrong for a caller that simply forgot. A path
   * that stopped passing it would go on citing a replaced page's traffic with every gate green.
   */
  it('both paths tell the contradiction engine which document is on screen', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/currentDocumentId: session\.currentDocumentId/);
    }
  });

  /**
   * The caller's declaration has to reach the RULE, not only the detector.
   *
   * A satisfied `until` decides the verdict and settlement only corroborates it — but the rule
   * cannot tell a declared consequence from the implicit "wait for idle" unless the caller says so,
   * and a fix that reached only one of these two tools would leave half the verdict surface still
   * answering `unknown` to a consequence its caller named and Reticle watched hold.
   */
  it('both paths tell the rule whether the caller DECLARED the consequence', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaredConsequence:[\s\S]{0,60}!== PredicateKind\.SETTLED/);
    }
  });

  /**
   * An unread 2xx body is not a veto when the caller already proved the action on a channel the
   * body does not own. Both verdict paths have to say so, or half the surface still answers
   * `unknown` to a unique row the caller named and Reticle watched land.
   */
  it('both paths tell the rule when that declaration is independent of the response body', () => {
    for (const file of [act, assert]) {
      expect(file).toMatch(/declaresBodyIndependentChannel\(/);
      expect(file).toMatch(/independentOfBody: true/);
    }
  });

  it('both paths name what kept the page busy when nothing was left in flight', () => {
    for (const file of [act, assert]) expect(file).toMatch(/repeated: repeatedRequestLabels\(/);
  });

  it('prior is documented as learning material, so nobody later attributes findings to it', () => {
    // Attribution must stay window-scoped on both paths: `prior` explains a value, it never sources
    // a finding. Stated in both files because the next person will read only one of them.
    expect(act).toMatch(/[Ll]earning material/);
    expect(assert).toMatch(/LEARNING material/);
  });

  it('both paths report identical absenceBlindSpot verdicts and notes when an unobserved region is present', async () => {
    const deps = createParitySessionDeps({ [BlindSpotKind.CLOSED_SHADOW_ROOT]: 1 });

    const assertRes = (await tool(ReticleTool.ASSERT).handler(deps, {
      predicate: { kind: 'element', query: { by: 'testid', value: 'target-row' }, absent: true },
      timeout_ms: 0,
    })) as Record<string, unknown>;

    const actRes = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'e1',
      action: 'click',
      until: { kind: 'element', query: { by: 'testid', value: 'target-row' }, absent: true },
    })) as Record<string, unknown>;

    expect(assertRes['verified']).toBe(Verified.UNKNOWN);
    expect(assertRes['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);

    expect(actRes['verified']).toBe(Verified.UNKNOWN);
    expect(actRes['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);

    expect(assertRes['because']).toBe(actRes['because']);
  });
});
