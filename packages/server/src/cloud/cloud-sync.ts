/**
 * Optional cloud sync for saved flows. "Logged in" here means the two cloud env vars are set (written by
 * `reticle login` later; settable by hand today): the hosted URL and an API key from the Reticle
 * dashboard. When present, a freshly-saved flow is pushed to `POST /v1/flows` so the team's regression
 * suite lives in the cloud — surviving refactors and runnable in CI. When absent, sync is a no-op and
 * everything stays 100% local (the "no phone-home" default: nothing leaves the machine unless you opt in).
 *
 * Sync is best-effort: a network failure NEVER fails the local save. The flow is already on disk; the
 * cloud copy is an enhancement, so a push error is logged and swallowed.
 */
import { z } from 'zod';
import {
  VERIFY_PROGRESS_MAX_EVENTS,
  type FlowFile,
  type ReticleVerificationRun,
  type RunRecord,
  type VerifyProgressEvent,
} from '@reticlehq/core';

/** Env var names — the presence of BOTH is what "logged in" means for cloud sync. */
export const CloudEnv = {
  URL: 'RETICLE_CLOUD_URL',
  KEY: 'RETICLE_CLOUD_KEY',
} as const;

/** Paths the OSS server pushes to (match the cloud app's contract). */
const CLOUD_FLOWS_PATH = '/v1/flows';
const CLOUD_RUNS_PATH = '/v1/runs';
const CLOUD_PROJECT_RUNS_PATH = '/v1/project/runs';
const CLOUD_PROJECT_REGRESSION_PATH = '/v1/project/regression';
const CLOUD_VERIFICATIONS_PATH = '/v1/verifications';
const CLOUD_PROGRESS_PATH = '/v1/connect/progress';

export interface CloudConfig {
  url: string;
  apiKey: string;
}

/** Resolve cloud credentials from the environment, or null when not logged in (sync disabled). */
export function resolveCloudConfig(env: NodeJS.ProcessEnv): CloudConfig | null {
  const url = env[CloudEnv.URL];
  const apiKey = env[CloudEnv.KEY];
  if (typeof url !== 'string' || 0 === url.length) return null;
  if (typeof apiKey !== 'string' || 0 === apiKey.length) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

/**
 * Budget for a cloud call. Node's `fetch` has NO default timeout, so a connection that opens and then
 * stalls never settles — and the caller `await`s it forever. In `reticle_flow_verify` that is an MCP
 * tool call that never returns, and in `reticle cloud …` a terminal that prints nothing.
 *
 * One shared budget covers every call here: they are all small JSON request/response pairs against the
 * same API, so there is nothing to tune per site. The ONE exception is the hosted verification submit,
 * which blocks while a real browser runs the suite server-side — a normal response there is minutes,
 * not seconds, so it gets its own (still bounded) budget rather than dragging the common one up.
 */
const CLOUD_FETCH_TIMEOUT_MS = 30_000;
export const CLOUD_VERIFY_TIMEOUT_MS = 120_000;

/** Names Node gives an abort: `AbortSignal.timeout` raises TimeoutError, an explicit abort AbortError. */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);

/**
 * A header value `fetch` can actually send. Anything above U+00FF is not a valid ByteString.
 *
 * The one that happens in practice is an ellipsis. A dashboard masks a key as `rk_live_…` so it is
 * never shown in full, somebody copies what they can SEE into `.env`, and the request dies deep
 * inside undici with "Cannot convert argument to a ByteString because the character at index 15 has
 * a value of 8230" — a byte offset into a header the user never wrote, naming no variable, no file
 * and no fix.
 */
const UNSENDABLE_HEADER_CHAR = /[^ -ÿ]/;

/** Which knob holds the credential behind a header, so the error can name the thing to go and edit. */
const CREDENTIAL_SOURCE: Readonly<Record<string, string>> = {
  authorization: `${CloudEnv.KEY} (or the session from \`reticle login\`)`,
};

/**
 * Refuse a request whose headers cannot be encoded, before it is sent.
 *
 * Before dialling on purpose: a credential that cannot be encoded cannot succeed, so the round trip
 * buys only a slower and less specific failure.
 */
function assertSendableHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!UNSENDABLE_HEADER_CHAR.test(value)) continue;
    const source = CREDENTIAL_SOURCE[name];
    throw new Error(
      `the ${name} header carries a character that cannot be sent, which means the value is truncated — ` +
        `a credential displayed masked as \`rk_live_…\` keeps that ellipsis when it is copied. ` +
        `Paste the full value${source === undefined ? '' : ` into ${source}`}.`,
    );
  }
}

/**
 * The fetch every cloud call goes through. Adds the abort signal, and turns the abort into a message
 * that says what happened and what to do — a bare `AbortError` reaching a user or an agent is a riddle,
 * and the agent-facing half of this product is judged on whether its errors are actionable.
 */
