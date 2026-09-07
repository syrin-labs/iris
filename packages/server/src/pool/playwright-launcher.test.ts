/**
 * The pooled launch hands Playwright more than a headless flag.
 *
 * A pooled browser serves several lease contexts while only one page is ever the visible one, so
 * without the anti-throttling switches every other page gets its timers throttled and its rAF
 * suspended, which is exactly the state a lease reports as `throttled: true`. This pins that what
 * reaches `chromium.launch` carries the switches. It proves plumbing, not Chromium's behavior; the
 * behavioral half needs a real browser and lives outside the unit gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchCalls: unknown[] = [];
let launchRejection: Error | undefined;

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn((opts: unknown) => {
      launchCalls.push(opts);
      if (launchRejection !== undefined) {
        return Promise.reject(launchRejection);
      }
      return Promise.resolve({
        isConnected: () => true,
        newContext: () => Promise.reject(new Error('not reached in this test')),
        close: () => Promise.resolve(),
        on: () => {},
      });
    }),
  },
}));

import { playwrightLauncher } from './playwright-launcher.js';

describe('playwrightLauncher', () => {
  beforeEach(() => {
    launchCalls.length = 0;
    launchRejection = undefined;
  });

  it('passes the anti-throttling args to chromium.launch', async () => {
    const launch = playwrightLauncher({ headless: true });
    const browser = await launch();
    expect(browser.isConnected()).toBe(true);
    expect(launchCalls).toHaveLength(1);
    const opts = launchCalls[0] as { headless?: boolean; args?: readonly string[] };
    expect(opts.headless).toBe(true);
    expect(opts.args).toContain('--disable-background-timer-throttling');
    expect(opts.args).toContain('--disable-backgrounding-occluded-windows');
    expect(opts.args).toContain('--disable-renderer-backgrounding');
  });

  describe('launch failure hints', () => {
    it('tells the user to install Chromium when the executable is missing', async () => {
      launchRejection = new Error(
        "browserType.launch: Executable doesn't exist at /home/x/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
      );
      const launch = playwrightLauncher({ headless: true });
      await expect(launch()).rejects.toThrow(/Chromium is not installed for Playwright/);
      await expect(launch()).rejects.toThrow(/install chromium/);
    });

    it('tells the user to install-deps, not reinstall Chromium, when host shared libraries are missing', async () => {
      // The real shape of Playwright's host-requirement validation failure: the browser binary is
      // present, but its OS-level shared-library dependencies are not, so `chromium.launch` never
      // gets far enough to report a missing executable.
      launchRejection = new Error(
        [
          'browserType.launch: Host system is missing dependencies to run browsers.',
          '',
          'Please install them with the following command:',
          '',
          '    npx playwright install-deps',
          '',
          'Alternatively, use apt:',
          '    apt-get install libnspr4',
        ].join('\n'),
      );
      const launch = playwrightLauncher({ headless: true });
      let thrown: Error | undefined;
      try {
        await launch();
      } catch (err) {
        thrown = err instanceof Error ? err : undefined;
      }
      expect(thrown).toBeDefined();
      // The correct remedy for a missing shared library is install-deps...
      expect(thrown?.message).toMatch(/install-deps chromium/);
      // ...not the missing-binary hint, which fixes nothing here and sends the user in a loop.
      expect(thrown?.message).not.toMatch(/Chromium is not installed for Playwright/);
    });

    it('rethrows an unrelated launch failure unchanged', async () => {
      launchRejection = new Error('spawn ENOENT');
      const launch = playwrightLauncher({ headless: true });
      await expect(launch()).rejects.toThrow('spawn ENOENT');
    });
  });
});
