import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isPredicateParam } from '../events/predicate-eval.js';
import { isToonable, resultToToon, MCP_SERVER_NAME } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import type { ToolDef } from '../tools/tools.js';
import {
  filterTools,
  describeToolSurface,
  TOOL_SURFACE,
  type ToolSurface,
} from '../tools/tool-surface.js';
import { ReticleTool } from '../tools/tool-names.js';
import { SHARED_PARAM_SHORT } from './shared-params.js';
import { buildDynamicTools } from '../tools/dynamic-tools.js';
import { runTool, SESSION_BOUND_TOOLS } from '../tools/invoke-tool.js';
import { sessionEnvelopeShape } from '../tools/tool-kit.js';
import { buildErrorPayload } from '../tools/error-recovery.js';
import { takeVersionSkewOnto } from '../version/version-nudge.js';
import { resultIsError } from './mcp-is-error.js';
import { buildServerInstructions } from './server-instructions.js';
import { unadvertisedToolHelp } from '../tools/unadvertised-help.js';

/** The JSON-RPC method the SDK registers its tool dispatcher under. */
export const CALL_TOOL_METHOD = 'tools/call';

/**
 * What we say when an SDK internal these patches ride on is no longer there.
 *
 * LOG rather than THROW, deliberately. Both patches improve an ERROR MESSAGE; neither is load
 * bearing for a single tool call, and a throw here runs at server construction, so a renamed
 * internal in a minor SDK bump would take the whole MCP server down for every user rather than
 * degrade one message. That trade is backwards. The place a shape change must fail is the gate —
 * `sdk-private-shape.test.ts` asserts both shapes and reddens CI on the bump — and this line is the
 * backstop for the one case the gate cannot see: a user whose installed SDK is not the one CI
 * resolved. The old behaviour, a bare `return`, gave neither.
 */
const SDK_SHAPE_MISSING = 'sdk_internal_missing';
import { log } from '../log.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { setMcpClientNameHook } from '../telemetry/feedback-context.js';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { parsePredicate } from '../events/predicate-parse.js';

/**
 * Merge the runtime-spliced envelope (health/lease/age/control) into a session-bound tool's declared
 * outputSchema so structuredContent validation keeps those fields instead of dropping them. The tool's
 * own keys win over the permissive envelope defaults (e.g. ACT keeps its typed `session` shape).
 * Non-session-bound tools (and tools with no outputSchema) are returned unchanged.
 */
export function withSessionEnvelope(
  name: string,
  outputSchema: z.ZodRawShape | undefined,
): z.ZodRawShape | undefined {
  if (outputSchema === undefined || !SESSION_BOUND_TOOLS.has(name)) return outputSchema;
  return { ...sessionEnvelopeShape, ...outputSchema };
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: SERVER_VERSION };

/** First sentence of a description (purpose only) for lean profiles — keeps per-turn def cost
 * down. Cuts at the first sentence-ending period or newline; falls back to a 160-char cap. The
 * first clause retains the essentials (enum hints like "role | text | label" live there). */
/**
 * Append the tool's example call to whatever description survived trimming.
 *
 * Costs a handful of tokens per turn and buys back the failed round trips an agent spends guessing
 * how the fields compose — which is a far worse trade in the other direction.
 */
function withExample(description: string, example?: Record<string, unknown>): string {
  return example === undefined ? description : `${description} e.g. ${JSON.stringify(example)}`;
}

/**
 * Abbreviations whose internal period is NOT a sentence end.
 *
 * The splitter looked for the first `". "`, which "e.g. " satisfies — so every lean-profile
 * description containing one was cut off mid-abbreviation. `reticle_act`'s ref parameter reached the
 * agent as "Element ref from reticle_snapshot or reticle_query (e.g." and stopped: the example gone,
 * and any contract stated after it gone too. Silent, and it degraded the DEFAULT profile only, which
 * is the one nobody reads the raw strings for.
 */
