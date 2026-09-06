import { describe, expect, it } from 'vitest';
import {
  buildDrivePrompt,
  readDriveOutput,
  readPlainOutput,
  type DriveRequest,
} from './drive-agent.js';
import { ASSERTED } from './drive-plan.js';

const req = (over: Partial<DriveRequest> = {}): DriveRequest => ({
  url: 'http://localhost:5173',
  sessionId: 's1',
  tabThrottled: false,
  budgetUsd: 3,
  ...over,
});

describe('the prompt', () => {
  // Measured: with the situation first and a capabilities dump in the middle, a model answered "I
  // don't see an actual task or request from you yet" and drove nothing.
  it('leads with the task, not the context', () => {
    expect(buildDrivePrompt(req()).startsWith('TASK:')).toBe(true);
  });

  it('names the flow when the caller supplied one', () => {
    expect(buildDrivePrompt(req({ flow: 'add to cart' }))).toContain('add to cart');
  });

  it('leaves the choice open when nobody named one', () => {
    expect(buildDrivePrompt(req())).toContain('drive one user flow');
  });

  // Write access exists to finish ONE file. A drive once used it to repair unrelated app source.
  it('scopes the edit when the capabilities file is unfinished', () => {
    const prompt = buildDrivePrompt(req({ unfinishedCapabilitiesFile: 'src/reticle-dev.ts' }));
    expect(prompt).toContain('EDIT ONLY THAT FILE');
    expect(prompt).toContain('say so and stop');
  });

  it('says nothing about capabilities when there is nothing to finish', () => {
    expect(buildDrivePrompt(req())).not.toContain('EDIT ONLY');
  });

  it('warns about a throttled tab so the app is not blamed for a frozen page', () => {
    expect(buildDrivePrompt(req({ tabThrottled: true }))).toContain('clamped');
  });

  // A flow that only acts passes when the feature is broken, and setup replays it forever.
  it('insists on the grade rather than mentioning it', () => {
    const prompt = buildDrivePrompt(req());
    expect(prompt).toContain('asserted');
    expect(prompt).toContain('permanent green');
  });

  // A green verdict shows the mechanism; a finding shows the value. Asked for a verdict alone, a
  // drive returns a verdict alone and everything else the page did goes unmentioned.
  it('asks for what else the app did, whatever the verdict says', () => {
    const prompt = buildDrivePrompt(req());
    expect(prompt).toContain('reticle_observe');
    expect(prompt).toContain('FINDINGS first');
    expect(prompt).toContain('do not skip');
  });

  it('names the kinds of thing worth reporting, rather than leaving it to taste', () => {
    const prompt = buildDrivePrompt(req());
    for (const kind of ['console error', 'failed or slow request', 'unhandled', 'did not update']) {
      expect(prompt).toContain(kind);
    }
  });

  it('refuses to let unknown or no-fault be reported as a pass', () => {
    expect(buildDrivePrompt(req())).toContain('is NOT a pass');
  });
});

describe('reading what came back', () => {
  const complete = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"stop_reason":"end_turn","result":"Flow: login. assertions.grade: asserted","num_turns":9,"total_cost_usd":0.42}',
  ].join('\n');

  it('takes the result, the turns and the cost from a finished run', () => {
    const r = readDriveOutput(complete);
    expect(r.text).toContain('asserted');
    expect(r.grade).toBe('asserted');
    expect(r.turns).toBe(9);
    expect(r.costUsd).toBe(0.42);
    expect(r.incomplete).toBeUndefined();
  });

  // `json` emits nothing until completion, so a killed drive left no trace at all — four times on
  // one app, every one reporting "the drive produced no output".
  it('says where a killed run had got to', () => {
    const killed = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"looking at the page"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"reticle_snapshot"}]}}',
    ].join('\n');
    expect(readDriveOutput(killed).incomplete).toContain('reticle_snapshot');
  });

  it('falls back to the last thing it said when no tool was in flight', () => {
    const killed =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reading the app"}]}}';
    expect(readDriveOutput(killed).incomplete).toContain('reading the app');
  });

  it('survives the truncated final line that a kill actually produces', () => {
    expect(readDriveOutput(`${complete}\n{"type":"assist`).grade).toBe('asserted');
  });

  it('says plainly when there were no events at all', () => {
    expect(readDriveOutput('').incomplete).toContain('no events at all');
  });
});

describe('reading a driver that reports prose', () => {
  it('takes the output as the report, since there is no envelope to unwrap', () => {
    expect(readPlainOutput('  the button stayed disabled  ').text).toBe(
      'the button stayed disabled',
    );
  });

  it('reads the assertions grade out of prose, the same as out of a stream', () => {
    expect(readPlainOutput('ran it. "grade": "asserted" — done').grade).toBe(ASSERTED);
  });

  it('calls silence incomplete rather than a clean run that proved nothing', () => {
    expect(readPlainOutput('   ').incomplete).toBeDefined();
  });
});
