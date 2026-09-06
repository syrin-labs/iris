import { z } from 'zod';
import { sessionRoot } from '../project/session-root.js';
import { verdictForSuite } from './verify-change-verdict.js';
import { attributedFailures } from './attributed-failure.js';
import { Verified } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { asNumber, asRecord, asString } from '../tools/tools-helpers.js';
import { workerCountSchema } from '../tools/numeric-bounds.js';
import { loadNamedFlows, resolveChangedFiles } from '../cli/cli-flow-commands.js';
import { affectedSavedFlows } from './flow-sources.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { findContradictions } from '../events/contradictions.js';
import { parseControls } from '../tools/coverage-tools.js';
import { ReticleCommand, SnapshotMode } from '@reticlehq/core';

/**
 * `reticle_verify_change` — the regression loop in one call.
 *
 * The agent's real question after an edit is "did I break anything", and answering it took four
 * tools it had to know to chain: work out which saved flows the diff invalidates, replay that
 * subset, then separately go looking for contradictions and untouched controls. Every piece already
 * existed; nothing composed them, so the loop was only run by an agent that already knew the recipe.
 *
 * The honesty guard is the whole design. NO FLOWS COVERING A CHANGE IS `unknown`, NEVER `yes` —
 * "nothing ran" and "everything passed" are the same green to anyone reading a boolean, and treating
 * an uncovered change as verified is the exact false green this project exists to remove. `cli-verify`
 * already refuses to return a green pass with no flows; this applies the same rule on the MCP side.
 */

/** Flow names are echoed so a caller can see WHICH flows stood behind the verdict. */
interface SuiteResult {
  status?: string;
  total?: number;
  passed?: number;
  failed?: number;
  summary?: string;
  failures?: unknown[];
}

