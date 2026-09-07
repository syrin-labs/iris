/**
 * The drive-path launch hands Playwright more than a headless flag.
 *
 * `reticle drive` owns its browser outright, but the same Chromium throttling applies: any window
 * the OS or the browser does not treat as visible gets background-timer throttling and suspended
 * rAF, and a driven page waiting on either reads as "the app did not react". This pins that
 * `launchedChromium` passes the anti-throttling switches through. Plumbing only; the behavioral
 * half needs a real browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchCalls: unknown[] = [];

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn((opts: unknown) => {
      launchCalls.push(opts);
      return Promise.resolve({
        isConnected: () => true,
        newContext: () => Promise.reject(new Error('not reached in this test')),
        close: () => Promise.resolve(),
        on: () => {},
      });
    }),
  },
}));

import { launchedChromium } from './real-input.js';

describe('launchedChromium', () => {
  beforeEach(() => {
    launchCalls.length = 0;
  });

  it('passes the anti-throttling args to chromium.launch alongside headless', async () => {
    const browser = await launchedChromium(true);
    expect(browser.isConnected()).toBe(true);
    expect(launchCalls).toHaveLength(1);
    const opts = launchCalls[0] as { headless?: boolean; args?: readonly string[] };
    expect(opts.headless).toBe(true);
    expect(opts.args).toContain('--disable-background-timer-throttling');
    expect(opts.args).toContain('--disable-backgrounding-occluded-windows');
    expect(opts.args).toContain('--disable-renderer-backgrounding');
  });

  it('passes headless:false through with the same args', async () => {
    await launchedChromium(false);
    const opts = launchCalls[0] as { headless?: boolean };
    expect(opts.headless).toBe(false);
    const allOpts = opts as { args?: readonly string[] };
    expect(allOpts.args?.length).toBeGreaterThan(0);
  });
});
