/**
 * Shared kit for the MCP tool modules — the tool shape, the dependency bag, the common
 * session-id arg, and the two helpers (commandOrThrow, snapshotTree) every tool group needs. Lives
 * in its own leaf module (no dependency on any tool array) so the per-group tool files can import it
 * without a circular import — `tools.ts` assembles the groups and re-exports `ToolDef`/`ToolDeps`.
 */
import { z } from 'zod';
import { ReticleCommand, SnapshotMode } from '@reticlehq/core';
import type { SessionManager } from '../session/session.js';
import type { RealInputProvider } from '../input/real-input.js';
import type { BaselineStore } from '../project/baselines.js';
import { normalizeLines } from '../project/baselines.js';
import type { RecordingStore } from '../flows/recordings.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { ArtifactRoot } from '../project/artifact-root.js';
import type { FlowStore } from '../flows/flows.js';
import type { ProjectStore } from '../project/project-store.js';
import type { AnnotationStore } from '../flows/annotation-store.js';
import type { BrowserPool } from '../pool/browser-pool.js';
import type { ChromiumProbe } from '../cli/chromium-hint.js';

export interface ToolDeps<Ext = unknown> {
  sessions: SessionManager;
  /** shared one-browser/N-context pool for headless leases. undefined ⇒ lease tools report unavailable. */
  pool?: BrowserPool;
  /**
   * Probe for a launchable Chromium, so the lease path can refuse at the FIRST call with the install
   * fix rather than failing several calls in with a message that reads as "the app is not running".
   * Optional: absent ⇒ no preflight — every existing test construction of ToolDeps keeps working, and
   * the fake-pool lease tests are deliberately runnable without a real Chromium.
   */
  browserProbe?: () => Promise<ChromiumProbe>;
  baselines: BaselineStore;
  recordings: RecordingStore;
  /** on-disk anchored-flow store (.reticle/flows/). */
  flows: FlowStore;
  /** structured annotations accumulating for the live recording. */
  annotations: AnnotationStore;
  /** cross-run outcome memory (.reticle/project.json). */
  project: ProjectStore;
  /** optional native-input provider. undefined ⇒ everything stays synthetic. */
  realInput?: RealInputProvider;
  /** injected filesystem seam (tests pass a fake/temp-dir adapter). */
  fs: FileSystemPort;
  /** absolute.reticle path (index.ts computes cwd/.reticle). The FALLBACK, not the answer. */
  reticleRoot: string;
  /**
   * Which `.reticle` a SESSION's artifacts belong in, resolved per call.
   *
   * `reticleRoot` above is fixed at construction from the daemon's own `process.cwd()`, which is a
   * statement about where the daemon was launched and was being read as a statement about which
   * project is being verified. Those are usually not the same tree: an editor starts a user-scoped
   * MCP server wherever it likes, so flows landed outside the repo they verify, or died on
   * `mkdir '/.reticle'`.
   *
   * Optional because every existing construction of ToolDeps predates it and because a consumer
   * embedding this engine may not have a filesystem to search. Absent ⇒ `reticleRoot`, which is
   * exactly today's behaviour.
   */
  artifactRootFor?: (projectId: string | undefined) => ArtifactRoot;
  /**
   * A verification run just landed — wake cloud sync instead of waiting for its next tick.
   *
   * The run itself is pushed immediately on this path, but everything AROUND it — the impact
   * counters, the flows it exercised, flake and intent — moves only on the timer. That is what
   * produced a dashboard showing a fresh run beside stale numbers, which reads as a sync bug and is
   * really just two different clocks. Waking the loop here makes the run and its context arrive
   * together.
   *
   * Optional: absent ⇒ the timer alone, which is exactly today's behaviour.
   */
  onRunPersisted?: () => void;
  /**
   * This daemon's OWN project id, derived from the directory it was started in.
   *
   * Optional because a daemon above an uninitialised directory has none, and because every existing
   * test construction of ToolDeps predates it. Absence means "cannot tell", which must never be
   * treated as a mismatch.
   */
  projectId?: string;
  /** injected clock for the contract's generatedAt stamp. */
  now: () => number;
  /**
   * The port this daemon's bridge listens on.
   *
   * Needed wherever a message has to name the OTHER half of a port mismatch — the commonest reason
   * a leased tab loads the app and never dials in. Optional so every existing test construction of
   * ToolDeps keeps working; absent falls back to the default port.
   */
  bridgePort?: number;
  /**
   * A consumer's OWN dependencies, carried through untouched.
   *
   * Nothing in this package reads it. It exists so a consumer embedding the engine can add tools of
   * its own — answering out of a store this package has never heard of — without either widening the
   * fields above with a stranger's vocabulary or forking to get a handle through.
   *
   * The type parameter, rather than `unknown`, is what keeps the seam typed: a consumer writes
   * `ToolDef<TheirExt>` once and their handlers see their own type. Casting out of `unknown` in every
   * handler is how a typed seam quietly becomes an untyped one.
   *
   * Optional, and defaulted to `unknown`, so every existing construction of this bag — and every test
   * that builds one — is unchanged.
   */
  ext?: Ext;
}

