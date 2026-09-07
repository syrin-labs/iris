/**
 * One full conversation with the dashboard: ask, send the difference, collect what came back.
 *
 * ── WHY IT LOOKS LIKE THIS ─────────────────────────────────────────────────────────────────────
 * `.reticle/` is the source of truth and always will be. Reticle has to work with no account and no
 * network; a verification that blocks on an HTTP round trip is one somebody switches off. So the
 * dashboard is a REPLICA, and this is the replication protocol:
 *
 *   1. ASK      GET /v1/sync/status  → run ids it already holds, a content hash per derived record
 *   2. SEND     POST /v1/sync        → only unseen runs, only records whose hash moved
 *   3. COLLECT  GET /v1/sync/pull    → decisions a human made there, since our cursor
 *   4. APPLY    write them to .reticle/issues.json so the HUD and the next run can see them
 *
 * ASK-THEN-SEND, not send-everything. A three-hour session rewrites impact.json on every tool call;
 * uploading it each time would re-send the same megabytes dozens of times, and a sync that costs
 * that much is one people turn off — which is the real failure, because a dashboard nobody syncs to
 * is a dashboard nobody opens. When nothing has moved, a cycle sends nothing at all, and that is
 * what makes running it on a timer affordable.
 *
 * HASHES, NOT TIMESTAMPS. Two machines comparing their own clocks is a guess: they drift, and a
 * laptop that was asleep will cheerfully decide it is current. A content hash is an answer.
 *
 * BOTH DIRECTIONS, ALWAYS. The pull runs even when there is nothing to push — a quiet machine is
 * precisely the one whose dashboard somebody has been triaging on, so skipping the pull when the
 * push is empty would starve the direction that matters most.
 *
 * NOTHING IS DELETED LOCALLY ON SUCCESS. A lost response costs one redundant upload rather than a
 * hole in the record, and the server dedupes by run id anyway.
 *
 * Every dependency is injected — the clock, the fetch, the reads and writes — because this is the
 * one piece of Reticle that talks to a network AND to a disk, and it must be provable without either.
 */
import { ReticleDir } from '@reticlehq/core';
import { hashPayload } from './sync-hash.js';

/** The server's own doors. Kept beside the code that calls them, like the other cloud paths. */
const SYNC_PATH = '/v1/sync';
const SYNC_STATUS_PATH = '/v1/sync/status';
const SYNC_PULL_PATH = '/v1/sync/pull';

/**
 * The derived records that ride along with runs, and the file each one lives in.
 *
 * A list rather than three hand-written blocks so adding a fourth is one line and cannot be
 * half-done — the bundle, the hashing and the reporting all walk this.
 */
const DERIVED_RECORDS = [
  { kind: 'impact', file: ReticleDir.IMPACT_FILE },
  { kind: 'flake', file: ReticleDir.FLAKE_FILE },
  { kind: 'intent', file: ReticleDir.INTENT_FILE },
] as const;

type DerivedKind = (typeof DERIVED_RECORDS)[number]['kind'];

/** What the machine reads from disk. Injected so a cycle is testable with no filesystem at all. */
export interface SyncSource {
  /** Every run artifact currently on disk. */
  runs: () => ReadonlyArray<{ runId: string; payload: unknown }>;
  /** Every saved flow. Small, upserted by name, so they ride along whenever anything else does. */
  flows: () => readonly unknown[];
  /** One derived record, or undefined when the file is absent. */
  derived: (kind: DerivedKind) => unknown;
}

/** What the machine writes back. Separated from reads so a dry run is a source with no sink. */
export interface SyncSink {
  /** Persist the triage decisions pulled from the dashboard. */
  writeIssues: (issues: PulledIssues) => void;
  /** Persist the cursor and the bookkeeping. */
  writeState: (state: CloudSyncState) => void;
}

/** A decision a human made on the dashboard, as the machine stores it. */
interface PulledIssue {
  status: string;
  flowName: string | null;
  title: string;
  at: number;
}