const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.'];

export function firstSentence(description: string): string {
  const nl = description.indexOf('\n');
  const base = nl >= 0 ? description.slice(0, nl) : description;
  // Mask abbreviations with an equal-length filler so offsets stay valid in the original string.
  const masked = ABBREVIATIONS.reduce(
    (text, abbr) => text.split(abbr).join('\u0000'.repeat(abbr.length)),
    base,
  );
  const dot = masked.search(/\.\s/);
  const sentence = dot >= 0 ? base.slice(0, dot + 1) : base;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

/**
 * Parameters carrying the recursive predicate grammar. Advertised compactly in lean profiles.
 *
 * `PredicateSchema` is a 12-variant discriminated union whose `allOf`/`anyOf`/`not` members embed the
 * union again. Zod's JSON-Schema emitter inlines that recursion rather than emitting one `$ref`, so a
 * single tool ships the word "kind" 48 times and `reticle_wait_for` alone costs 6,571 characters.
 * Across the three tools that take a predicate that is 72% of the entire advertised input schema — a
 * cost re-sent on every request, forever, to describe a grammar most calls use one variant of.
 */
/**
 * What a lean profile advertises in place of the full predicate union.
 *
 * Safe to loosen because it is NOT the validation boundary: every handler taking a predicate calls
 * `PredicateSchema.parse()` itself (observe-tools.ts:203, :279, act-tools.ts:442), so a malformed
 * predicate still fails strictly and structurally — the agent gets a zod error naming the bad field
 * rather than a silently accepted one. What changes is only how many bytes we spend describing the
 * grammar up front versus letting the agent fetch it from `reticle_tools` when it needs a variant it
 * has not used before.
 */
/**
 * The kind list — the part an agent needs to WRITE a predicate. Carried on every predicate parameter.
 *
 * An earlier version put this on one tool and pointed the other five at it ("same grammar as
 * reticle_act_and_wait's"), which saved 790 B/turn. It was the wrong trade: it made writing a
 * predicate require joining two tool descriptions, and accuracy is worth more here than the bytes.
 * Only the "where to get field details" sentence is stated once now — that one IS a pointer, so
 * making it a pointer costs nothing.
 */
const PREDICATE_KINDS =
  'Predicate object: { kind, ...fields }. kind is one of element | text | net | route | console | ' +
  'animation | signal | state | settled | allOf | anyOf | not.';

/**
 * Said once per turn: the bug-catching options, and where to get the rest of the field grammar.
 *
 * `net.count`, `console.absent` and `absent` are the three predicate options that catch a class of
 * bug rather than confirm an expectation — a double-submit, an action that "worked" while logging a
 * caught error, something that should have disappeared and did not. They sat behind a
 * `reticle_tools` round trip, so an agent only found them if it already knew to look, which is the
 * wrong way round for the checks most likely to catch what nobody suspected.
 *
 * Anchored to one tool rather than repeated on all six: these are ADDITIONAL capability, not what
 * makes a basic predicate correct, so one mention per turn is enough to make them reachable without
 * paying for six.
 */
const PREDICATE_FIELD_GRAMMAR_HINT =
  ' Bug-catching options: net.count (exact request count — catches double-submit), ' +
  'net.bodyContains (a substring of what the SERVER answered — catches a UI that echoes the input ' +
  'it sent instead of the result it got back), console.absent:true (action completed with a CLEAN ' +
  'console), absent:true on element/text (it should be gone). Call reticle_tools for the full field ' +
  'grammar of a kind.';

const COMPACT_PREDICATE_DESCRIPTION = `${PREDICATE_KINDS}${PREDICATE_FIELD_GRAMMAR_HINT}`;

/**
 * Lean copy of a tool's zod input shape for lean profiles: each parameter's description is
 * truncated to its first sentence via zod's own `.describe` (which returns a new schema, so the
 * shared shape is never mutated). The per-parameter prose is the bulk of the re-sent-every-turn
 * schema cost; the first clause keeps each param's purpose and any enum hints. Params without a
 * description pass through unchanged. Predicate params are replaced wholesale — see above.
 */
function leanZodShape(shape: z.ZodRawShape, predicateAnchor?: string): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  // The navigation hint is said ONCE per turn, so it is anchored to one parameter — not one tool.
  // A tool can carry two predicate parameters (a canonical name plus a neighbouring tool's alias),
  // and anchoring per-tool spelled the hint out on both.
  let hintSpent = predicateAnchor !== undefined;
  for (const [key, schema] of Object.entries(shape)) {
    if (isPredicateParam(schema)) {
      // Every tool keeps the kinds; only the navigation hint is anchored.
      const compact = z
        .record(z.unknown())
        .describe(hintSpent ? PREDICATE_KINDS : COMPACT_PREDICATE_DESCRIPTION);
      hintSpent = true;
      out[key] = schema.isOptional() ? compact.optional() : compact;
      continue;
    }
    // Shared boilerplate is documented once in the initialize instructions instead of on every
    // tool, every turn. `sessionId` alone was 2,076 bytes of identical text across 16 tools.
    const shared = SHARED_PARAM_SHORT[key];
    if (shared !== undefined) {
      // `.describe` returns the same schema with new prose, so optionality carries over. Re-wrapping
      // in `.optional()` would nest one inside another and change the parameter's TYPE, which is a
      // thing this lean path is meant to do for predicates and nothing else.
      out[key] = schema.describe(shared);
      continue;
    }
    const desc = schema.description;
    out[key] = 'string' === typeof desc ? schema.describe(firstSentence(desc)) : schema;
  }
  return out;
}

