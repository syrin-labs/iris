import { describe, expect, it } from 'vitest';
import {
  ASSERTED,
  chooseDriver,
  DRIVERS,
  readAssertionsGrade,
  shouldEscalate,
} from './drive-plan.js';

describe('choosing who drives', () => {
  const all =
    (bins: string[], broken: string[] = []) =>
    (bin: string) => ({
      present: bins.includes(bin),
      runs: bins.includes(bin) && !broken.includes(bin),
    });

  it('prefers the first available driver', () => {
    expect(chooseDriver(DRIVERS, all(['claude', 'gemini']))?.id).toBe('claude');
  });

  // A CLI on PATH that does not run produces an empty session which looks exactly like success.
  it('skips a driver that is installed but does not run', () => {
    expect(chooseDriver(DRIVERS, all(['claude', 'gemini'], ['claude']))?.id).toBe('gemini');
  });

  it('has no driver when none is usable', () => {
    expect(chooseDriver(DRIVERS, all(['claude'], ['claude']))).toBeNull();
  });

  it('covers more than one vendor, so the verdict is not withheld over tool choice', () => {
    expect(new Set(DRIVERS.map((d) => d.id)).size).toBeGreaterThan(1);
  });
});

describe('reading the grade out of the drive report', () => {
  it('finds it in the form the drive usually writes', () => {
    expect(readAssertionsGrade('**assertions.grade:** `asserted` (1 consequence step)')).toBe(
      'asserted',
    );
  });

  it('finds a weak grade just as reliably', () => {
    expect(readAssertionsGrade('Flow saved. assertions.grade: presence-only')).toBe(
      'presence-only',
    );
  });

  it('reports nothing when the drive never said', () => {
    expect(readAssertionsGrade('I could not reach the page at all.')).toBeUndefined();
    expect(readAssertionsGrade(undefined)).toBeUndefined();
  });
});

describe('when to re-record instead of accepting the flow', () => {
  const base = {
    escalationEnabled: true,
    fasterModel: 'sonnet',
    flowSaved: true,
    grade: 'presence-only',
  };

  it('re-records a weak flow', () => {
    expect(shouldEscalate(base)).toBe(true);
    expect(shouldEscalate({ ...base, grade: 'assertion-free' })).toBe(true);
  });

  it('leaves an already-asserted flow alone', () => {
    expect(shouldEscalate({ ...base, grade: ASSERTED })).toBe(false);
  });

  // Escalation means retrying WITHOUT the faster model. With no faster model in play there is
  // nothing stronger to retry with, so it would just repeat the same run at the same cost.
  it('does not escalate when no faster model was used', () => {
    expect(shouldEscalate({ ...base, fasterModel: undefined })).toBe(false);
  });

  it('does not escalate when there is no flow to improve', () => {
    expect(shouldEscalate({ ...base, flowSaved: false })).toBe(false);
  });

  it('does not escalate on a grade it could not read, which would be guessing', () => {
    expect(shouldEscalate({ ...base, grade: undefined })).toBe(false);
  });

  it('respects the opt-out', () => {
    expect(shouldEscalate({ ...base, escalationEnabled: false })).toBe(false);
  });
});

describe('each driver invokes itself', () => {
  const invocation = { tools: 'A,B', budgetUsd: 4, model: undefined, prompt: 'drive it' };

  it('gives every driver its own argv, not Claude Code’s', () => {
    for (const driver of DRIVERS) {
      const args = driver.argv(invocation);
      if ('claude' === driver.id) continue;
      // These are Claude Code spellings. Any other CLI exits on them with an unknown-flag error,
      // which is what one shared argv did before each driver carried its own.
      expect(args).not.toContain('--permission-mode');
      expect(args).not.toContain('--allowedTools');
      expect(args).not.toContain('--max-budget-usd');
    }
  });

  it('passes the prompt as an argument exactly when the driver does not read stdin', () => {
    for (const driver of DRIVERS) {
      const carriesPrompt = driver.argv(invocation).includes(invocation.prompt);
      expect(carriesPrompt).toBe('arg' === driver.promptVia);
    }
  });

  it('drives Codex through `codex exec`, its headless form', () => {
    const codex = DRIVERS.find((d) => 'codex' === d.id);
    expect(codex?.argv(invocation)[0]).toBe('exec');
  });

  it('reads streamed NDJSON from Claude Code alone', () => {
    expect(DRIVERS.filter((d) => d.streamsNdjson).map((d) => d.id)).toEqual(['claude']);
  });

  it('names the model to whichever driver was asked for one', () => {
    for (const driver of DRIVERS) {
      expect(driver.argv({ ...invocation, model: 'a-model' })).toContain('a-model');
    }
  });
});
