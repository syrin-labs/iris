import { z } from 'zod';
import { IntentStore } from './intent-store.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { sessionRoot } from '../project/session-root.js';
import { asString } from '../tools/tools-helpers.js';
import type { ToolDef, ToolDeps } from '../tools/tool-kit.js';

/**
 * Declare what a change was SUPPOSED to make true, while somebody still knows.
 *
 * One tool with three actions rather than three tools, because the surface is capped and because an
 * agent that has to discover three names to use one idea uses none of them.
 *
 * There is deliberately no `discharge` action. A verdict discharges an intent by satisfying its
 * binding, and a discharge an agent has to remember to file would be the same forgetting problem
 * this exists to solve, moved one layer up.
 */

const DECLARE = 'declare';
const LIST = 'list';
const BIND = 'bind';
/* The sharded store's surface. Same tool, because a second tool name is a second thing to discover. */
const INDEX = 'index';
const SUBJECT = 'subject';
const GET = 'get';
const RECORD = 'record';
const MIGRATE = 'migrate';

export const INTENT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.INTENT,
    description:
      'Record what a change is SUPPOSED to make true, as a durable statement ABOUT THE PRODUCT that a teammate who was not here will understand in six months — name the behaviour, not this run or its step number, and never "renders cleanly", which nothing can check. It is SHARED memory: pooled per project and read back by later agents. Capture it while you still know — then verification does not have to re-derive it from the DOM later. { action:"declare", intents:[{ id, statement, surface? }] } takes prose and needs NO predicate: at declare time there is often no route, no ref and no code yet, and a predicate demanded there is just a mechanism. Declare EARLY (as you build) and batch them — one call per feature is the whole budget. { action:"bind", id, binding } attaches the predicate that would prove it once you know how; an intent with no binding is not a failure, it is the most interesting row in the ledger — something meant that nothing can currently prove. { action:"list" } returns what is still open. Stored in .reticle/intent.json, git-checked so a human sees in review if an intent was later narrowed to match what was easy to prove.',
    example: {
      action: DECLARE,
      intents: [
        { id: 'checkin', statement: 'clicking Send check-in makes the badge read "checked in"' },
      ],
    },
    inputSchema: {
      action: z.enum([DECLARE, LIST, BIND, INDEX, SUBJECT, GET, RECORD, MIGRATE]),
      subject: z
        .string()
        .optional()
        .describe('subject/record: what the intent is ABOUT — the shard it lives in.'),
      statement: z.string().optional().describe('record only: what must be true, in prose.'),
      why: z
        .string()
        .optional()
        .describe('record only: WHY it must be true. The thing somebody says once and forgets.'),
      source: z
        .string()
        .optional()
        .describe('record only: where it came from — a person, a ticket, a conversation.'),
      status: z
        .enum([IntentStatus.PROPOSED, IntentStatus.AGREED, IntentStatus.PROVED, IntentStatus.STALE])
        .optional()
        .describe('record only: how settled it is. Defaults to proposed.'),
      intents: z
        .array(
          z.object({
            id: z.string(),
            statement: z.string(),
            surface: z
              .object({
                route: z.string().optional(),
                flow: z.string().optional(),
                files: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional()
        .describe('declare only. Batchable — declare every intent for a feature in one call.'),
      id: z.string().optional().describe('bind only: which intent the predicate proves.'),
      binding: z
        .unknown()
        .optional()
        .describe("bind only: the predicate that would prove it, in reticle_assert's shape."),
      ...sessionIdShape,
    },
    outputSchema: {
      intents: z
        .array(z.unknown())
        .optional()
        .describe(
          'The intents this call declared, or on `list` everything still open — each { id, statement, state, declaredAt, binding?, surface?, provenBy?, amended? }. `state` is declared (prose only), bound (a predicate exists), or proved (a verdict satisfied it).',
        ),
      bound: z.boolean().optional().describe('bind only: false when the id names no intent.'),
      path: z.string().optional().describe('Where the ledger was written.'),
      entries: z
        .array(z.unknown())
        .optional()
        .describe(
          'index only: one line per intent — { id, subject, statement (summarised), status }. The cheap read: enough to decide WHICH subject to open, without loading any of them.',
        ),
      records: z
        .array(z.unknown())
        .optional()
        .describe('subject only: every full record for that subject.'),
      record: z.unknown().optional().describe('get/record: the single full record, or null.'),
      migrated: z
        .number()
        .optional()
        .describe('migrate only: how many flat-file intents were folded into shards.'),
      subjects: z
        .array(z.string())
        .optional()
        .describe('migrate only: which subjects received them.'),
    },
    handler: async (deps: ToolDeps, args) => {
      const root = sessionRoot(deps, asString(args['sessionId']));
      const store = new IntentStore(deps.fs, root, { now: deps.now });
      const shards = new IntentShardStore(deps.fs, root, { now: deps.now });
      const action = asString(args['action']);

      if (INDEX === action) return { entries: (await shards.index()).entries, path: root };
      if (SUBJECT === action)
        return { records: await shards.subject(asString(args['subject']) ?? ''), path: root };
      if (GET === action) return { record: await shards.get(asString(args['id']) ?? '') };
      if (MIGRATE === action) return { ...(await shards.migrate()), path: root };
      if (RECORD === action) {
        const written = await shards.record({
          id: asString(args['id']) ?? '',
          statement: asString(args['statement']) ?? '',
          subject: asString(args['subject']),
          why: asString(args['why']),
          source: asString(args['source']),
          status: asString(args['status']) as IntentStatus | undefined,
          binding: args['binding'],
        });
        return { record: written, path: root };
      }

      if (BIND === action) {
        const id = asString(args['id']) ?? '';
        return { bound: await store.bind(id, args['binding']) };
      }
      if (LIST === action) {
        return { intents: await store.open() };
      }
      const raw = args['intents'];
      const entries = Array.isArray(raw)
        ? (raw as { id: string; statement: string; surface?: never }[])
        : [];
      const declared = await store.declare(entries);
      return { intents: declared, path: root };
    },
  },
];
