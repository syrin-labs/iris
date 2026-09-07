/**
 * Did the update banner actually cause the upgrade?
 *
 * `version_changed` says a version moved. It has never said WHY, so the one thing worth knowing
 * about the nudge — whether telling agents about a release makes releases get installed — was
 * unanswerable. That mattered concretely: 2.4.0 shipped a fix for a connect defect affecting every
 * Vite app and reached zero users, and nothing in the data could say whether the nudge was the
 * problem or the fix.
 *
 * The nudge is delivered by a DAEMON and `reticle update` runs in a different process, so the two
 * cannot see each other in memory. A tiny marker file is the join. It records only the version that
 * was offered and when — no identity, nothing about the machine.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creditNudge, wasNudged } from './nudge-credit.js';
import {
  armUpdateNudgeFrom,
  resetUpdateNudge,
  takeUpdateNudge,
  updateNudgeState,
} from './update-nudge.js';

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('crediting the update nudge', () => {
  it('an update to the version that was offered is credited to the nudge', () => {
    withDir((dir) => {
      creditNudge('2.5.0', dir);
      expect(wasNudged('2.5.0', dir)).toBe(true);
    });
  });

  it('an update to a DIFFERENT version is not — that was the human deciding on their own', () => {
    withDir((dir) => {
      creditNudge('2.5.0', dir);
      expect(wasNudged('2.9.9', dir)).toBe(false);
    });
  });

  it('no nudge, no credit', () => {
    withDir((dir) => {
      expect(wasNudged('2.5.0', dir)).toBe(false);
    });
  });

  it('a corrupt or unreadable marker is simply "not nudged", never a throw', () => {
    // This runs inside `reticle update`, which must finish whatever the telemetry thinks.
    withDir((dir) => {
      writeFileSync(join(dir, 'update-nudge.json'), '{ not json', 'utf8');
      expect(() => wasNudged('2.5.0', dir)).not.toThrow();
      expect(wasNudged('2.5.0', dir)).toBe(false);
    });
  });
});

/**
 * The nudge shipped for several releases and emitted NOTHING.
 *
 * `versionChange.nudged` answers "did the nudge cause this update", which only ever reaches us from
 * machines that DID update. A cohort pinned three releases back never fires `version_changed` at
 * all — so the one population worth understanding was the one the metric structurally could not
 * see, while being nudged the whole time.
 */
describe('the nudge reports whether it actually fired', () => {
  beforeEach(() => {
    resetUpdateNudge();
  });

  it('reports nothing offered and nothing shown on a current install', () => {
    expect(updateNudgeState()).toEqual({ shown: false });
  });

  /**
   * The half that separates "nothing was available" from "something was and the nudge did not
   * fire". Without `offered`, `shown: false` is both facts at once and only one is a defect.
   */
  it('reports the version it knows about even before an agent is told', () => {
    armUpdateNudgeFrom({ latestVersion: '9.9.9' }, '1.0.0');
    expect(updateNudgeState()).toEqual({ shown: false, offered: '9.9.9' });
  });

  it('reports it as shown once an agent has actually taken it', () => {
    armUpdateNudgeFrom({ latestVersion: '9.9.9' }, '1.0.0');
    expect(takeUpdateNudge()).toBeDefined();
    expect(updateNudgeState()).toEqual({ shown: true, offered: '9.9.9' });
  });

  /** One-shot per process by design: the flag means "an agent was told", never how often. */
  it('does not become a counter', () => {
    armUpdateNudgeFrom({ latestVersion: '9.9.9' }, '1.0.0');
    takeUpdateNudge();
    expect(takeUpdateNudge()).toBeUndefined();
    expect(updateNudgeState()).toEqual({ shown: true, offered: '9.9.9' });
  });
});
