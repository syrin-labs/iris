import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installConsole } from './console.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

describe('installConsole', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits CONSOLE_ERROR and still forwards to the original console', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('boom', 42);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.CONSOLE_ERROR);
    expect(events[0]?.data['message']).toBe('boom 42');
  });

  it('captures the stack of an Error argument to console.error', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('failed:', new Error('kaboom'));

    expect(events[0]?.type).toBe(EventType.CONSOLE_ERROR);
    expect(typeof events[0]?.data['stack']).toBe('string');
    expect(events[0]?.data['stack']).toContain('kaboom');
  });

  it('does not attach a stack when console.error has no Error argument', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    console.error('just a string');

    expect(events[0]?.data['stack']).toBeUndefined();
  });

  it('captures console.info and console.debug lean (no stack), excluded from summaries downstream', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    // Reach the methods via globalThis so this test never trips the no-console lint rule.
    const c = globalThis.console;
    c.info('info line', 1);
    c.debug('debug line');

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe(EventType.CONSOLE_INFO);
    expect(events[0]?.data['message']).toBe('info line 1');
    expect(events[0]?.data['stack']).toBeUndefined();
    expect(events[1]?.type).toBe(EventType.CONSOLE_DEBUG);
    expect(events[1]?.data['message']).toBe('debug line');
  });

  it('restores the original console methods (identity) on teardown', () => {
    const beforeLog = console.log;
    const beforeWarn = console.warn;
    const beforeError = console.error;
    const t = installConsole(collect().emit);
    expect(console.error).not.toBe(beforeError);
    t();
    expect(console.log).toBe(beforeLog);
    expect(console.warn).toBe(beforeWarn);
    expect(console.error).toBe(beforeError);
  });
});

/**
 * #666: `reticle_assert({ kind: "console", level: "error", absent: true })` returned a confident
 * pass on pages visibly full of errors, because two whole classes of failure never reached this
 * channel. A negative check where a dead channel and a clean page read alike is a false green in the
 * one place the product's claim rests.
 */
describe('failures that are not console calls', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('reports a CSP violation, which the browser never routes through console', () => {
    // DevTools prints it, so a human sees dozens of them while this channel reported nothing.
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const violation = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    violation['violatedDirective'] = 'font-src';
    violation['blockedURI'] = 'https://fonts.gstatic.com/s/inter.woff2';
    window.dispatchEvent(violation);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.CONSOLE_ERROR);
    expect(events[0]?.data['message']).toContain('font-src');
    expect(events[0]?.data['message']).toContain('fonts.gstatic.com');
    expect(events[0]?.data['kind']).toBe('securitypolicyviolation');
  });

  it('names inline content when the violation has no blocked URI', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const violation = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    violation['violatedDirective'] = 'script-src';
    violation['blockedURI'] = '';
    window.dispatchEvent(violation);

    expect(events[0]?.data['message']).toContain('inline content');
  });

  it('sees a resource that failed to load, whose error does not bubble', () => {
    // The reason the listener needs `capture: true`: an <img>/<script>/<link> failure fires ON THE
    // ELEMENT and never travels up to window, so a bubble-phase listener cannot observe it at all.
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const img = document.createElement('img');
    img.src = 'https://example.test/missing.png';
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    img.remove();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.ERROR_UNCAUGHT);
    expect(events[0]?.data['kind']).toBe('resource');
    expect(events[0]?.data['message']).toContain('img');
    expect(events[0]?.data['message']).toContain('missing.png');
  });

  it('reads a stylesheet failure off href rather than src', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.test/theme.css';
    document.head.appendChild(link);
    link.dispatchEvent(new Event('error'));
    link.remove();

    expect(events[0]?.data['message']).toContain('theme.css');
    expect(events[0]?.data['source']).toContain('theme.css');
  });

  it('still reports an uncaught exception as one, not as a resource', () => {
    // The regression this could most easily cause: an ErrorEvent on window has a real message and
    // must not be rewritten into "failed to load window".
    const { emit, events } = collect();
    teardown = installConsole(emit);

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'kaboom',
        filename: 'app.js',
        lineno: 12,
        error: new Error('kaboom'),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.data['message']).toBe('kaboom');
    expect(events[0]?.data['source']).toBe('app.js');
    expect(events[0]?.data['kind']).toBeUndefined();
  });

  it('ignores an element error with no URL to name', () => {
    const { emit, events } = collect();
    teardown = installConsole(emit);

    const div = document.createElement('div');
    document.body.appendChild(div);
    div.dispatchEvent(new Event('error'));
    div.remove();

    // Neither a resource (no src/href) nor a real ErrorEvent — reported as the empty-message
    // uncaught error it structurally is, rather than invented into something it is not.
    expect(events[0]?.data['kind']).toBeUndefined();
  });

  it('removes every listener it added on teardown', () => {
    const { emit, events } = collect();
    installConsole(emit)();

    const violation = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    violation['violatedDirective'] = 'font-src';
    violation['blockedURI'] = 'https://fonts.gstatic.com/x.woff2';
    window.dispatchEvent(violation);

    const img = document.createElement('img');
    img.src = 'https://example.test/gone.png';
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    img.remove();

    expect(events).toEqual([]);
  });
});
