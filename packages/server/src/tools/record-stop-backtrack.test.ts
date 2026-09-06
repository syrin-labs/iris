/**
 * Stop warns when the recorded window left a page and came back.
 *
 * Capture time is when the journey is still cheap to split. Waiting until replay fails on a
 * search-only control, with the tab sitting on the product page, is the failure this exists to
 * name before it is saved.
 */
import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';
import { RecordingStore } from '../flows/recordings.js';

function recordStopTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.RECORD_STOP);
  if (t === undefined) throw new Error('no reticle_record_stop tool');
  return t;
}

function depsWithRoutes(paths: string[]): ToolDeps {
  const recordings = new RecordingStore();
  recordings.start('trip', 0, paths[0]);
  const events = paths.slice(1).map((pathname, i) => ({
    t: i + 1,
    type: EventType.ROUTE_CHANGE,
    sessionId: 's1',
    data: { pathname },
  }));
  const session = {
    elapsed: () => events.length,
    eventsSince: () => events,
  } as unknown as Session;
  return {
    sessions: { resolve: () => session } as unknown as SessionManager,
    recordings,
  } as unknown as ToolDeps;
}

describe('reticle_record stop names a backtracking journey', () => {
  it('warns when the window returned to an earlier page', async () => {
    const res = (await recordStopTool().handler(
      depsWithRoutes(['/search', '/product/1', '/search']),
      {
        recordingName: 'trip',
      },
    )) as { warning?: string; program?: { routes?: string[] } };
    expect(res.warning).toMatch(/returned/i);
    expect(res.program?.routes).toEqual(['/search', '/product/1', '/search']);
  });

  it('stays quiet on a linear journey', async () => {
    const res = (await recordStopTool().handler(depsWithRoutes(['/search', '/product/1']), {
      recordingName: 'trip',
    })) as { warning?: string };
    expect(res.warning).toBeUndefined();
  });
});
