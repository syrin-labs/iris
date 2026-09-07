/**
 * The last line of `init` must be something the reader can DO, not something they can delegate.
 *
 * It ended: "Once it shows a session, ask your agent to drive a flow — that is the install
 * finished." Every clause is addressed to a human, and the final one asks that human to ask
 * somebody else. But the agent-driven install is now the primary channel: the reader is usually
 * the agent, and telling an agent to "ask your agent" is a hand-off to nobody.
 *
 * This is the last instruction most people read. The funnel breaks here for the same reason it
 * breaks at the capabilities file: work is described rather than assigned, and nothing carries it
 * past the restart. So the closing names the remaining work as work, and says to do it now.
 *
 * It cannot ASSERT the flow was driven — `init` writes files and stops, and claiming otherwise
 * would be the false green this product exists to prevent. What it can do is stop pretending a
 * human is required.
 */

import { describe, expect, it } from 'vitest';
import { restartHint } from './closing-hint.js';
import { StepStatus } from './plan.js';
import { Framework } from './detect.js';

const closing = (status: StepStatus) => restartHint(Framework.VITE, status, 'pnpm dev');

describe('the closing assigns the work rather than delegating it', () => {
  it.each([StepStatus.APPLY, StepStatus.ALREADY])('%s: does not say "ask your agent"', (s) => {
    expect(closing(s)).not.toMatch(/ask your agent/i);
  });

  it.each([StepStatus.APPLY, StepStatus.ALREADY])('%s: says to drive a flow', (s) => {
    expect(closing(s)).toMatch(/drive (one|a) flow/i);
  });

  /**
   * The sentence that stops an agent parking the job on a human. The ALREADY branch already had
   * it; the APPLY branch — a first install, the one that matters most — did not.
   */
  it.each([StepStatus.APPLY, StepStatus.ALREADY])('%s: says nobody is waiting on a human', (s) => {
    expect(closing(s)).toMatch(/nothing here is waiting on a human|do (this|it) now/i);
  });
});

describe('it still tells the truth about what happened', () => {
  it('does not claim a flow was driven, because init only writes files', () => {
    expect(closing(StepStatus.APPLY)).not.toMatch(/verified|flow passed|drove/i);
  });

  it('still names the restart on a first install, which is genuinely required', () => {
    expect(closing(StepStatus.APPLY)).toMatch(/restart your agent/i);
  });

  it('still says there is no restart to do when the tools are already there', () => {
    expect(closing(StepStatus.ALREADY)).not.toMatch(/restart your agent/i);
  });
});