export interface ToolDef<Ext = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /**
   * JSON Schema-compatible output schema for this tool. When present, the MCP server advertises it
   * in the tools/list response so schema-aware clients (like @reticlehq/cli) can validate outputs and
   * compose tool calls safely. Also drives TOON encoding for snapshot/query results.
   */
  outputSchema?: z.ZodRawShape;
  /**
   * One concrete, valid call — the shape, not the prose.
   *
   * A schema tells an agent the FIELD NAMES; it does not tell it how they compose, and under a lean
   * profile only the first sentence of the description survives. So an agent reads "execute one
   * action against a ref", sees `ref` / `action` / `args`, and guesses `{ action, testid }`. The
   * guess fails inside the MCP SDK's own validation — BEFORE this package's error handling runs — so
   * what comes back is a raw zod dump: the validator's internal state, naming no field and showing
   * no correct shape. Two of those round trips cost more than the lean snapshot saves, which means
   * arg-guessing quietly refunds the entire token advantage.
   *
   * Rendered into the advertised description, so it survives the terse profiles where it matters
   * most. `tool-examples.test.ts` parses every one of these against its OWN inputSchema, because an
   * example that does not validate is worse than none at all.
   */
  example?: Record<string, unknown>;
  /**
   * Declared method-style, not as a property, and that is load-bearing rather than stylistic.
   *
   * Under `strictFunctionTypes` a property holding a function has CONTRAVARIANT parameters, so
   * `ToolDef<TheirExt>` and `ToolDef<unknown>` become mutually unassignable and a consumer composing
   * `[...TOOLS, ...theirTools]` needs a cast — as does every internal helper that then touches the
   * array. Method-style parameters are checked bivariantly, which collapses all of that.
   *
   * The unsoundness bivariance admits is that a handler written against `ToolDeps<TheirExt>` could be
   * handed a bag carrying no `ext` at all. That costs nothing here, because `ext` is optional by
   * design: any handler reading it already has to survive `undefined`.
   */
  handler(deps: ToolDeps<Ext>, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The optional inline intent, on every tool that draws a verdict.
 *
 * One field, carrying either prose or the id of an intent already declared, because the surface is
 * the scarce thing and a second field for the reference case would double the cost of the idea to
 * make one of its two uses marginally more explicit. Told apart by the ledger — see
 * `intent/inline-intent.ts`.
 *
 * The first sentence is what a lean surface advertises, so it carries both readings; the rest is for
 * the profiles that send the whole description.
 */
export const intentArg = z
  .string()
  .optional()
  .describe(
    'What this change is meant to make true — as a durable statement ABOUT THE PRODUCT, or the id of an intent you already declared. ' +
      'Write it so a teammate who was not here understands it in six months: name the behaviour, not this run. ' +
      'GOOD: "a filtered issue queue is a shareable link — the filter is in the URL". ' +
      'BAD: "P1 step 5", "drive 2 of 2", "same as before the fix", "the board renders cleanly" — these name a session, ' +
      'a step number or nothing checkable, and the person reading them later has none of that context. ' +
      'This is shared memory: it is pooled per project and later agents read it back to avoid re-deriving what you just established. ' +
      'Recorded in .reticle/intent.json, the same ledger reticle_intent writes, and marked proved by this verdict if it passes.',
  );

export const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'OMIT THIS unless you mean a specific tab — Reticle scopes to your project, prefers the active one, and refuses rather than guesses when ambiguous. Pass an id from reticle_sessions only to target a particular tab. The previous wording ("omit when only ONE session is open") was wrong and cost real turns: with three sessions connected — an app plus two pool leases — resolution is still unambiguous, but that sentence sent the agent off to list and filter sessions by hand before every single call.',
    ),
};