const ENCODING_ENV = 'RETICLE_ENCODING';
const TOON_VALUE = 'toon';
const PRETTY_VALUE = 'pretty';

/**
 * Serialize a tool result to the MCP `text` content block. The agent consumes this text — the
 * typed contract travels separately as `structuredContent`, unchanged by encoding — so the text
 * is compact JSON (no indentation) by default: pretty-printing spends a whitespace token on every
 * field of every line, ~40% overhead on the structured payloads that dominate Reticle's cost, for
 * readability only a human re-reading a raw transcript would notice. Opt into the older indented
 * form with `RETICLE_ENCODING=pretty`; `RETICLE_ENCODING=toon` is the even-denser tabular encoding.
 */
export function encodeResult(result: unknown, encoding: string): string {
  if (encoding === TOON_VALUE && isToonable(result)) {
    return resultToToon(result as Record<string, unknown>);
  }
  return encoding === PRETTY_VALUE ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}

/**
 * Bridge type that erases the MCP SDK's complex generic pairing between outputSchema and handler
 * return type. Reticle exposes tool output as text content (for backwards-compatible MCP clients) AND
 * as structuredContent (for schema-aware clients like @reticlehq/cli). The SDK generics are correct at
 * the protocol level; we break the link here intentionally so we can register all tools
 * dynamically from a ToolDef array without a generic per-tool call site.
 */
type ReticleRegisterTool = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
  },
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>,
) => void;

/**
 * The tools a profile advertises directly.
 *
 * Exported so it can be TESTED. A previous guard re-implemented this decision in the test and was
 * therefore insensitive to it — every profile appeared to reach every tool, so reverting the fix here
 * left the suite green. Exercise the real function or the guard is theatre.
 *
 * Both surfaces keep the meta-tools. On the default that is what makes a trim a trim rather than a
 * hard removal — an unadvertised tool is still reachable through reticle_run; under the old
 * `standard` profile 11 tools were uncallable, including reticle_annotate, which reticle_flow_save's
 * own description tells the agent to call. On ALL they are kept too: `reticle_tools` is not an
 * escape hatch there, it is parameter lookup, and every recovery message this server emits says
 * "Call reticle_tools { names: [...] } for its parameters" — leaving it out made our own advice a
 * dead end on the one surface that advertises everything.
 */
