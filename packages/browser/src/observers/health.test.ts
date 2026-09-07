import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType, HealthReason } from '@reticlehq/core';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('installHealth (jsdom)', () => {
  it('emits an initial PAGE_HEALTH baseline with hidden/focused booleans', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);

    const initial = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.INITIAL,
    );
    expect(initial?.[0]).toBe(EventType.PAGE_HEALTH);
    const data = initial?.[1] as { hidden: unknown; focused: unknown };
    expect(typeof data.hidden).toBe('boolean');
    expect(typeof data.focused).toBe('boolean');
    teardown();
  });

  it('reports on visibilitychange and stops after teardown', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    emit.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const vis = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.VISIBILITY,
    );
    expect(vis).toBeDefined();
    expect((vis?.[1] as { hidden: boolean }).hidden).toBe(true);

    teardown();
    emit.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports on window blur', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    emit.mockClear();

    window.dispatchEvent(new Event('blur'));
    const blur = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.BLUR,
    );
    expect(blur?.[0]).toBe(EventType.PAGE_HEALTH);
    teardown();
  });

  it('teardown removes focus and blur listeners from window', async () => {
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    teardown();
    emit.mockClear();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    expect(emit).not.toHaveBeenCalled();
  });
});

/**
 * The engine bucket rides the health heartbeat because that is where the user-agent already gets
 * read — a second observer to answer the same question would be a second thing to keep in sync.
 * Three coarse values only: the raw UA string is high-cardinality and semi-identifying, so it must
 * never be what leaves the page.
 */
describe('engine detection in the health report', () => {
  const withUserAgent = async (ua: string): Promise<string> => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    const initial = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.INITIAL,
    );
    teardown();
    return (initial?.[1] as { engine: string }).engine;
  };

  it('reports blink for Chrome — checked FIRST, because every Chromium UA also says "Safari"', async () => {
    expect(
      await withUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe('blink');
  });

  it('reports gecko for Firefox', async () => {
    expect(
      await withUserAgent('Mozilla/5.0 (Macintosh; rv:133.0) Gecko/20100101 Firefox/133.0'),
    ).toBe('gecko');
  });

  it('reports webkit for real Safari', async () => {
    expect(
      await withUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe('webkit');
  });

  it('never leaks the raw user-agent string itself', async () => {
    const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
    expect(await withUserAgent(ua)).not.toContain('Mozilla');
  });
});

/**
 * The BRAND is the axis `engine` cannot answer: Chrome, Edge, Brave and every other Chromium fork
 * are all `blink`, and `attached` — the most common mode — means Reticle never launched the browser
 * and so has no other way to know which one it is. `navigator.userAgentData.brands` is the only
 * reliable source, and it exists nowhere outside Chromium, so the UA fallback has to hold up alone.
 */
describe('brand detection in the health report', () => {
  const CHROME_UA =
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const brandFor = async (
    ua: string,
    brands?: readonly { brand: string; version: string }[],
  ): Promise<string> => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    if (brands !== undefined) {
      Object.defineProperty(navigator, 'userAgentData', { value: { brands }, configurable: true });
    }
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    const teardown = installHealth(emit);
    const initial = emit.mock.calls.find(
      (c) => (c[1] as { reason?: string }).reason === HealthReason.INITIAL,
    );
    teardown();
    return (initial?.[1] as { brand: string }).brand;
  };

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'userAgentData');
  });

  it('skips the greased and generic entries to find the real brand', async () => {
    expect(
      await brandFor(CHROME_UA, [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
      ]),
    ).toBe('chrome');
  });

  it('prefers the fork over Chrome, which Edge and Brave both also claim to be', async () => {
    expect(
      await brandFor(CHROME_UA, [
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Microsoft Edge', version: '131' },
      ]),
    ).toBe('edge');
  });

  it('buckets an unrecognised brand as other rather than forwarding its name', async () => {
    expect(await brandFor(CHROME_UA, [{ brand: 'Wobble Browser', version: '3' }])).toBe('other');
  });

  it('reports chromium-with-no-real-brand as other, not as Chrome', async () => {
    expect(
      await brandFor(CHROME_UA, [
        { brand: 'Not)A;Brand', version: '99' },
        { brand: 'Chromium', version: '131' },
      ]),
    ).toBe('other');
  });

  it('falls back to the user agent on Firefox, which has no userAgentData', async () => {
    expect(await brandFor('Mozilla/5.0 (Macintosh; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe(
      'firefox',
    );
  });

  it('falls back to the user agent on Safari, which has no userAgentData', async () => {
    expect(
      await brandFor(
        'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe('safari');
  });

  it('reads Edge and Opera out of the UA when userAgentData is absent', async () => {
    expect(await brandFor(`${CHROME_UA} Edg/131.0.0.0`)).toBe('edge');
    expect(await brandFor(`${CHROME_UA} OPR/117.0.0.0`)).toBe('opera');
  });

  it('never throws when userAgentData is a hostile shape', async () => {
    expect(await brandFor(CHROME_UA, undefined)).toBe('chrome');
    Object.defineProperty(navigator, 'userAgentData', {
      value: { brands: 'nope' },
      configurable: true,
    });
    const { installHealth } = await import('./health.js');
    const emit = vi.fn();
    expect(() => installHealth(emit)()).not.toThrow();
  });

  it('never leaks a raw brand string', async () => {
    expect(await brandFor(CHROME_UA, [{ brand: 'Totally Unique Build 12345', version: '1' }])).toBe(
      'other',
    );
  });
});
