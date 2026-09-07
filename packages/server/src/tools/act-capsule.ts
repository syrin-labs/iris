/**
 * Persist a failed assertion as a replayable fail-to-pass capsule.
 *
 * : a red assertion is the ONE moment the evidence explaining it is in hand. Persist it as a
        // replayable fail-to-pass capsule so the bug survives the turn — and becomes a regression flow
        // the moment it goes green. Best-effort: capturing evidence must never fail the run that found it.
 *
 * Split out of act-tools.ts when it crossed the 600-line cap. The seam is real: this is the only
 * part of the act path that writes to disk, and it is best-effort by design — capturing evidence
 * must never fail the run that found it.
 */
import { ActionType, AnchorKind } from '@reticlehq/core';
import { CapsuleStore, capsuleId, CAPSULE_VERSION } from '../capsule/capsule-store.js';
import type { ExpectedLink } from '../capsule/divergence.js';
import type { DivergenceCapsule } from '../capsule/capsule.js';
import { ReticleTool } from './tool-names.js';
import { asRecord, asString } from './tools-helpers.js';
import type { ToolDeps } from './tool-kit.js';
import { sessionRoot } from '../project/session-root.js';

interface CapsuleSaveInputs {
  deps: ToolDeps;
  verdict: { pass: boolean; failureReason?: string };
  capsule?: DivergenceCapsule | undefined;
  links: readonly ExpectedLink[];
  args: Record<string, unknown>;
  actResult: { result?: unknown };
  actedSource?: { file: string; line: number };
  /**
   * The `.reticle` this capsule belongs in, from the session the act ACTUALLY drove.
   *
   * Passed in rather than re-resolved here, because re-resolving loses twice: `args.sessionId` is
   * frequently absent, and `sessions.resolve(undefined)` throws whenever more than one tab is
   * connected — which is precisely the multi-project case this routing exists for, so it failed in
   * exactly the situation it was written to fix. The caller also knows about a session the act
   * FOLLOWED through a navigation; this file cannot.
   */
  root?: string | undefined;
}

/** Returns the capsule id when one was written, or undefined when there was nothing to save. */
export async function saveFailedAssertCapsule(
  inputs: CapsuleSaveInputs,
): Promise<string | undefined> {
  const { deps, verdict, capsule, links, args, actResult, actedSource, root: given } = inputs;
  if (verdict.pass || capsule === undefined) return undefined;

  const id = capsuleId(deps.now(), asString(args['ref']) ?? 'assert');
  const expectedText = links
    .map((l) => ('name' in l ? `${l.kind} ${String(l.name)}` : l.kind))
    .join(' AND ');
  // The capsule belongs to the project whose app just failed, not to wherever the daemon stands.
  // Same rule and same resolver as every other artifact: a capsule written into a sibling repo is
  // evidence filed against a codebase that did not produce it, and it outlives the turn.
  // The caller's answer wins; the resolver is the fallback for callers that have no session.
  const root = given ?? sessionRoot(deps, asString(args['sessionId']));
  const saved = await new CapsuleStore(deps.fs, root).save({
    version: CAPSULE_VERSION,
    id,
    createdAt: deps.now(),
    origin: 'failed-assert',
    expected: expectedText.length > 0 ? expectedText : 'declared consequence',
    observed: capsule.firstDivergence?.observed ?? verdict.failureReason ?? 'not observed',
    steps: [
      {
        tool: ReticleTool.ACT,
        anchor: {
          kind: AnchorKind.TESTID,
          value: asString(asRecord(actResult.result)['testid']) ?? asString(args['ref']) ?? '',
          // Carried so the saved capsule — which outlives this turn and becomes a regression flow
          // when it goes green — still knows which file the failure came from.
          ...(actedSource === undefined ? {} : { source: actedSource }),
        },
        action: (asString(args['action']) ?? ActionType.CLICK) as ActionType,
      },
    ],
  });
  return saved ? id : undefined;
}
