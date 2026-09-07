import { z } from 'zod';
import { noteEmptyRead } from '../tools/observed-nothing.js';
import {
  AGENT_ASK_NOTICE,
  AGENT_WAITING_NOTICE,
  PresenterTone,
  SessionState,
  YIELD_WITHOUT_SESSION_NOTE,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { asString } from '../tools/tools-helpers.js';
import type { ToolDef } from '../tools/tools.js';

/**
 * Is this a turn ending with nothing attached, rather than a call about a specific tab?
 *
 * Only true when the caller named NO session and none is connected. Ending a turn is a statement
 * about the agent, not about a tab, so it must not fail merely because no app was ever wired — that
 * made a call documented as MANDATORY fail in the most common state a daemon is in, and the agents
 * that hit it stopped calling it and wrote the gap into prose instead.
 *
 * Naming a session that does not exist stays an error. That is a mistake about WHICH tab you are
 * talking to, and swallowing it would hide a real one.
 */
function endingTurnWithNothingAttached(deps: { sessions: { count(): number } }, id?: string) {
  return id === undefined && 0 === deps.sessions.count();
}

/**
 * Live-control agent tools: the agent's side of the human-in-the-loop control surface.
 *
 * - reticle_end_session: terminal stop. Sets state `ended` and syncs the panel (PRESENTER) with an
 * optional summary. Idempotent — ending an already-ended session is a safe no-op.
 * - reticle_resume: clears a human pause. Sets state `active` and syncs the panel.
 * - reticle_messages: explicit poll — drains and returns the queued human notes.
 *
 * State changes go through `setState`, which echoes the state to the panel in a SINGLE PRESENTER
 * push (optionally carrying human-facing text, e.g. the end summary) — a transition never emits two
 * PRESENTER commands. No clock is read here — inbox stamps were assigned by the session's injected
 * elapsed clock at enqueue time.
 */
export const LIVE_CONTROL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.END_SESSION,
    description:
      'End this session for good — use ONLY when the whole task is complete. Sets state "ended" ' +
      '(calm, terminal) and shows the optional `summary` on the panel. If you are just finishing a ' +
      'turn or waiting on the human, call reticle_session{action:"yield"} instead (revivable). Idempotent.',
    inputSchema: { summary: z.string().optional(), ...sessionIdShape },
    // `sessionId` is optional because there may genuinely not be one — see the no-op below. An
    // empty string would read as a real id in a log, which is worse than its absence.
    outputSchema: {
      ended: z.boolean(),
      sessionId: z.string().optional(),
      note: z.string().optional(),
    },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      if (endingTurnWithNothingAttached(deps, requested)) {
        return Promise.resolve({ ended: true, note: YIELD_WITHOUT_SESSION_NOTE });
      }
      const session = deps.sessions.resolve(requested);
      // One PRESENTER push for the transition; the optional summary rides the same push.
      session.setState(SessionState.ENDED, asString(args['summary']));
      return Promise.resolve({ ended: true, sessionId: session.id });
    },
  },
  {
    name: ReticleTool.YIELD,
    description:
      'MANDATORY before you stop driving and hand control back to the human — call this whenever you ' +
      'finish a turn or need to wait on them, so the panel never falsely shows the agent as live. ' +
      'mode:"waiting" = you are done responding and will continue on their next message. ' +
      'mode:"ask" = you are blocked and need an answer first; put the question in `note` so it shows ' +
      'on the panel. The session is REVIVED automatically on your next tool call, so you never need to ' +
      'reopen it. Use reticle_session{action:"end"} instead only when the whole task is truly complete.',
    inputSchema: {
      mode: z
        .enum([PresenterTone.WAITING, PresenterTone.ASK])
        .describe('"waiting" = turn done, will resume; "ask" = blocked, need the human to answer.'),
      note: z
        .string()
        .optional()
        .describe('For mode:"ask", the question to show the human on the panel.'),
      ...sessionIdShape,
    },
    outputSchema: {
      yielded: z.boolean(),
      mode: z.string(),
      sessionId: z.string().optional(),
      note: z.string().optional(),
    },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      const ask = asString(args['mode']) === PresenterTone.ASK;
      if (endingTurnWithNothingAttached(deps, requested)) {
        return Promise.resolve({
          yielded: true,
          mode: ask ? PresenterTone.ASK : PresenterTone.WAITING,
          note: YIELD_WITHOUT_SESSION_NOTE,
        });
      }
      const session = deps.sessions.resolve(requested);
      const note = asString(args['note']);
      const tone = ask ? PresenterTone.ASK : PresenterTone.WAITING;
      const text =
        ask && note !== undefined && note.trim().length > 0
          ? `${AGENT_ASK_NOTICE}: ${note.trim()}`
          : ask
            ? AGENT_ASK_NOTICE
            : AGENT_WAITING_NOTICE;
      // autoEnd = revivable end: the panel reflects the handoff now, the agent's next call revives it.
      session.autoEnd(text, tone);
      return Promise.resolve({
        yielded: true,
        mode: ask ? PresenterTone.ASK : PresenterTone.WAITING,
        sessionId: session.id,
      });
    },
  },
  {
    name: ReticleTool.RESUME,
    description:
      'Clear a human pause and resume driving the page. Sets state "active" and syncs the panel ' +
      '(PRESENTER). Call after you have addressed the human guidance returned by a paused reticle_act.',
    inputSchema: { ...sessionIdShape },
    outputSchema: { ok: z.boolean() },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // setState echoes ACTIVE to the panel in a single PRESENTER push.
      session.setState(SessionState.ACTIVE);
      return Promise.resolve({ ok: true });
    },
  },
  {
    name: ReticleTool.MESSAGES,
    description:
      'Drain and return any messages the human queued from the panel since the last poll. Use to ' +
      'explicitly check for human guidance without acting.',
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      messages: z.array(z.unknown()),
      delivered: z
        .array(z.unknown())
        .optional()
        .describe(
          'Present ONLY when this poll found nothing new but the human HAS spoken this session: everything they said, including what was already handed to you inline on an earlier tool result. An empty `messages` never means silence.',
        ),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const messages = session.drainInbox();
      if (messages.length > 0) return Promise.resolve({ messages });
      // Nothing NEW is not the same as nothing said. The inbox has two consumers — this poll and the
      // control envelope spliced onto every tool result — and delivery is destructive, so a message
      // handed over inline moments ago left this call reporting an empty queue with a note that read
      // as "the human has said nothing". Reported from the field, from both ends: the agent believed
      // it, and the person who typed the message got silence with no sign it had been seen.
      const history = session.inboxHistory();
      if (history.length > 0) {
        return Promise.resolve({
          messages,
          delivered: [...history],
          note:
            `nothing NEW since your last poll — but the human has sent ` +
            `${String(history.length)} message(s) this session, listed in \`delivered\`. They were ` +
            `handed to you inline on an earlier tool result, which is why this queue is empty. An ` +
            `empty \`messages\` never means the human has said nothing.`,
        });
      }
      // An empty inbox and a panel that is not wired both return `[]`. The first means the human has
      // said nothing; the second means an agent is waiting on a channel that does not exist.
      return Promise.resolve(
        noteEmptyRead({ messages }, 'messages', {
          noun: 'messages from the human since the last poll',
        }),
      );
    },
  },
  {
    name: ReticleTool.REVIEW,
    description:
      'List the mistakes the human pinned to elements on the running page (the "annotate the bug ' +
      'where you see it" loop), then resolve each once you have fixed it. Each pending mark carries ' +
      'the human note, the element label, and — when the framework stamped it — the source file:line ' +
      'to open, plus a ready-to-act `fix` hint. After applying a fix, call again with ' +
      '`{ resolve: "<id>" }` to retire that mark. Reading does NOT consume a mark, so you can list, ' +
      'fix, verify, then resolve.',
    inputSchema: {
      resolve: z
        .string()
        .optional()
        .describe('A mark id (e.g. "m1") to retire after you have fixed it. Omit to just list.'),
      all: z
        .boolean()
        .optional()
        .describe('Include already-resolved marks in the listing (default: pending only).'),
      ...sessionIdShape,
    },
    outputSchema: {
      marks: z.array(z.unknown()),
      pendingCount: z.number(),
      resolved: z.boolean().optional(),
      resolvedNote: z
        .string()
        .optional()
        .describe(
          'The note on the mark that was actually retired. CHECK IT against the mark you meant to resolve: a bare `resolved:true` cannot tell you it closed the right one, and ids are only meaningful while the session that issued them lives.',
        ),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const resolveId = asString(args['resolve']);
      let resolved: boolean | undefined;
      let resolvedNote: string | undefined;
      if (resolveId !== undefined) {
        // Grab the note BEFORE retiring it so we can close the loop visually for the human.
        const mark = session.allMarks().find((m) => m.id === resolveId);
        resolved = session.resolveMark(resolveId);
        if (resolved && mark !== undefined) {
          // Echoed back to the CALLER too, not only to the panel. A bare `resolved:true` is equally
          // consistent with "I retired the bug you fixed" and "I retired somebody else's", and an
          // agent hit exactly that — it closed a mark the human had recorded minutes later while
          // the two it had actually fixed vanished with no record.
          resolvedNote = mark.note;
          // The human watching the panel sees their flagged bug get marked fixed (fire-and-forget).
          session.pushNarration(`✓ fixed: ${mark.note}`);
        }
      }
      const source = true === args['all'] ? session.allMarks() : session.pendingMarks();
      const marks = source.map((m) => ({ ...m, fix: buildFixHint(m) }));
      const out: {
        marks: typeof marks;
        pendingCount: number;
        resolved?: boolean;
        resolvedNote?: string;
      } = {
        marks,
        pendingCount: session.pendingMarkCount(),
      };
      if (resolved !== undefined) out.resolved = resolved;
      if (resolvedNote !== undefined) out.resolvedNote = resolvedNote;
      return Promise.resolve(out);
    },
  },
];

/**
 * The single actionable next-move for a pending mark: point the agent at the source (or the element
 * label when no file:line was stamped), echo the human's note, and name the resolve call. Keeping
 * the recovery hint here means the agent is never left guessing what to do with a mark.
 */
function buildFixHint(m: {
  id: string;
  note: string;
  label?: string;
  source?: { file: string; line: number };
}): string {
  const where =
    m.source !== undefined
      ? `Open ${m.source.file}:${String(m.source.line)}`
      : m.label !== undefined
        ? `Find the "${m.label}" element`
        : 'Find the flagged element';
  return `${where} and fix: ${m.note}. Then call reticle_session { action: "review", resolve: "${m.id}" }.`;
}
