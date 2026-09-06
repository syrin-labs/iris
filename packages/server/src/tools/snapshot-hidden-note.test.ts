import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SnapshotMode } from '@reticlehq/core';
import { Bridge } from '../bridge/bridge.js';
import type { ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from '../bridge/bridge.test-harness.js';

/**
 * `{ tree: "", nodes: 0 }` is a claim about the app, and on a hidden page it is the wrong one (#672).
 *
 * The lean note already covers one cause of an empty tree and returns early for every mode but
 * `interactive`, so a `full` snapshot of a page whose every node computed hidden said nothing at
 * all. That is what was reported: 44 buttons and 12 textboxes on the page, both modes empty, and
 * about six tool calls spent establishing that the page was fine and the snapshot was wrong.
 *
 * The note carries the count the browser measured and the path that still works. It deliberately
 * does not diagnose WHY the page is hidden — the walk knows what it skipped and cannot know that.
 */
describe('reticle_snapshot — an empty tree on a hidden page', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo', true);
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  async function snapshot(mode: string): Promise<Record<string, unknown>> {
    return (await callTool(deps, ReticleTool.SNAPSHOT, { mode })) as Record<string, unknown>;
  }

  it('says an empty full tree is not an empty page, and how many were skipped', async () => {
    browser.snapshotResult = { tree: '', status: { route: '/app' }, nodes: 0, hiddenSkipped: 3 };
    const result = await snapshot(SnapshotMode.FULL);

    expect(String(result['note'])).toContain('NOT an empty page');
    expect(String(result['note'])).toContain('3');
  });

  it('hands over the path that does work', async () => {
    // The workaround the reporter found on their own and no tool description mentions.
    browser.snapshotResult = { tree: '', status: { route: '/app' }, nodes: 0, hiddenSkipped: 3 };

    expect(String((await snapshot(SnapshotMode.FULL))['note'])).toContain('reticle_query');
  });

  it('says nothing when the tree has nodes in it', async () => {
    browser.snapshotResult = {
      tree: '- button "Pay" (ref=e7)',
      status: { route: '/app' },
      nodes: 1,
      hiddenSkipped: 3,
    };

    expect((await snapshot(SnapshotMode.FULL))['note']).toBeUndefined();
  });

  it('says nothing about an empty tree the walk skipped nothing to produce', async () => {
    // A genuinely empty page must keep reading as one. The note exists to separate the two cases,
    // so attaching it to both would put the tool back where it started.
    browser.snapshotResult = { tree: '', status: { route: '/app' }, nodes: 0 };

    expect((await snapshot(SnapshotMode.FULL))['note']).toBeUndefined();
  });

  it('leaves the more specific lean note in place rather than adding a second', async () => {
    // Both causes can be true at once in `interactive`. Two explanations for one empty tree is worse
    // than the better of them, and leanness is the one that names the mode to switch to.
    browser.snapshotResult = {
      tree: '',
      status: { route: '/app' },
      nodes: 0,
      leanSkipped: 5,
      hiddenSkipped: 3,
    };
    const note = String((await snapshot(SnapshotMode.INTERACTIVE))['note']);

    expect(note).toContain('interactive ARIA role');
    // Matched on a phrase unique to the hidden note: both notes say "NOT an empty page", which is
    // the sentence they exist to say, so it cannot tell them apart.
    expect(note).not.toContain('computed hidden');
  });

  it('covers interactive too when leanness has nothing to say', async () => {
    // Lean mode reaches the same hidden page, and `leanSkipped` is 0 there because the walk never
    // got far enough to pass anything over for leanness.
    browser.snapshotResult = { tree: '', status: { route: '/app' }, nodes: 0, hiddenSkipped: 3 };

    expect(String((await snapshot(SnapshotMode.INTERACTIVE))['note'])).toContain(
      'NOT an empty page',
    );
  });
});