export interface PulledIssues {
  /** Keyed by the server's fingerprint — stable across runs, which is the point of it. */
  triage: Record<string, PulledIssue>;
}

/** `.reticle/cloud-state.json`. This machine's side of the conversation, never git-checked. */
export interface CloudSyncState {
  /** Opaque. Handed back to the server verbatim; the machine must never parse or invent one. */
  cursor?: string;
  lastPushAt?: number;
  lastPullAt?: number;
  /** The last failure, kept so `reticle sync` can say why it is behind instead of just "0 sent". */
  lastError?: string;
}

export interface SyncReport {
  ok: boolean;
  /** Runs the server accepted this cycle. */
  runsSent: number;
  /** Runs it refused, with the reason, so a bad artifact is visible rather than silently stuck. */
  runsRejected: Array<{ index: number; reason: string }>;
  flowsSent: number;
  /** Which derived records had actually moved. Empty on a quiet cycle, which is the normal case. */
  derivedSent: DerivedKind[];
  /** Decisions collected from the dashboard. */
  pulled: number;
  /** True when the pull page was full — call again now rather than waiting for the next tick. */
  morePending: boolean;
  /**
   * The repo holds NO artifacts at all — no runs, no flows, no derived records.
   *
   * Distinct from "everything here is already pushed", which is the healthy steady state and looks
   * identical from the outside. An empty repo usually means the app announces no projectId, so its
   * runs are pooling into a different root and this binding will never report anything. Tracked so
   * the summary can tell a user which of the two they are looking at.
   */
  localIsEmpty?: boolean;
  /** Set when the cycle could not complete. The local record is untouched either way. */
  error?: string;
}

interface SyncDeps {
  config: { url: string; apiKey: string };
  source: SyncSource;
  sink: SyncSink;
  state: CloudSyncState;
  now: () => number;
  /** Injected so a cycle can be driven against a scripted server with no network. */
  request: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ status: number; text: string }>;
}

interface StatusResponse {
  knownRunIds?: string[];
  truncated?: boolean;
  stateHashes?: Record<string, string | null>;
}

interface PullResponse {
  triage?: Array<{
    fingerprint: string;
    status: string;
    flowName?: string | null;
    title?: string;
    at: number;
  }>;
  cursor?: string;
  more?: boolean;
}

const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => 'object' === typeof v && null !== v;

/**
 * Run one cycle. Never throws: the local record is already safe on disk, and a sync that can take
 * down the thing it is backing up is worse than no sync.
 */