export const VERIFY_CHANGE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VERIFY_CHANGE,
    description:
      'Did my change break anything? Give it the files you edited (or `since` for a git ref) and it works out which saved flows cover them, replays exactly those, and answers with one `verified` (yes|no|unknown) plus `because`. `unknown` when NO saved flow covers the change — that is the honest answer, never a green: nothing ran, so nothing was proved. Returns { verified, because, changedFiles, flowsRun, suite, unknownProvenance }.',
    example: { files: ['src/App.tsx'] },
    inputSchema: {
      files: z
        .array(z.string())
        .optional()
        .describe('Changed file paths, repo-relative (e.g. ["src/App.tsx"]).'),
      since: z
        .string()
        .optional()
        .describe('Git ref to diff against (e.g. "HEAD~1", "main"). Unioned with `files`.'),
      parallel: workerCountSchema
        .optional()
        .describe('Replay this many affected flows at once (needs the browser pool).'),
      sessionId: z
        .string()
        .optional()
        .describe('OMIT THIS unless you mean a specific tab — Reticle resolves it.'),
    },
    outputSchema: {
      verified: z
        .string()
        .describe(
          'yes | no | unknown. `unknown` means the evidence could not decide — most often that no saved flow covers these files, which is NOT a pass.',
        ),
      because: z.string(),
      changedFiles: z.array(z.string()),
      flowsRun: z.array(z.string()),
      suite: z.unknown().optional(),
      // Session-EXEMPT: declare the one-shot human feedback ask or a validating profile strips it.
      feedback_prompt: z.unknown().optional(),
      unknownProvenance: z.array(z.string()),
      contradictions: z
        .array(z.unknown())
        .optional()
        .describe(
          'Channels that disagreed DURING the replay. Any entry forces verified:"no" even when every flow passed — a suite that goes green over a failed write is the false green this exists to catch. OMITTED when clean; see `measured` when it could not be looked for.',
        ),
      untouched: z
        .array(z.unknown())
        .optional()
        .describe(
          'Controls on the page that the covering flows never drove. A green over a small untouched list is stronger evidence than the same green over a large one.',
        ),
      measured: z
        .array(z.string())
        .describe(
          'What was actually looked for. An absent `contradictions` means "none found" ONLY if "contradictions" appears here — otherwise it was never measured.',
        ),
    },
    handler: async (deps: ToolDeps, args) => {
      const files = Array.isArray(args['files'])
        ? (args['files'] as unknown[]).filter((f): f is string => 'string' === typeof f)
        : [];
      const since = asString(args['since']);
      const changedFiles = await resolveChangedFiles(files, since);
      // Same root flow_save wrote to. A read that resolved differently would report "no flows
      // covered this change" over flows that exist, which reads as a clean result rather than
      // an error, so the disagreement would be invisible.
      const flows = await loadNamedFlows(deps.fs, sessionRoot(deps, asString(args['sessionId'])));
      const { affected, unknownProvenance } = affectedSavedFlows(flows, changedFiles);

      if (0 === changedFiles.length) {
        return {
          verified: Verified.UNKNOWN,
          because: 'no changed files were given, so there was nothing to decide about',
          changedFiles,
          flowsRun: [],
          unknownProvenance,
          // Nothing was looked for, and the schema requires this field to say so. Omitting it made
          // the MCP layer reject the whole response, turning an honest UNKNOWN into a protocol error.
          measured: [],
        };
      }

      // The guard: an uncovered change is UNKNOWN. Reporting `yes` here would mean "your change is
      // fine" on the strength of having run nothing at all.
      if (0 === affected.length) {
        return {
          verified: Verified.UNKNOWN,
          because: `no saved flow covers ${1 === changedFiles.length ? 'this file' : 'these files'} — record one with reticle_record { action: "start" } then reticle_flow_save, or verify by driving the app directly`,
          changedFiles,
          flowsRun: [],
          unknownProvenance,
          // No flow ran, so nothing was measured — said explicitly rather than left undefined.
          measured: [],
        };
      }

      const provenanceNote =
        unknownProvenance.length > 0
          ? ` (${String(unknownProvenance.length)} of them re-run only because Reticle cannot tell which sources they cover)`
          : '';

      // Marked BEFORE the replay so the contradiction sweep afterwards reads exactly the window the
      // flows produced, and never events from whatever the agent did before calling this.
      const cursor = cursorBeforeReplay(deps, args);

      const verify = FLOW_TOOLS.find((tool) => tool.name === ReticleTool.FLOW_VERIFY);
      if (verify === undefined) throw new Error('the whole-suite replay tool is not registered');
      const suite = asRecord(
        await verify.handler(deps, {
          names: affected,
          ...(asNumber(args['parallel']) === undefined ? {} : { parallel: args['parallel'] }),
          ...(asString(args['sessionId']) === undefined ? {} : { sessionId: args['sessionId'] }),
        }),
      ) as SuiteResult;

      const failed = suite.failed ?? 0;
      const passed = suite.passed ?? 0;

      // `unverifiable` is NOT a failure — the suite ran and proved nothing, which is the same fact
      // this tool answers UNKNOWN for an uncovered change. Treating it as a red emitted a bug_found
      // that nothing earned. See verify-change-verdict.
      const verdict = verdictForSuite(String(suite.status), failed);
      // A NO must be EARNED by a failing flow genuinely tied to the changed files. `affectedSavedFlows`
      // re-runs any flow whose sources it cannot determine — over-running beats skipping — and those
      // land in `unknownProvenance`. Judging the change on them produced a negative verdict whose own
      // explanation admitted the evidence was not tied to the file. See attributed-failure.
      const failingNames = Array.isArray(suite.failures)
        ? suite.failures
            .map((f) =>
              'object' === typeof f && f !== null ? asString(asRecord(f)['flow']) : undefined,
            )
            .filter((n): n is string => n !== undefined)
        : // No per-failure detail: the failure is somewhere in the set that ran, so ask the question
          // of all of them rather than guessing which.
          affected;
      const attributed = attributedFailures(failingNames, unknownProvenance);
      const earnedNo = verdict === Verified.NO && attributed.length > 0;
      const reported = verdict === Verified.NO && !earnedNo ? Verified.UNKNOWN : verdict;
      if (reported !== Verified.YES) {
        return {
          verified: reported,
          because: earnedNo
            ? `${String(failed)} of ${String(suite.total ?? affected.length)} covering flows failed, including ${attributed.join(', ')}, which cover the changed files${provenanceNote}`
            : verdict === Verified.NO
              ? `flows failed, but Reticle cannot tell which sources any of them cover (${failingNames.join(', ')}) — so this says nothing about the files you changed. Re-record them so their sources are stamped, or read the replay yourself`
              : `the covering flows ran but proved nothing (${String(suite.status)}) — they assert no observable consequence, so a green from them would not have meant your change is safe${provenanceNote}`,
          changedFiles,
          flowsRun: affected,
          suite,
          unknownProvenance,
          measured: ['flows'],
        };
      }

      // The suite went green. That is exactly when the remaining two channels are worth reading:
      // a replay that passes while a write fails is the false green this whole product is about.
      const extra = await inspectAfterReplay(deps, args, cursor);
      if (extra.contradictions.length > 0) {
        const kinds = extra.contradictions.map((c) => c.kind).join(', ');
        return {
          verified: Verified.NO,
          because: `every covering flow passed, but channels disagreed during the replay (${kinds}) — a green suite over a failed write is the false green worth looking at${provenanceNote}`,
          changedFiles,
          flowsRun: affected,
          suite,
          unknownProvenance,
          contradictions: extra.contradictions,
          ...(extra.untouched === undefined ? {} : { untouched: extra.untouched }),
          measured: extra.measured,
        };
      }

      return {
        verified: Verified.YES,
        because: `all ${String(passed)} flows covering these files passed${provenanceNote}${extra.untouched === undefined ? '' : `, with ${String(extra.untouched.length)} controls left undriven`}`,
        changedFiles,
        flowsRun: affected,
        suite,
        unknownProvenance,
        ...(extra.untouched === undefined ? {} : { untouched: extra.untouched }),
        measured: extra.measured,
      };
    },
  },
];

