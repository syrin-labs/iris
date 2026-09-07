/**
 * The outage history must survive the schema, or it never happened.
 *
 * `SessionManager.list()` attaches `attachment` to every session row (#117): when the tab dropped
 * and came back, how many times, and how long the last drop lasted. That history decides whether a
 * verdict over the window can be trusted. But the tool's outputSchema never declared the field, and
 * the schema's own comment states the rule: a strict MCP client validates results against it and an
 * undeclared field is silently stripped from structuredContent. So on exactly the clients that
 * validate, the disconnect history vanished while the row still looked complete.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReticleTool } from './tool-names.js';
import { TOOLS } from './tools.js';
import type { ToolDeps } from './tool-kit.js';

const sessionsTool = TOOLS.find((tool) => ReticleTool.SESSIONS === tool.name);

const ROW = {
  sessionId: 's1',
  url: 'http://localhost:3000/',
  adapters: ['web'],
  hasCapabilities: true,
  lastSeenMs: 50,
  throttled: false,
  focused: true,
  hidden: false,
  realInputAvailable: false,
  leased: false,
  attachment: {
    connectedSinceMs: 10,
    outages: 2,
    lastOutage: { startedMs: 20, durationMs: 30 },
  },
};

function depsWithOne(): ToolDeps {
  return {
    sessions: { list: () => [ROW], noSessionHint: () => undefined },
  } as unknown as ToolDeps;
}

describe('reticle_sessions keeps the attachment history', () => {
  it('a strict client parsing the result keeps attachment', () => {
    const sessions = sessionsTool?.outputSchema?.sessions as z.ZodTypeAny;
    const parsed = sessions.parse([ROW]) as Array<Record<string, unknown>>;
    expect(parsed[0]?.['attachment']).toEqual(ROW.attachment);
  });

  it('the handler passes the history through to the result', async () => {
    const result = (await sessionsTool?.handler(depsWithOne(), {})) as {
      sessions: Array<{ attachment?: unknown }>;
    };
    expect(result.sessions[0]?.attachment).toEqual(ROW.attachment);
  });
});