export async function runSyncCycle(deps: SyncDeps): Promise<SyncReport> {
  const empty: SyncReport = {
    ok: false,
    runsSent: 0,
    runsRejected: [],
    flowsSent: 0,
    derivedSent: [],
    pulled: 0,
    morePending: false,
  };

  const call = async (
    path: string,
    init?: { method: string; body?: string },
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const res = await deps.request(`${deps.config.url}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.config.apiKey}`,
      },
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    return { status: res.status, json: asJson(res.text), text: res.text };
  };

  const nextState: CloudSyncState = { ...deps.state };

  try {
    // 1. ASK.
    const status = await call(SYNC_STATUS_PATH);
    if (200 !== status.status) {
      const error = `status ${String(status.status)}: ${status.text.slice(0, 200)}`;
      deps.sink.writeState({ ...nextState, lastError: error });
      return { ...empty, error };
    }
    const held = isRecord(status.json) ? (status.json as StatusResponse) : {};
    /*
     * Validated, not trusted. `new Set(someString)` builds a set of CHARACTERS, so a `knownRunIds`
     * that arrived as a string made `known.has('a')` true and silently skipped any run whose id was
     * one of those letters — the client deciding, on the server's malformed word, not to upload
     * something the server does not have. Silent data loss is the one failure this protocol must
     * not have, and an unreadable answer has to mean "it knows nothing", never "it knows this".
     */
    const known = new Set(
      Array.isArray(held.knownRunIds)
        ? held.knownRunIds.filter((id): id is string => 'string' === typeof id)
        : [],
    );
    // Same rule for the hashes: only a string can equal a hash we computed, so anything else reads
    // as "unknown" and the record is sent once. Re-sending costs a request; skipping costs the data.
    const hashes = isRecord(held.stateHashes) ? held.stateHashes : {};

    // 2. SEND — only what the server does not already have.
    const allRuns = deps.source.runs();
    const unsent = allRuns.filter((r) => !known.has(r.runId));
    const derivedSent: DerivedKind[] = [];
    const bundle: Record<string, unknown> = {};
    if (unsent.length > 0) bundle['runs'] = unsent.map((r) => r.payload);
    for (const { kind } of DERIVED_RECORDS) {
      const payload = deps.source.derived(kind);
      if (payload === undefined) continue;
      // The one comparison the whole protocol rests on. Same hash, do not send it.
      if (hashPayload(payload) === hashes[kind]) continue;
      bundle[kind] = payload;
      derivedSent.push(kind);
    }
    // Flows are small and upserted by name, so they ride along whenever anything else does rather
    // than earning a round trip of their own.
    const flows =
      bundle['runs'] === undefined && 0 === derivedSent.length ? [] : deps.source.flows();
    if (flows.length > 0) bundle['flows'] = flows;

    let runsSent = 0;
    let flowsSent = 0;
    let runsRejected: Array<{ index: number; reason: string }> = [];
    if (Object.keys(bundle).length > 0) {
      const pushed = await call(SYNC_PATH, { method: 'POST', body: JSON.stringify(bundle) });
      if (200 !== pushed.status) {
        const error = `sync ${String(pushed.status)}: ${pushed.text.slice(0, 200)}`;
        deps.sink.writeState({ ...nextState, lastError: error });
        return { ...empty, error };
      }
      const body = isRecord(pushed.json) ? pushed.json : {};
      const runs = isRecord(body['runs']) ? body['runs'] : {};
      const flowsPart = isRecord(body['flows']) ? body['flows'] : {};
      runsSent = 'number' === typeof runs['accepted'] ? runs['accepted'] : 0;
      flowsSent = 'number' === typeof flowsPart['accepted'] ? flowsPart['accepted'] : 0;
      runsRejected = Array.isArray(runs['rejected'])
        ? (runs['rejected'] as Array<{ index: number; reason: string }>)
        : [];
      nextState.lastPushAt = deps.now();
    }

    // 3. COLLECT — always, even when there was nothing to send.
    const query =
      nextState.cursor === undefined ? '' : `?since=${encodeURIComponent(nextState.cursor)}`;
    const pull = await call(`${SYNC_PULL_PATH}${query}`);
    if (200 !== pull.status) {
      // The push already landed; report it rather than throwing the whole cycle away.
      const error = `pull ${String(pull.status)}: ${pull.text.slice(0, 200)}`;
      deps.sink.writeState({ ...nextState, lastError: error });
      return { ...empty, ok: false, runsSent, flowsSent, derivedSent, runsRejected, error };
    }
    const pulled = isRecord(pull.json) ? (pull.json as PullResponse) : {};
    const decisions = pulled.triage ?? [];

    // 4. APPLY.
    if (decisions.length > 0) {
      const triage: Record<string, PulledIssue> = {};
      for (const d of decisions) {
        triage[d.fingerprint] = {
          status: d.status,
          flowName: d.flowName ?? null,
          title: d.title ?? '',
          at: d.at,
        };
      }
      deps.sink.writeIssues({ triage });
    }
    // The cursor is written even on an empty page: it is the server's, and it never goes backwards.
    if ('string' === typeof pulled.cursor) nextState.cursor = pulled.cursor;
    nextState.lastPullAt = deps.now();
    delete nextState.lastError;
    deps.sink.writeState(nextState);

    return {
      ok: true,
      runsSent,
      runsRejected,
      flowsSent,
      derivedSent,
      pulled: decisions.length,
      morePending: true === pulled.more,
      /*
       * Nothing on disk at all, as opposed to nothing NEW. Computed from what the source offered
       * before any cursor filtering, because a repo whose runs were all already pushed is healthy
       * and a repo that has never recorded one is usually misconfigured.
       */
      localIsEmpty:
        0 === allRuns.length &&
        0 === deps.source.flows().length &&
        DERIVED_RECORDS.every(({ kind }) => deps.source.derived(kind) === undefined),
    };
  } catch (error: unknown) {
    // A network that is down is not an error condition for a local-first tool; it is Tuesday.
    const message = describeTransportError(error, deps.config.url);
    deps.sink.writeState({ ...nextState, lastError: message });
    return { ...empty, error: message };
  }
}

