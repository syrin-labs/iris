/**
 * WHERE an install stopped, for the people who never finish it.
 *
 * The non-instrumented majority arrives as a set difference — `daemon_started` minus
 * `app_instrumented` — and a set difference cannot say why. Four different situations with four
 * different owners land in it as one silence: `init` was never run, `init` ran and failed, `init`
 * ran and the dev server was never restarted, and a working install whose app simply is not up right
 * now. Only the second of those had an event.
 *
 * The two bits that split the rest ride on `project_profiled`, which fires once per daemon start
 * whatever happens next — the only event that reaches us at all for a user who never instruments
 * anything. `app_instrumented` carries `initialized` too and cannot answer this: it only exists when
 * the question is moot.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileProject } from './project-profile.js';
import {
  appEverConnected,
  reportAppInstrumented,
  resetAppInstrumented,
} from './app-instrumented.js';
import { createTelemetry, type TelemetryExtra } from './telemetry.js';
import { TelemetryEventKind } from '@reticlehq/core';

const withTempProject = (build: (root: string) => void, check: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'reticle-install-stage-'));
  try {
    build(root);
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const writeConfig = (root: string, projectId: string): void => {
  writeFileSync(join(root, '.reticle.json'), JSON.stringify({ framework: 'vite', projectId }));
};

describe('the profile says whether the install was ever started', () => {
  it('reports a project that has never been through `reticle init`', () => {
    withTempProject(
      (root) => {
        writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      },
      (root) => {
        expect(profileProject(root, Date.now(), { appConnectedBefore: false }).initialized).toBe(
          false,
        );
      },
    );
  });

  it('reports a project that has been initialized', () => {
    withTempProject(
      (root) => {
        writeFileSync(join(root, 'package.json'), '{"name":"app"}');
        writeConfig(root, 'p1');
      },
      (root) => {
        expect(profileProject(root, Date.now(), { appConnectedBefore: false }).initialized).toBe(
          true,
        );
      },
    );
  });

  /**
   * The cohort the funnel actually loses: the config is written and no page has ever reached the
   * daemon. `initialized` alone cannot see it, because it is `true` for the working installs too.
   */
  it('carries whether an app has EVER connected, separately from this run', () => {
    withTempProject(
      (root) => {
        mkdirSync(join(root, '.reticle'), { recursive: true });
        writeConfig(root, 'p1');
      },
      (root) => {
        expect(
          profileProject(root, Date.now(), { appConnectedBefore: true }).appConnectedBefore,
        ).toBe(true);
        expect(
          profileProject(root, Date.now(), { appConnectedBefore: false }).appConnectedBefore,
        ).toBe(false);
      },
    );
  });

  /** A telemetry snapshot must never be able to fail a daemon start. */
  it('still profiles an unreadable project', () => {
    const profile = profileProject('/nonexistent-reticle-project', Date.now(), {
      appConnectedBefore: false,
    });
    expect(profile.initialized).toBe(false);
  });
});

const TEST_ENV = {
  RETICLE_TELEMETRY_KEY: 'phc_test',
  RETICLE_TELEMETRY_URL: 'http://example.test',
};
/** Outside this repo: a source checkout disables telemetry, correctly. */
const USER_PROJECT = '/tmp/some-user-app';

interface CapturedBatch {
  batch: Array<{ event: string; properties: Record<string, unknown> }>;
}

const propertiesFor = async (
  kind: TelemetryEventKind,
  extra: TelemetryExtra,
): Promise<Record<string, unknown>> => {
  const calls: CapturedBatch[] = [];
  const impl = ((_url: string, init: { body?: string }) => {
    calls.push(JSON.parse(init.body ?? '{}') as CapturedBatch);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    version: '9.9.9',
    env: { ...TEST_ENV },
    cwd: USER_PROJECT,
    fetchImpl: impl,
  });
  await telemetry.emit(kind, extra);
  return calls[0]?.batch[0]?.properties ?? {};
};

describe('the connect event says what the agent had to look at', () => {
  it('reports that no app was attached when the agent arrived', async () => {
    const properties = await propertiesFor(TelemetryEventKind.MCP_CLIENT_CONNECTED, {
      connection: { reconnect: false, daemonAgeMs: 5, appConnected: false },
    });
    expect(properties['connection_appConnected']).toBe(false);
  });

  /**
   * One flag, read by both halves of the funnel. A second counter here would drift from
   * `app_instrumented` and the two would disagree about the same daemon run.
   */
  it('flips only once an app has actually connected to this daemon run', () => {
    resetAppInstrumented();
    expect(appEverConnected()).toBe(false);
    reportAppInstrumented({ initialized: true, agentAttached: true });
    expect(appEverConnected()).toBe(true);
  });
});
