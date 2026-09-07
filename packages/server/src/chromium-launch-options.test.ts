import { describe, expect, it } from 'vitest';
import { CHROMIUM_ANTI_THROTTLING_ARGS, chromiumLaunchOptions } from './chromium-launch-options.js';

describe('chromiumLaunchOptions', () => {
  it('carries the anti-throttling switches next to the headless flag', () => {
    const opts = chromiumLaunchOptions(true);
    expect(opts.headless).toBe(true);
    for (const flag of CHROMIUM_ANTI_THROTTLING_ARGS) {
      expect(opts.args).toContain(flag);
    }
  });

  it('passes headless:false through untouched', () => {
    expect(chromiumLaunchOptions(false).headless).toBe(false);
  });

  it('hands out a fresh array each call, so a caller cannot mutate the constant', () => {
    const a = chromiumLaunchOptions(true);
    const b = chromiumLaunchOptions(true);
    expect(a.args).not.toBe(b.args);
    a.args.push('--sneaky');
    expect(b.args).not.toContain('--sneaky');
  });
});
