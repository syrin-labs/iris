import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  RUN_FILE_VERSION,
  RunAgentKind,
  RunFramework,
  RunKind,
  RunProfile,
  RunStatus,
  RunTrigger,
  VerdictStatus,
  type FlowFile,
  type ReticleVerificationRun,
  type RunRecord,
} from '@reticlehq/core';
import {
  CloudEnv,
  cloudFetch,
  fetchProjectRegressionFromCloud,
  resolveCloudConfig,
  SyncOutcome,
  syncFlowToCloud,
  syncRunRecordToCloud,
  syncRunToCloud,
  type FetchGetLike,
  type FetchLike,
} from './cloud-sync.js';

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'add-task',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'task-input' } }],
};

const run = {
  schemaVersion: RUN_FILE_VERSION,
  runId: 'run-1',
  createdAt: 1_700_000_000_000,
  durationMs: 420,
  profile: RunProfile.PROD_PREVIEW,
  project: { name: 'my-app', framework: RunFramework.REACT },
  agent: { id: 'reticle-cli', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  evidence: {},
  verdict: { status: VerdictStatus.PASS, confidence: 'high' },
} as ReticleVerificationRun;

describe('resolveCloudConfig', () => {
  it('returns null (sync disabled) unless BOTH env vars are set', () => {
    expect(resolveCloudConfig({})).toBeNull();
    expect(resolveCloudConfig({ [CloudEnv.URL]: 'https://cloud.test' })).toBeNull();
    expect(resolveCloudConfig({ [CloudEnv.KEY]: 'rk_live_x' })).toBeNull();
  });

  it('resolves + trims a trailing slash when both are set (logged in)', () => {
    const cfg = resolveCloudConfig({
      [CloudEnv.URL]: 'https://cloud.test/',
      [CloudEnv.KEY]: 'rk_live_x',
    });
    expect(cfg).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_x' });
  });
});

describe('syncFlowToCloud', () => {
  it('skips when not logged in (no config) — nothing leaves the machine', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const res = await syncFlowToCloud(flow, null, 'proj-1', fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SKIPPED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the flow with the API key + projectId when logged in', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 });
    const res = await syncFlowToCloud(
      flow,
      { url: 'https://cloud.test', apiKey: 'rk_live_x' },
      'proj-1',
      fetchImpl,
    );
    expect(res.outcome).toBe(SyncOutcome.SYNCED);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.test/v1/flows');
    expect(init?.headers.authorization).toBe('Bearer rk_live_x');
    expect(JSON.parse(init?.body ?? '{}')).toEqual({ flow, projectId: 'proj-1' });
  });

  it('reports FAILED (never throws) on a non-ok response or a network error', async () => {
    const bad = vi.fn<FetchLike>().mockResolvedValue({ ok: false, status: 401 });
    expect(
      (await syncFlowToCloud(flow, { url: 'https://c', apiKey: 'k' }, undefined, bad)).outcome,
    ).toBe(SyncOutcome.FAILED);
    const throwing = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    const res = await syncFlowToCloud(flow, { url: 'https://c', apiKey: 'k' }, undefined, throwing);
    expect(res.outcome).toBe(SyncOutcome.FAILED);
    expect(res.error).toBe('offline');
  });
});

describe('syncRunToCloud', () => {
  it('skips when not logged in — the run stays local (no phone-home)', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const res = await syncRunToCloud(run, null, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SKIPPED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the RAW artifact to /v1/runs with the API key when logged in', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 });
    const res = await syncRunToCloud(
      run,
      { url: 'https://cloud.test', apiKey: 'rk_live_x' },
      fetchImpl,
    );
    expect(res.outcome).toBe(SyncOutcome.SYNCED);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.test/v1/runs');
    expect(init?.headers.authorization).toBe('Bearer rk_live_x');
    // body is the run itself (not wrapped) — the cloud ingests the exact @reticlehq/core artifact
    expect((JSON.parse(init?.body ?? '{}') as { runId?: string }).runId).toBe('run-1');
  });

  it('reports FAILED (never throws) on a non-ok response or a network error', async () => {
    const bad = vi.fn<FetchLike>().mockResolvedValue({ ok: false, status: 422 });
    expect((await syncRunToCloud(run, { url: 'https://c', apiKey: 'k' }, bad)).outcome).toBe(
      SyncOutcome.FAILED,
    );
    const throwing = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    expect((await syncRunToCloud(run, { url: 'https://c', apiKey: 'k' }, throwing)).error).toBe(
      'offline',
    );
  });
});

const record: RunRecord = {
  kind: RunKind.FLOW_REPLAY,
  name: 'add-task',
  status: RunStatus.DRIFT,
  at: 1_700_000_000_000,
  durationMs: 512,
};

describe('syncRunRecordToCloud', () => {
  it('skips when not logged in — project.json stays the local source of truth', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const res = await syncRunRecordToCloud(record, 'proj-1', null, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SKIPPED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the flattened outcome to /v1/project/runs with the API key + projectId', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 });
    const res = await syncRunRecordToCloud(
      record,
      'proj-1',
      { url: 'https://cloud.test', apiKey: 'rk_live_x' },
      fetchImpl,
    );
    expect(res.outcome).toBe(SyncOutcome.SYNCED);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.test/v1/project/runs');
    expect(init?.headers.authorization).toBe('Bearer rk_live_x');
    expect(JSON.parse(init?.body ?? '{}')).toEqual({
      flowName: 'add-task',
      status: RunStatus.DRIFT,
      kind: RunKind.FLOW_REPLAY,
      at: 1_700_000_000_000,
      projectId: 'proj-1',
    });
  });

  it('reports FAILED (never throws) on a non-ok response or a network error', async () => {
    const bad = vi.fn<FetchLike>().mockResolvedValue({ ok: false, status: 402 });
    expect(
      (await syncRunRecordToCloud(record, undefined, { url: 'https://c', apiKey: 'k' }, bad))
        .outcome,
    ).toBe(SyncOutcome.FAILED);
    const throwing = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    expect(
      (await syncRunRecordToCloud(record, undefined, { url: 'https://c', apiKey: 'k' }, throwing))
        .error,
    ).toBe('offline');
  });
});

describe('fetchProjectRegressionFromCloud', () => {
  it('returns null (agent stays local) when not logged in — no network touched', async () => {
    const fetchImpl = vi.fn<FetchGetLike>();
    expect(await fetchProjectRegressionFromCloud(null, 'proj-1', fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GETs the regression report with the API key + projectId query', async () => {
    const report = { projectId: 'proj-1', broken: [], changed: [], flowsTracked: 3 };
    const fetchImpl = vi
      .fn<FetchGetLike>()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(report) });
    const got = await fetchProjectRegressionFromCloud(
      { url: 'https://cloud.test', apiKey: 'rk_live_x' },
      'proj-1',
      fetchImpl,
    );
    expect(got).toEqual(report);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.test/v1/project/regression?projectId=proj-1');
    expect(init?.method).toBe('GET');
    expect(init?.headers.authorization).toBe('Bearer rk_live_x');
  });

  it('returns null (never throws) on a non-ok response or a network error', async () => {
    const bad = vi
      .fn<FetchGetLike>()
      .mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    expect(
      await fetchProjectRegressionFromCloud({ url: 'https://c', apiKey: 'k' }, undefined, bad),
    ).toBeNull();
    const throwing = vi.fn<FetchGetLike>().mockRejectedValue(new Error('offline'));
    expect(
      await fetchProjectRegressionFromCloud({ url: 'https://c', apiKey: 'k' }, undefined, throwing),
    ).toBeNull();
  });
});

/** A fetch that never settles on its own — it resolves only when its abort signal fires. */
const stalledFetch = (_url: string, init: { signal?: AbortSignal }): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined) return;
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    });
  });