export function advertisedTools(
  surface: ToolSurface,
  /**
   * The full table to advertise from. Defaults to what this package ships.
   *
   * A consumer embedding the engine passes its own composition — ours plus its own — so its tools
   * reach the wire without editing the shipped array.
   */
  tools: readonly ToolDef[] = TOOLS,
): ToolDef[] {
  // The catalog reports which surface is live and what chose it — the only way an agent can see that
  // a setting did not take (the daemon read the value it started with).
  const origin = describeToolSurface(surface);
  // The profile trims OUR table only. A tool this package does not ship was appended deliberately by
  // whoever is embedding us, and our `CORE_TOOL_NAMES` was never going to contain its name — so
  // filtering it would drop every consumer tool and look exactly like the feature not working.
  const shipped = new Set(TOOLS.map((tool) => tool.name));
  const ours = tools.filter((tool) => shipped.has(tool.name));
  const theirs = tools.filter((tool) => !shipped.has(tool.name));
  return [...filterTools([...ours], surface), ...theirs, ...buildDynamicTools([...tools], origin)];
}

/**
 * Exactly what gets advertised for one tool under a profile: trimmed description, lean input shape,
 * and (non-lean only) the output schema.
 *
 * Exported so tests assert on the REAL advertised text rather than on the tool definitions, which
 * are trimmed later and would make a guard that cannot fail — a mistake already made once here, with
 * an abbreviation test that read raw defs and would have passed with the bug fully present.
 */