/**
 * Every key `runTool` splices onto a session-bound result, as a closed list.
 *
 * These are wire strings and were inlined at the splice sites, which is exactly how four of them
 * came to be spliced and never declared. `sessionEnvelopeShape` is derived from this object and
 * `envelope-keys-declared.test.ts` fails if a member is missing from it, so the two cannot drift.
 *
 * Each of these is a channel that exists BECAUSE the agent had no other way to learn the fact.
 * Undeclared, a schema-strict client validating `structuredContent` drops it, and the channel is
 * indistinguishable from never having been built.
 */
export const EnvelopeKey = {
  /** Session health — which tab, how fresh. */
  SESSION: 'session',
  /** One-shot pool-lease reminder. */
  SESSION_LEASE: 'session_lease',
  /** One-shot "these sessions are old, clean them up". */
  SESSION_AGE_WARNING: 'session_age_warning',
  /** The delivered-once human-in-the-loop guidance envelope. Losing it is a safety failure. */
  CONTROL: 'control',
  /**
   * Rides alongside `session` whenever the tab is THROTTLED. It was declared on `reticle_act`'s
   * schema and nowhere else, so on a validating profile every other session-bound tool silently
   * dropped it — a throttled tab, where drives can no-op, returned a healthy-looking result.
   */
  WARNING: 'warning',
  /** One-shot "ask the human how this went". */
  FEEDBACK_PROMPT: 'feedback_prompt',
  /** One-shot "a newer Reticle exists". */
  UPDATE_AVAILABLE: 'update_available',
  /**
   * "You have driven this page N times without asking for a verdict."
   *
   * The largest known lever on the metric this product is judged by: verdict-less sessions
   * overwhelmingly never call a verdict-producing tool at all. It was spliced undeclared, so on a
   * validating client the nudge was built, fired, and thrown away before any agent saw it.
   */
  VERIFY_NEXT: 'verify_next',
  /** The contextual "tell us what just went wrong" invitation. Same story, same release. */
  FEEDBACK_INVITE: 'feedback_invite',
  /** SDK/daemon version skew — often the one fact that explains everything else in the session. */
  VERSION_SKEW: 'version_skew',
  /** A feedback report that was accepted and then failed to send. Only the reporter can act on it. */
  FEEDBACK_UNDELIVERED: 'feedback_undelivered',
} as const;
export type EnvelopeKey = (typeof EnvelopeKey)[keyof typeof EnvelopeKey];

/**
 * Fields that `runTool` / `withControl` splice onto EVERY session-bound tool result at runtime.
 * Merged into each session-bound tool's outputSchema so a schema-strict client (structuredContent
 * validation) keeps them instead of silently dropping them.
 *
 * Derived from `EnvelopeKey` rather than re-listed: this shape and the splice sites disagreed for a
 * whole release, and every key that went missing was a channel nobody could see was missing.
 */
export const sessionEnvelopeShape: z.ZodRawShape = Object.fromEntries(
  Object.values(EnvelopeKey).map((key) => [
    key,
    // `warning` is the one with a narrower type; the rest are opaque envelopes the client forwards.
    EnvelopeKey.WARNING === key ? z.string().optional() : z.unknown().optional(),
  ]),
);

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
export async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  // ReticleCommand, not string: the union already exists and every caller passes a member. Typed as
  // `string` a sessionId/name swap compiled cleanly and failed at runtime with a stringly error.
  name: ReticleCommand,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(name, args);
  if (!result.ok) throw new Error(result.error ?? `command '${name}' failed`);
  return result.result;
}

interface SnapshotResult {
  tree?: string;
  status?: { route?: string };
}

/** Full DOM snapshot → normalized tree lines + route, for tools that diff or scan the page. */
export async function snapshotTree(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{ lines: string[]; route: string }> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(ReticleCommand.SNAPSHOT, { mode: SnapshotMode.FULL });
  if (!result.ok) throw new Error(result.error ?? 'snapshot failed');
  const snap = (result.result ?? {}) as SnapshotResult;
  return { lines: normalizeLines(snap.tree ?? ''), route: snap.status?.route ?? '' };
}