describe('cloudFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the credential when it was pasted from a masked display, instead of leaking a ByteString error', async () => {
    // The real report: RETICLE_CLOUD_KEY was set to `rk_live_…` — the ellipsis-masked placeholder a
    // dashboard shows so a key is never displayed in full. undici answers that with "Cannot convert
    // argument to a ByteString because the character at index 15 has a value of 8230", which names
    // no variable, no file and no fix, and points at a byte offset in a header the user never saw.
    let dialled = false;
    vi.stubGlobal('fetch', () => {
      dialled = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const error: unknown = await cloudFetch('https://app.reticle.sh/v1/keys', {
      method: 'POST',
      headers: { authorization: 'Bearer rk_live_…' },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('authorization');
    // The two facts that turn this into a one-line fix: it is truncated, and which knob holds it.
    expect(message).toContain('truncated');
    expect(message).toContain('RETICLE_CLOUD_KEY');
    // Refused before dialling — a malformed credential is not worth a round trip.
    expect(dialled).toBe(false);
  });

  it('gives every cloud request an abort signal, so a stalled connection cannot hang forever', async () => {
    const seen: { signal: AbortSignal | undefined } = { signal: undefined };
    vi.stubGlobal('fetch', (_url: string, init: { signal?: AbortSignal }) => {
      seen.signal = init.signal;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await cloudFetch('https://cloud.example/v1/flows', { method: 'GET', headers: {} });
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);
  });

  it('rejects a stalled request instead of hanging on it', async () => {
    vi.stubGlobal('fetch', stalledFetch);
    await expect(
      cloudFetch('https://cloud.example/v1/verifications', { method: 'GET', headers: {} }, 1),
    ).rejects.toThrow();
  });

  it('reports a timeout as an actionable message rather than a bare AbortError', async () => {
    vi.stubGlobal('fetch', stalledFetch);
    const error: unknown = await cloudFetch(
      'https://cloud.example/v1/runs',
      { method: 'POST', headers: {}, body: '{}' },
      1,
    ).catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/timed out/);
    expect(message).toContain('https://cloud.example/v1/runs');
    expect(message).toContain(CloudEnv.URL);
    expect(message).not.toMatch(/AbortError/);
  });

  it('leaves a failure that is not a timeout unchanged', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('getaddrinfo ENOTFOUND cloud.example')));
    await expect(
      cloudFetch('https://cloud.example/v1/runs', { method: 'GET', headers: {} }),
    ).rejects.toThrow('getaddrinfo ENOTFOUND cloud.example');
  });
});