export async function cloudFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number = CLOUD_FETCH_TIMEOUT_MS,
): Promise<Response> {
  assertSendableHeaders(init.headers);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && TIMEOUT_ERROR_NAMES.has(err.name)) {
      throw new Error(
        `Reticle request timed out after ${Math.round(timeoutMs / 1000)}s: ${init.method} ${url}. ` +
          `The server accepted the connection but never answered. Check the network and ${CloudEnv.URL}, then retry — ` +
          `verification works locally without cloud.`,
      );
    }
    throw err;
  }
}

export const SyncOutcome = {
  SYNCED: 'synced',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;
export type SyncOutcome = (typeof SyncOutcome)[keyof typeof SyncOutcome];

interface SyncResult {
  outcome: SyncOutcome;
  status?: number;
  error?: string;
}

/** A fetch-shaped function, injected so the sync is testable without a real network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** GET-shaped fetch (no body, reads back JSON), injected so the read is testable without a network. */
export type FetchGetLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Push one flow to the cloud. `projectId` scopes it to this app. Returns a structured outcome; never
 * throws — a failure is reported, not propagated, so the local save is authoritative.
 */
export async function syncFlowToCloud(
  flow: FlowFile,
  config: CloudConfig | null,
  projectId: string | undefined,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (null === config) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_FLOWS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(projectId === undefined ? { flow } : { flow, projectId }),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push one verification-run artifact to the cloud. This is what makes "runs recorded on the dashboard"
 * real once a user shifts to the server: after `reticle verify` produces a run, it lands in the team's
 * hosted history with its verdict. Same opt-in creds as flow sync — absent → no-op (stays local). The
 * cloud's `POST /v1/runs` ingests the RAW artifact (validated by the same `@reticlehq/core` schema that
 * built it), so the body is the run itself, not a wrapper. Best-effort: never throws, never blocks exit.
 */
export async function syncRunToCloud(
  run: ReticleVerificationRun,
  config: CloudConfig | null,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (null === config) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_RUNS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(run),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push one project-memory RunRecord (a flow replay/verify outcome) to the cloud so the team's server-side
 * regression history stays current: "did this development break a previously-passing flow?" is answered
 * from these. Same opt-in creds as the others — absent → no-op (project.json stays the local source of
 * truth). `projectId` scopes an org's multiple suites. Best-effort: never throws, never blocks the tool.
 */
export async function syncRunRecordToCloud(
  record: RunRecord,
  projectId: string | undefined,
  config: CloudConfig | null,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (null === config) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_PROJECT_RUNS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        flowName: record.name,
        status: record.status,
        kind: record.kind,
        summary: record.summary,
        at: record.at,
        ...(projectId === undefined ? {} : { projectId }),
      }),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read the team's server-side regression report back down to the agent. This is the half that makes the
 * system "agent-friendly across context loss": a fresh agent (new session, CI box, teammate's machine)
 * whose local .reticle/project.json is empty can still ask the ONE tool it knows — reticle_project — and
 * get the durable cloud memory of what's broken vs before. Returns the raw report (shape owned by the
 * cloud), or null when not logged in / unreachable — so the caller degrades to local-only, never fails.
 */
export async function fetchProjectRegressionFromCloud(
  config: CloudConfig | null,
  projectId: string | undefined,
  fetchImpl: FetchGetLike,
): Promise<unknown> {
  if (null === config) return null;
  try {
    const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
    const res = await fetchImpl(`${config.url}${CLOUD_PROJECT_REGRESSION_PATH}${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** POST-that-reads-JSON fetch shape (injected so the server-verify submit is testable without a network). */
export type FetchPostJsonLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The hosted runner's report, validated at the boundary (the full shape is owned by the cloud app). */
const ServerVerificationSchema = z.object({
  verificationId: z.string(),
  verdict: z.string().nullable(),
  flows: z.array(z.object({ name: z.string(), status: z.string() })),
  summary: z.string(),
});
export type ServerVerification = z.infer<typeof ServerVerificationSchema>;

/**
 * Delegate a verification to the hosted runner: submit the preview URL + flow names to `POST
 * /v1/verifications` and read back the report. This is the `verify: 'server'` half of the per-project
 * config — the WORK runs on the server (real browser pool, later), not the local machine. The server
 * records the verification itself, so there is no separate run-push. Returns null when not attached or the
 * submit fails, so the caller falls back to a local replay. Never throws.
 */
export async function submitServerVerification(
  body: { previewUrl: string; flows: string[]; source: string },
  config: CloudConfig | null,
  fetchImpl: FetchPostJsonLike,
): Promise<ServerVerification | null> {
  if (null === config) return null;
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_VERIFICATIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const parsed = ServerVerificationSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Narrate a run in flight to the dashboard.
 *
 * ## Why this exists
 *
 * Everything else here syncs a FINISHED artifact. That is the right shape for evidence and the wrong
 * shape for the minutes a verification is actually running: a browser launches, flows replay one at
 * a time, and until the run ends the dashboard has nothing to show but a spinner. A run that is
 * working and a run that has died are indistinguishable for the whole of its duration, and somebody
 * watching sat on exactly that ambiguity for fifteen minutes.
 *
 * ## Why it is batched
 *
 * One request per flow is one request per flow. A fifty-flow suite would open a hundred connections
 * to say things that are only interesting in aggregate, so events accumulate and go out on a timer.
 * Two seconds is well under the time a person waits before deciding a page is broken, and well over
 * the time a fast flow takes — so a burst of quick replays becomes one request, not twenty.
 *
 * ## Why it can never matter
 *
 * Opt-in like every other cloud call (no credentials → no-op, nothing leaves the machine), and
 * best-effort at every layer: a failed flush is dropped, never retried and never surfaced. This is
 * narration. The run artifact is the record, it syncs separately, and nothing here is graded or
 * allowed to influence a verdict or an exit code.
 */
export async function syncProgressToCloud(
  runId: string,
  events: readonly VerifyProgressEvent[],
  config: CloudConfig | null,
  fetchImpl: FetchLike,
): Promise<SyncResult> {
  if (null === config) return { outcome: SyncOutcome.SKIPPED };
  if (0 === events.length) return { outcome: SyncOutcome.SKIPPED };
  try {
    const res = await fetchImpl(`${config.url}${CLOUD_PROGRESS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      // Bounded on the way OUT as well as in the schema: a receiver that rejects an oversized batch
      // would drop the whole window, and the newest events are the ones somebody is waiting on.
      body: JSON.stringify({ runId, events: events.slice(-VERIFY_PROGRESS_MAX_EVENTS) }),
    });
    return res.ok
      ? { outcome: SyncOutcome.SYNCED, status: res.status }
      : { outcome: SyncOutcome.FAILED, status: res.status };
  } catch (err) {
    return { outcome: SyncOutcome.FAILED, error: err instanceof Error ? err.message : String(err) };
  }
}

/** How long events accumulate before a flush. See the batching note above. */
export const PROGRESS_FLUSH_MS = 2_000;

/**
 * A listener that buffers progress and ships it on a timer.
 *
 * Returned with its own `flush` and `stop` so the caller can push the last events out when the run
 * ends — otherwise the most interesting event of all, the one saying it finished, waits for a timer
 * that is about to be cleared.
 *
 * The timer is `unref`'d where the runtime supports it: a narration timer must never be the reason a
 * CLI process stays alive after its work is done.
 */
export function createProgressReporter(
  runId: string,
  config: CloudConfig | null,
  fetchImpl: FetchLike,
  flushMs: number = PROGRESS_FLUSH_MS,
): {
  onProgress: (event: VerifyProgressEvent) => void;
  flush: () => Promise<void>;
  stop: () => void;
} {
  /*
   * The WHOLE window, re-sent each flush — not the events since the last one.
   *
   * The receiver REPLACES the row it keeps for a project rather than appending, because one row per
   * project is what stops narration accumulating into a second, ungraded history of the run. A
   * client that sent deltas against that would destroy its own story: each flush would overwrite the
   * row with only the handful of events since the previous one, and a finished run would be
   * represented by whatever its last two seconds happened to contain.
   *
   * Found by running a real verification and watching the dashboard freeze on flow 2 of 3.
   *
   * Re-sending is cheap and idempotent: the window is bounded, the events are tiny, and a replace is
   * the same operation however many times it arrives. `dirty` keeps an unchanged window off the
   * wire, so a run that has gone quiet stops posting rather than resending forever.
   */
  /* Named `accumulated`, not `window`: this is Node, and shadowing the global reads badly. */
  const accumulated: VerifyProgressEvent[] = [];
  let dirty = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (!dirty || 0 === accumulated.length) return;
    // Cleared BEFORE the await so a slow flush does not let the next tick send the same window
    // again; a genuinely new event during the send re-sets it and the next tick picks it up.
    dirty = false;
    await syncProgressToCloud(runId, [...accumulated], config, fetchImpl).catch(() => undefined);
  };

  const start = (): void => {
    if (null !== timer || null === config) return;
    timer = setInterval(() => void flush(), flushMs);
    timer.unref?.();
  };

  return {
    onProgress: (event: VerifyProgressEvent): void => {
      if (null === config) return; // not logged in: nothing is buffered and nothing is sent
      // Bounded, keeping the NEWEST: they are the ones somebody is waiting on.
      if (accumulated.length >= VERIFY_PROGRESS_MAX_EVENTS) accumulated.shift();
      accumulated.push(event);
      dirty = true;
      start();
    },
    flush,
    stop: (): void => {
      if (null !== timer) clearInterval(timer);
      timer = null;
    },
  };
}