/** The event cursor to sweep from, or 0 when there is no readable session (nothing to sweep). */
function cursorBeforeReplay(deps: ToolDeps, args: Record<string, unknown>): number {
  try {
    return deps.sessions.resolve(asString(args['sessionId'])).elapsed();
  } catch {
    return 0;
  }
}

interface AfterReplay {
  contradictions: { kind: string }[];
  untouched?: { ref: string; label: string }[];
  measured: string[];
}

/**
 * Read the two channels a suite verdict cannot see: did anything DISAGREE during the replay, and
 * what did the flows never touch.
 *
 * Both are skipped when the flows ran in parallel leased contexts, because the events and driven
 * refs then belong to those leases rather than to the session read here. Reporting "no
 * contradictions" from the wrong session would be a false green produced by the false-green
 * detector, so `measured` states what was actually looked for and the caller is never left to infer
 * it from an absent field.
 */
async function inspectAfterReplay(
  deps: ToolDeps,
  args: Record<string, unknown>,
  cursor: number,
): Promise<AfterReplay> {
  if (asNumber(args['parallel']) !== undefined) {
    return { contradictions: [], measured: ['flows'] };
  }
  try {
    const session = deps.sessions.resolve(asString(args['sessionId']));
    const contradictions = findContradictions(session.eventsSince(cursor), {
      currentDocumentId: session.currentDocumentId,
      currentEditEpoch: session.currentEditEpoch,
      appOrigin: session.url,
      // The replay is the action, and the cursor is where it started.
      actionSince: cursor,
    }) as { kind: string }[];
    const snapshot = await session.command(ReticleCommand.SNAPSHOT, {
      mode: SnapshotMode.INTERACTIVE,
    });
    const tree = snapshot.ok ? (asString(asRecord(snapshot.result)['tree']) ?? '') : '';
    const acted = session.actedRefs();
    const untouched = parseControls(tree).filter((c) => !acted.has(c.ref));
    return { contradictions, untouched, measured: ['flows', 'contradictions', 'coverage'] };
  } catch {
    // A session that went away after the replay is not evidence of cleanliness.
    return { contradictions: [], measured: ['flows'] };
  }
}
