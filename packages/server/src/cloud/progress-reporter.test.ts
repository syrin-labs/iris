/**
 * Narration for a run in flight, and the guarantees that keep it from mattering.
 *
 * Everything else in cloud-sync ships a FINISHED artifact. That is right for evidence and wrong for
 * the minutes a verification actually takes: until the run ends the dashboard has nothing to show,
 * so a run that is working and a run that has died look the same from outside. Somebody watching one
 * sat on that ambiguity for fifteen minutes.
 *
 * What these tests protect is that it can never cost anything — not a request per flow, not a hung
 * process, and above all not a verification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyPhase, type VerifyProgressEvent } from '@reticlehq/core';
import {
  createProgressReporter,
  syncProgressToCloud,
  SyncOutcome,
  type CloudConfig,
  type FetchLike,
} from './cloud-sync.js';

/** One captured call, so a test can read the URL, headers and body it actually sent. */
interface Sent {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

const CONFIG: CloudConfig = { url: 'https://cloud.test', apiKey: 'rk_live_x' };
const event = (phase: VerifyPhase, at = 1): VerifyProgressEvent => ({ phase, at });

/*
 * Typed against the real FetchLike rather than a bare `vi.fn()`, which infers a zero-argument
 * signature and leaves every `mock.calls[0]` assertion reading `never`.
 */
const recorder = (): { fetchImpl: FetchLike; sent: Sent[] } => {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    sent.push({ url, init });
    return Promise.resolve({ ok: true, status: 200 });
  };
  return { fetchImpl, sent };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('posting a batch', () => {
  it('sends the events to the dashboard with the key', async () => {
    const { fetchImpl, sent } = recorder();
    const res = await syncProgressToCloud('s1', [event(VerifyPhase.GRADING)], CONFIG, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SYNCED);
    expect(sent[0]?.url).toBe('https://cloud.test/v1/connect/progress');
    expect(sent[0]?.init.headers['authorization']).toBe('Bearer rk_live_x');
  });

  /* The no-phone-home default: without credentials nothing leaves the machine, ever. */
  it('sends nothing at all when there are no credentials', async () => {
    const { fetchImpl, sent } = recorder();
    const res = await syncProgressToCloud('s1', [event(VerifyPhase.GRADING)], null, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.SKIPPED);
    expect(sent).toHaveLength(0);
  });

  it('does not open a connection to say nothing', async () => {
    const { fetchImpl, sent } = recorder();
    await syncProgressToCloud('s1', [], CONFIG, fetchImpl);
    expect(sent).toHaveLength(0);
  });

  it('reports a refusal instead of throwing into the run', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve({ ok: false, status: 500 });
    const res = await syncProgressToCloud('s1', [event(VerifyPhase.GRADING)], CONFIG, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.FAILED);
    expect(res.status).toBe(500);
  });

  it('survives a network that is simply gone', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));
    const res = await syncProgressToCloud('s1', [event(VerifyPhase.GRADING)], CONFIG, fetchImpl);
    expect(res.outcome).toBe(SyncOutcome.FAILED);
  });
});

describe('the buffering reporter', () => {
  /* One request per flow is one request per flow. A fifty-flow suite must not open fifty. */
  it('batches a burst of events into a single request', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 2_000);
    r.onProgress(event(VerifyPhase.FLOW_STARTED));
    r.onProgress(event(VerifyPhase.FLOW_FINISHED));
    r.onProgress(event(VerifyPhase.FLOW_STARTED));
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toHaveLength(1);
    const body = JSON.parse(String(sent[0]?.init.body)) as { runId: string; events: unknown[] };
    expect(body.events).toHaveLength(3);
    expect(body.runId).toBe('s1');
    r.stop();
  });

  /*
   * The final flush matters most: the event saying the run finished would otherwise wait for a timer
   * that is about to be cleared, and the one thing everybody is waiting for would never arrive.
   */
  it('ships what is left when the run ends', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 2_000);
    r.onProgress(event(VerifyPhase.GRADING));
    r.stop();
    await r.flush();
    expect(sent).toHaveLength(1);
  });

  /*
   * The receiver REPLACES the row, so a client that sent deltas would overwrite its own story: each
   * flush would leave only the events since the last one, and a finished run would be whatever its
   * final two seconds contained. Found by running a real verification and watching the dashboard
   * freeze on flow 2 of 3.
   */
  it('re-sends the whole window, because the receiver replaces rather than appends', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 1_000);
    r.onProgress(event(VerifyPhase.FLOWS_FOUND, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    r.onProgress(event(VerifyPhase.FLOW_STARTED, 2));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(2);
    const second = JSON.parse(String(sent[1]?.init.body)) as { events: Array<{ at: number }> };
    // The SECOND batch carries the first event too — not just what arrived since.
    expect(second.events.map((e) => e.at)).toEqual([1, 2]);
    r.stop();
  });

  it('stops posting once a run has gone quiet, rather than resending forever', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 1_000);
    r.onProgress(event(VerifyPhase.GRADING));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    r.stop();
  });

  it('buffers nothing and starts no timer when nobody is logged in', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', null, fetchImpl, 1_000);
    r.onProgress(event(VerifyPhase.GRADING));
    await vi.advanceTimersByTimeAsync(5_000);
    await r.flush();
    expect(sent).toHaveLength(0);
    r.stop();
  });

  /* A run with thousands of flows must not grow this without bound. */
  it('keeps the newest events rather than growing forever', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 10_000);
    for (let i = 0; i < 260; i += 1) r.onProgress(event(VerifyPhase.FLOW_STARTED, i));
    r.stop();
    await r.flush();
    const body = JSON.parse(String(sent[0]?.init.body)) as { events: Array<{ at: number }> };
    expect(body.events.length).toBeLessThanOrEqual(200);
    // The newest survive: they are the ones somebody is actually waiting on.
    expect(body.events.at(-1)?.at).toBe(259);
    r.stop();
  });

  it('stops sending once it is stopped', async () => {
    const { fetchImpl, sent } = recorder();
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 1_000);
    r.onProgress(event(VerifyPhase.GRADING));
    r.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(0);
  });

  /* A failed flush is dropped, never retried, and never surfaced. This is narration. */
  it('swallows a failing flush without throwing at the caller', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('down'));
    const r = createProgressReporter('s1', CONFIG, fetchImpl, 1_000);
    r.onProgress(event(VerifyPhase.GRADING));
    r.stop();
    await expect(r.flush()).resolves.toBeUndefined();
  });
});
