/**
 * The client against a server that lies, breaks, or floods.
 *
 * Every other sync test scripts a server that behaves. This one does not — because the local record is
 * the only authoritative copy, and the failure that actually costs somebody their work is a client that
 * corrupts it in response to something the network said.
 *
 * The rule under test is one sentence: NOTHING a server sends may leave the machine worse off than
 * saying nothing at all.
 */
import { describe, expect, it } from 'vitest';
import {
  runSyncCycle,
  type CloudSyncState,
  type PulledIssues,
  type SyncSource,
} from './sync-cycle.js';

const NOW = 1_700_000_000_000;

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  runs: () => [],
  flows: () => [],
  derived: () => undefined,
  ...over,
});

function sink() {
  const written: { issues?: PulledIssues; state?: CloudSyncState } = {};
  return {
    written,
    sink: {
      writeIssues: (i: PulledIssues): void => {
        written.issues = i;
      },
      writeState: (s: CloudSyncState): void => {
        written.state = s;
      },
    },
  };
}

/** Answers each door with whatever the test hands it — including things a server should never send. */
const hostile = (answers: { status?: unknown; sync?: unknown; pull?: unknown }) => {
  const asText = (v: unknown): string => ('string' === typeof v ? v : JSON.stringify(v ?? {}));
  return (url: string): Promise<{ status: number; text: string }> =>
    Promise.resolve({
      status: 200,
      text: url.includes('/pull')
        ? asText(answers.pull)
        : url.includes('/status')
          ? asText(answers.status)
          : asText(answers.sync),
    });
};

const cycle = async (
  answers: Parameters<typeof hostile>[0],
  state: CloudSyncState = {},
  src: SyncSource = source(),
) => {
  const k = sink();
  const report = await runSyncCycle({
    config: { url: 'https://cloud.test', apiKey: 'rk' },
    source: src,
    sink: k.sink,
    state,
    now: () => NOW,
    request: hostile(answers),
  });
  return { report, written: k.written };
};

describe('a server that answers with nonsense', () => {
  it('survives 200 with a body that is not JSON', async () => {
    const { report } = await cycle({ status: '<html>502 Bad Gateway</html>' });
    expect(report.ok).toBe(true);
    expect(report.runsSent).toBe(0);
  });

  it('survives 200 with a JSON array where an object was promised', async () => {
    const { report } = await cycle({ status: [1, 2, 3], pull: [4, 5] });
    expect(report.ok).toBe(true);
    expect(report.pulled).toBe(0);
  });

  it('survives 200 with a bare string', async () => {
    const { report } = await cycle({ status: '"hello"', pull: '"there"' });
    expect(report.ok).toBe(true);
  });

  it('survives 200 with null', async () => {
    const { report } = await cycle({ status: 'null', pull: 'null' });
    expect(report.ok).toBe(true);
  });

  it('treats knownRunIds of the wrong type as "it knows nothing" and sends everything', async () => {
    /*
     * `new Set(someString)` builds a set of CHARACTERS. A `knownRunIds` that arrived as a string made
     * `known.has('a')` true, so the client decided — on the server's malformed word — not to upload a
     * run the server does not have. Silent data loss is the one failure this protocol must not have.
     */
    const { report } = await cycle(
      { status: { knownRunIds: 'not-an-array' }, sync: { runs: { accepted: 1 } } },
      {},
      source({ runs: () => [{ runId: 'a', payload: {} }] }),
    );
    expect(report.runsSent).toBe(1);
  });

  it('ignores non-string entries inside a knownRunIds array', async () => {
    const { report } = await cycle(
      { status: { knownRunIds: [null, 42, 'b'] }, sync: { runs: { accepted: 1 } } },
      {},
      source({
        runs: () => [
          { runId: 'a', payload: {} },
          { runId: 'b', payload: {} },
        ],
      }),
    );
    expect(report.runsSent, 'b was known, a was not').toBe(1);
  });

  it('treats stateHashes of the wrong type as unknown rather than throwing', async () => {
    const { report } = await cycle(
      { status: { stateHashes: 'nope' } },
      {},
      source({ derived: (k) => ('impact' === k ? { counts: 1 } : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });

  it('treats a non-string state hash as "unknown" and re-sends the record', async () => {
    const { report } = await cycle(
      { status: { stateHashes: { impact: 12345 } } },
      {},
      source({ derived: (k) => ('impact' === k ? { counts: 1 } : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });
});

describe('a server that floods', () => {
  it('accepts a very large pull without dropping the decisions in it', async () => {
    const triage = Array.from({ length: 5000 }, (_, i) => ({
      fingerprint: `fp-${String(i)}`,
      status: 'resolved',
      flowName: `f${String(i)}`,
      title: 't',
      at: i,
    }));
    const { report, written } = await cycle({ status: {}, pull: { triage, cursor: '1:z' } });
    expect(report.pulled).toBe(5000);
    expect(Object.keys(written.issues?.triage ?? {}).length).toBe(5000);
  });

  it('does not choke on an enormous cursor string', async () => {
    const { report, written } = await cycle({
      status: {},
      pull: { triage: [], cursor: 'x'.repeat(100_000) },
    });
    expect(report.ok).toBe(true);
    expect(written.state?.cursor?.length).toBe(100_000);
  });

  it('survives a decision whose fields are the wrong types', async () => {
    const { report, written } = await cycle({
      status: {},
      pull: { triage: [{ fingerprint: 'fp', status: 42, flowName: [], title: {}, at: 'soon' }] },
    });
    expect(report.ok).toBe(true);
    expect(written.issues?.triage['fp']).toBeDefined();
  });
});

describe('a server that would corrupt local state', () => {
  it('never lets a missing cursor erase the one already held', async () => {
    // The dangerous case: a cursor reset to undefined re-pulls the entire decision history, and with
    // it every decision a human already applied and moved on from.
    const { written } = await cycle({ status: {}, pull: { triage: [] } }, { cursor: 'keep-me' });
    expect(written.state?.cursor).toBe('keep-me');
  });

  it('never lets a non-string cursor replace the one already held', async () => {
    const { written } = await cycle({ status: {}, pull: { cursor: 99 } }, { cursor: 'keep-me' });
    expect(written.state?.cursor).toBe('keep-me');
  });

  it('writes no issues file when the server sends an empty decision list', async () => {
    const { written } = await cycle({ status: {}, pull: { triage: [] } });
    expect(written.issues).toBeUndefined();
  });

  it('does not invent accepted counts the server never reported', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: {} } },
      {},
      source({ runs: () => [{ runId: 'a', payload: {} }] }),
    );
    expect(report.runsSent).toBe(0);
  });

  it('reports a rejection list of the wrong type as no rejections, not a crash', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: { accepted: 1, rejected: 'lots' } } },
      {},
      source({ runs: () => [{ runId: 'a', payload: {} }] }),
    );
    expect(report.runsRejected).toEqual([]);
  });

  it('leaves the cursor alone when the pull answers something unreadable', async () => {
    const { written } = await cycle({ status: {}, pull: 'not json at all' }, { cursor: 'keep-me' });
    expect(written.state?.cursor).toBe('keep-me');
  });
});