/**
 * Say WHICH host failed and WHY.
 *
 * Node's fetch rejects with the bare string "fetch failed" and hides the real reason — a refused
 * connection, a bad hostname, an expired certificate — one level down in `cause`. A machine that
 * has quietly stopped syncing shows that string in `reticle whoami`, and on its own it is
 * indistinguishable from every other network problem, so the person reading it learns nothing and
 * checks nothing. Naming the origin and the underlying code turns it into one thing to look at.
 */
function describeTransportError(error: unknown, url: string): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return `${error.message} (${url})`;
  const code = (cause as { code?: unknown }).code;
  // The code and the message are each sometimes empty — an aggregate DNS failure carries a code and
  // no text, a TLS failure the reverse. Joined only when both are there, so the line never trails
  // off into a dangling separator.
  const parts = ['string' === typeof code && code.length > 0 ? code : '', cause.message].filter(
    (part) => part.length > 0,
  );
  const detail = parts.join(': ');
  return 0 === detail.length
    ? `${error.message} (${url})`
    : `${error.message} — ${detail} (${url})`;
}

/** One line a human can read, for the CLI and the daemon log. */
export function describeSync(report: SyncReport): string {
  if (report.error !== undefined) return `sync failed — ${report.error}`;
  const sent: string[] = [];
  if (report.runsSent > 0) sent.push(`${String(report.runsSent)} run(s)`);
  if (report.flowsSent > 0) sent.push(`${String(report.flowsSent)} flow(s)`);
  if (report.derivedSent.length > 0) sent.push(report.derivedSent.join(', '));
  /*
   * "Nothing to send" is a statement about the QUEUE, and it is false the moment the queue was full
   * and the server threw it away. Built from what was accepted, the sentence used to read "nothing
   * to send, 3 rejected" — something was very much sent, and the reader is told both that it was
   * not and nothing about why.
   */
  const push =
    sent.length > 0
      ? `sent ${sent.join(' + ')}`
      : report.runsRejected.length > 0
        ? 'nothing accepted'
        : true === report.localIsEmpty
          ? // Not the same statement as "nothing to send", which describes a repo that is simply up
            // to date. This one has never recorded anything, which for a LINKED repo usually means
            // the app announces no projectId and its runs are landing under a different root.
            'nothing recorded here yet — if this app has been driven, it is reporting somewhere else'
          : 'nothing to send';
  const pull =
    0 === report.pulled
      ? ''
      : `, pulled ${String(report.pulled)} decision(s)${report.morePending ? ' (more waiting)' : ''}`;
  /*
   * One reason, not a count. A rejection count tells somebody they have a problem and nothing about
   * which problem — and these arrive from a BACKGROUND daemon, so the summary line is often the only
   * place anybody ever sees it. Rejections in one cycle almost always share a cause (a version skew
   * refuses every payload the same way), so the first reason plus the count is the whole story
   * without printing a line per run; `reticle sync` still lists them all.
   */
  const bad =
    0 === report.runsRejected.length
      ? ''
      : `, ${String(report.runsRejected.length)} rejected — ${report.runsRejected[0]?.reason ?? 'no reason given'}`;
  return `${push}${pull}${bad}`;
}