export function advertisedConfig(
  tool: ToolDef,
  advertised: readonly ToolDef[],
  profile: ToolSurface,
): { description: string; inputSchema: z.ZodRawShape; outputSchema?: z.ZodRawShape } {
  // Hybrid is the terse one. NOT `profile !== FULL`, which reads equivalent and is not: it also
  // trims `dynamic`, whose two meta-tools are the ONLY thing that profile advertises — so the
  // instructions for using them (`names:[…]` loads full params on demand) would be cut to a first
  // sentence and the agent would have nothing left to learn the surface from. Measured when it
  // happened: dynamic's tools/list fell 1,543 -> 849 bytes, which looks like a saving and is a
  // capability loss.
  //
  // The two meta-tools are exempt, on every surface. Their descriptions are not a description OF a
  // capability, they ARE the capability: the only place an agent is ever told that the tools it can
  // see are not all the tools there are, and how to reach the rest. Trimmed to a first sentence,
  // `reticle_tools` advertises as "Discover Reticle tools on demand." — which names no way to list
  // anything, so a well-behaved agent has no reason to call it and the entire cold tail goes dark.
  // The comment above already caught this for the retired `dynamic` profile; `default` is now both
  // the lean surface and the one carrying the meta-tools, so the exemption follows it.
  const isMetaTool = tool.name === ReticleTool.TOOLS || tool.name === ReticleTool.RUN;
  // `verify` is lean for the same reason `default` is, and more so: it exists to make a verdict
  // cheap, and it was serving FULL descriptions plus outputSchema because the check named only the
  // default. That put 8,207 bytes on the wire for three tools.
  // `lean` here is the ADJECTIVE (terse descriptions, no output schemas), which every trimmed surface
  // wants — including TOOL_SURFACE.LEAN, the profile that borrows the word. A trimmed surface serving
  // full prose plus output schemas is the exact defect that put 8,207 bytes on `verify`'s three tools.
  const lean =
    profile === TOOL_SURFACE.DEFAULT ||
    profile === TOOL_SURFACE.VERIFY ||
    profile === TOOL_SURFACE.LEAN;
  const terse = lean && !isMetaTool;
  // The first advertised tool carrying a predicate spells the grammar out; the rest point at it.
  const anchor = advertised.find((t) =>
    Object.values(t.inputSchema).some((schema) => isPredicateParam(schema)),
  )?.name;
  // Output schemas are dropped on every lean surface, meta-tools included: they are the single
  // largest component and nothing on a lean surface validates against them.
  const outputSchema = lean ? undefined : withSessionEnvelope(tool.name, tool.outputSchema);
  return {
    description: withExample(
      terse ? firstSentence(tool.description) : tool.description,
      tool.example,
    ),
    inputSchema: terse
      ? leanZodShape(tool.inputSchema, tool.name === anchor ? undefined : anchor)
      : tool.inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}

/**
 * Replace the SDK's arg-validation error with one an agent can act on.
 *
 * A wrong argument SHAPE is the most common failure an agent has here, and it is the one this
 * package's otherwise-good error handling never sees: the SDK validates and throws before the
 * handler runs, so what comes back is the validator's internal state — `{"code":"invalid_type",
 * "expected":"string","received":...}` — naming no field and showing no correct call. Observed live:
 * two failed round trips guessing `reticle_act`'s shape, which costs more than the lean snapshot
 * saves. Advertised examples reduced the guessing; this removes the dead end that remains.
 *
 * The zod detail is KEPT — it names the offending field — and the tool's own example is appended, so
 * the reply says both what was wrong and exactly what a correct call looks like.
 *
 * This wraps an SDK-internal method, so a rename upstream would silently restore the raw dump. That
 * is why `mcp.test.ts` drives a real client over an in-memory transport and asserts on the message
 * an agent actually receives, rather than testing this function directly.
 */
type InputValidator = (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;

/** Argument keys the tool never declared. Empty when the tool's shape is unknown to us. */
function unknownKeys(args: unknown, allowed?: ReadonlySet<string>): string[] {
  if (allowed === undefined || typeof args !== 'object' || null === args) return [];
  return Object.keys(args as Record<string, unknown>).filter((key) => !allowed.has(key));
}

export function installFriendlyArgErrors(
  server: McpServer,
  examples: Map<string, string>,
  allowedKeys: Map<string, ReadonlySet<string>> = new Map(),
): void {
  const target = server as unknown as { validateToolInput?: InputValidator };
  const original = target.validateToolInput;
  if (typeof original !== 'function') {
    log(SDK_SHAPE_MISSING, { internal: 'validateToolInput', lost: 'friendly argument errors' });
    return;
  }
  target.validateToolInput = async (tool, args, toolName) => {
    // An UNKNOWN key is the failure zod cannot catch, because object schemas are non-strict: the key
    // is silently dropped and the tool answers as if it had not been asked. Measured live —
    // `reticle_clock { action: "freeze" }` returned `{"frozen":false}`, which reads as a fact about
    // the app ("the clock is not frozen") when it means "you named the parameter wrong". That is a
    // false NEGATIVE the caller cannot detect from the reply, in every tool at once.
    const unknown = unknownKeys(args, allowedKeys.get(toolName));
    if (unknown.length > 0) {
      const example = examples.get(toolName);
      // What the tool DOES declare, in the same breath as what it does not. Naming only the bad key
      // leaves the caller guessing again, and the next guess costs another round trip — which is the
      // whole shape of the failure being fixed here. The list is already in hand, and for a tool
      // with no example (the meta-tools) it is the only thing standing between a typo and a retry.
      const declared = [...(allowedKeys.get(toolName) ?? [])].join(', ');
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown ${1 === unknown.length ? 'parameter' : 'parameters'} for ${toolName}: ${unknown.join(', ')}. ` +
          `They were NOT applied — a result computed without them would look like an answer. ` +
          (0 === declared.length ? '' : `${toolName} declares: ${declared}. `) +
          (example === undefined
            ? `Call reticle_tools { names: ["${toolName}"] } for its parameters.`
            : `A valid call looks like: ${toolName} ${example}`),
      );
    }
    try {
      return await original.call(server, tool, args, toolName);
    } catch (error) {
      // McpError.message already carries "MCP error -32602: "; re-wrapping would print it twice.
      const raw = error instanceof Error ? error.message : String(error);
      const detail = raw.replace(/^MCP error -?\d+:\s*/, '');
      // A malformed PREDICATE gets the sentence, not the array. The SDK validates tool input against
      // the same zod schema and throws a serialized issue list — so the readable message
      // `parsePredicate` exists to produce was being generated only on paths that never run over
      // MCP, which is every path a real agent uses. Found by driving a live app: `reticle_assert`
      // answered a near-miss predicate with a raw zod array naming the unknown keys and not one
      // field that would have worked. It already carries its own guidance, so the generic example is
      // dropped rather than argued with.
      const predicateHelp = predicateMessage(args);
      if (predicateHelp !== undefined) {
        throw new McpError(ErrorCode.InvalidParams, predicateHelp);
      }
      const example = examples.get(toolName);
      const help =
        example === undefined
          ? ` Call reticle_tools { names: ["${toolName}"] } for its parameters.`
          : ` A valid call looks like: ${toolName} ${example}`;
      throw new McpError(ErrorCode.InvalidParams, `${detail}${help}`);
    }
  };
}

/**
 * The readable reason a predicate argument did not parse, or undefined when the predicate is fine.
 *
 * Undefined matters as much as the message: a call can fail validation for a reason that has nothing
 * to do with the predicate (a bad `timeout_ms`, a missing `ref`), and replacing that error with a
 * predicate explanation would be confidently wrong. Re-parsing is the honest test — if it parses,
 * the predicate is not what broke.
 */
function predicateMessage(args: unknown): string | undefined {
  if (typeof args !== 'object' || null === args) return undefined;
  const record = args as Record<string, unknown>;
  const predicate = record['predicate'] ?? record['until'];
  if (predicate === undefined) return undefined;
  try {
    parsePredicate(predicate);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : undefined;
  }
}

/**
 * Answer a call for a real-but-un-advertised tool with the way to make it work.
 *
 * Wraps the SDK's own `tools/call` handler rather than registering the missing tools: registering
 * them would put their schemas back into `tools/list`, which is the exact cost the trim exists to
 * avoid. Delegates untouched for every other name, so an advertised tool's errors stay the SDK's.
 */
function installUnadvertisedToolHelp(
  server: McpServer,
  advertised: ReadonlySet<string>,
  known: ReadonlySet<string>,
): void {
  const inner = server.server as unknown as {
    _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const handlers = inner._requestHandlers;
  const original = handlers?.get(CALL_TOOL_METHOD);
  if (handlers === undefined || original === undefined) {
    log(SDK_SHAPE_MISSING, {
      internal: handlers === undefined ? '_requestHandlers' : CALL_TOOL_METHOD,
      lost: 'unadvertised-tool help',
    });
    return;
  }
  handlers.set(CALL_TOOL_METHOD, async (request: unknown, extra: unknown) => {
    const name = toolNameOf(request);
    const help = name === undefined ? undefined : unadvertisedToolHelp(name, advertised, known);
    if (help !== undefined) throw new McpError(ErrorCode.InvalidParams, help);
    return original(request, extra);
  });
}

/** The requested tool name, when the request has the shape we expect. */
function toolNameOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || null === request) return undefined;
  const params = (request as { params?: unknown }).params;
  if (typeof params !== 'object' || null === params) return undefined;
  const name = (params as { name?: unknown }).name;
  return 'string' === typeof name ? name : undefined;
}

export function createMcpServer(
  deps: ToolDeps,
  profile: ToolSurface = TOOL_SURFACE.DEFAULT,
  /**
   * Has an app ever connected for this project? Decides what the instructions LEAD with.
   *
   * Passed in rather than read here, so construction stays free of disk I/O and the decision is
   * testable without a state directory. Defaulting to `false` is the deliberate safe side: an agent
   * told to instrument a project that is already wired loses a paragraph, while an agent not told
   * loses the entire install — and the second is what the field overwhelmingly shows.
   */
  previouslyConnected = false,
  /**
   * The full tool table this server serves. Defaults to what this package ships.
   *
   * Threaded rather than read from the module so a consumer can serve its own tools on one surface
   * with ours. It reaches all three places that need the WHOLE table and not just the advertised
   * slice: the profile filter, the `reticle_run` hatch, and the unadvertised-tool help — a consumer
   * tool missing from either of the last two is a tool the agent is actively told does not exist.
   */
  tools: readonly ToolDef[] = TOOLS,
): McpServer {
  const encoding = (process.env[ENCODING_ENV] ?? '').toLowerCase();
  // Which surface this daemon advertises. The 18-tool default and the 48-tool full surface are
  // different products from inside an agent's context, so outcomes are only comparable when the
  // session says which one it saw.
  getSessionMetrics().recordSurface(profile);
  const server = new McpServer(SERVER_INFO, {
    instructions: buildServerInstructions({ previouslyConnected }),
  });
  /**
   * Record WHICH agent attached, at the handshake, for every session.
   *
   * `clients` and `clientVersions` were populated for almost nobody, and the reason was not that
   * clients withhold `clientInfo` — they send it, and we read it. It was that the ONLY thing that
   * ever called `recordClient` was the feedback hook below, which runs when a report is being built.
   * So the field was really measuring "sessions that filed feedback", and a product whose users are
   * agents could not say which agent, on which build, any of its numbers came from.
   *
   * `oninitialized` is the moment `clientInfo` first exists — reading it at construction time gets
   * `undefined`, which is what made a lazy hook look like the only option.
   */
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    if (info?.name !== undefined) getSessionMetrics().recordClient(info.name, info.version);
  };
  // Which agent is on the other end, for a feedback report. Registered as a lazy hook rather than
  // read here: the handshake has not happened yet at construction time, and a report filed twenty
  // tool calls later is exactly when we want the answer.
  setMcpClientNameHook(() => {
    const info = server.server.getClientVersion();
    // Still records, because a client that skipped the handshake path above (a replayed initialize
    // through the proxy, a transport that reconnects) is a client we would otherwise lose entirely.
    // `recordClient` is idempotent per name.
    if (info?.name !== undefined) getSessionMetrics().recordClient(info.name, info.version);
    return info === undefined ? undefined : { name: info.name, version: info.version };
  });
  // Cast once to our bridge type so every per-tool call site is typed without `any`.
  const registerTool = server.registerTool.bind(server) as unknown as ReticleRegisterTool;

  // `dynamic` advertises only the 2 meta-tools (reticle_tools + reticle_run); real tools load on demand.
  // core/standard advertise the filtered set with terse descriptions (first sentence + trimmed
  // param prose) — the full prose is re-sent every turn, and the first clause carries the purpose.
  // Every TRIMMED profile keeps the meta-tools, so a tool that is not advertised is still reachable
  // through reticle_run. Without them a trim is not a trim, it is a hard removal: under `standard`,
  // 11 tools were unreachable with no escape hatch — including reticle_annotate, which
  // reticle_flow_save's own description instructs the agent to call. `full` advertises everything
  // directly and needs no hatch.
  const advertised = advertisedTools(profile, tools);
  installFriendlyArgErrors(
    server,
    new Map(
      advertised
        .filter((tool) => tool.example !== undefined)
        .map((tool) => [tool.name, JSON.stringify(tool.example)]),
    ),
    // Every tool in the table, not just the advertised ones: reticle_run dispatches to the full
    // table, so an unadvertised tool reached through the hatch must be just as strict.
    //
    // ...and the advertised list on top of it, because the two META-tools are not in the table — they
    // are composed onto the surface — so they had no entry, and no entry means no declared keys means
    // every key allowed. `reticle_tools` took a misnamed argument, dropped it, and answered with the
    // whole catalogue: a well-formed answer to a question nobody asked, on the one tool whose entire
    // job is telling an agent what the surface is.
    new Map(
      [...tools, ...advertised].map((tool) => [
        tool.name,
        new Set(Object.keys(tool.inputSchema)) as ReadonlySet<string>,
      ]),
    ),
  );
  for (const tool of advertised) {
    // Output schemas are now the largest slice of the per-request tax (55.6% of the hybrid payload
    // after the predicate fix) and we are the only one of the three MCP servers that sends them.
    //
    // Trimming their prose was tried and MEASURED ZERO: the field descriptions were already written
    // as single sentences, so first-sentence truncation had nothing to remove. Recorded here so the
    // next person does not spend the same hour. The remaining cost is structural — the shapes
    // themselves — and dropping them is NOT the answer: the type contract is what makes
    // `structuredContent` verifiable, and it has already caught a real defect (a broad reticle_query
    // failing output validation outright instead of returning a degraded result).
    //
    // Lean profiles therefore DROP the advertised outputSchema entirely, and that is safe — verified
    // against the SDK, not assumed. A tool registered with NO outputSchema still returns its
    // `structuredContent` unchanged (the SDK does not require a declared schema to carry it), so a
    // client that wants the typed object still gets it; only client-side VALIDATION of that object is
    // lost, which the MCP spec makes optional and which the agent, reading the text block, never did.
    // If anything the object is MORE complete without a schema — with one, the SDK drops fields the
    // schema does not list, which is the very reason the session envelope had to be spliced in. The
    // handler below is unchanged, so `full`/`dynamic` (non-terse) keep the schema for validating
    // clients. This removes the single largest remaining slice of the per-request tax (~36% of the
    // hybrid payload) with no loss the agent can observe.
    const config = advertisedConfig(tool, advertised, profile);
    registerTool(tool.name, config, async (args: Record<string, unknown>) => {
      try {
        const result = await runTool(tool, deps, args);
        const text = encodeResult(result, encoding);
        // A tool that RETURNS `{ error, recovery }` refused just as surely as one that threw, and
        // `isError` is the field a caller branches on. Without this it was set only on the throw
        // path, so half the surface reported a refusal as a success. See mcp-is-error.
        const isError = resultIsError(result);
        if (tool.outputSchema !== undefined) {
          return {
            ...(isError ? { isError: true as const } : {}),
            content: [{ type: 'text' as const, text }],
            structuredContent: result as Record<string, unknown>,
          };
        }
        return {
          ...(isError ? { isError: true as const } : {}),
          content: [{ type: 'text' as const, text }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('tool_error', { tool: tool.name, error: message });
        // Counted by FINGERPRINT, never by message — see error-fingerprint.ts. This is the single
        // boundary every agent-visible tool failure crosses, so it is the one place "which error is
        // hurting people most" can be answered without instrumenting every handler.
        getSessionMetrics().recordToolError(message, tool.name);
        // Every error the agent hits should answer "what next?", not just "what broke".
        return {
          isError: true as const,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(takeVersionSkewOnto(buildErrorPayload(message))),
            },
          ],
        };
      }
    });
  }
  // AFTER the registration loop, and that ordering is the whole trick: the SDK installs its
  // `tools/call` dispatcher lazily on the FIRST registerTool, so wrapping before this point finds
  // nothing to wrap and silently does nothing. Verified live rather than assumed — the first attempt
  // sat here doing exactly that.
  installUnadvertisedToolHelp(
    server,
    new Set(advertised.map((tool) => tool.name)),
    new Set(tools.map((tool) => tool.name)),
  );
  return server;
}
