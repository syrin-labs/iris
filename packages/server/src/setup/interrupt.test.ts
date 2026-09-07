import { describe, expect, it } from 'vitest';
import { stopOnInterrupt, type SignalTarget } from './interrupt.js';

/**
 * `setup` starts a dev server the user did not start, detached and in its own process group, and
 * cleans it up in a `finally`. A `finally` does not run on SIGINT — the process is terminated — so
 * Ctrl-C left that server running forever, holding a port nobody could account for.
 *
 * It hid behind an earlier bug: init used to exit before the dev server was ever started, so the
 * check for an orphan found none and passed for the wrong reason. Letting the runtime phase run is
 * what exposed it.
 */
function fakeTarget(): SignalTarget & {
  handlers: Map<string, Array<() => void>>;
  exited: number[];
} {
  const handlers = new Map<string, Array<() => void>>();
  const exited: number[] = [];
  return {
    handlers,
    exited,
    on: (sig, fn) => {
      handlers.set(sig, [...(handlers.get(sig) ?? []), fn]);
    },
    off: (sig, fn) => {
      handlers.set(
        sig,
        (handlers.get(sig) ?? []).filter((h) => h !== fn),
      );
    },
    exit: (code) => {
      exited.push(code);
    },
  };
}

describe('an interrupted setup takes its dev server with it', () => {
  it('stops the server on SIGINT and leaves with the signal code', () => {
    const target = fakeTarget();
    let stopped = 0;
    stopOnInterrupt(() => {
      stopped += 1;
    }, target);

    target.handlers.get('SIGINT')?.forEach((h) => h());
    expect(stopped).toBe(1);
    // 128 + SIGINT(2): what a shell reports for a Ctrl-C, so a caller can tell it from a failure.
    expect(target.exited).toEqual([130]);
  });

  it('stops it on SIGTERM too — a kill is not gentler than a Ctrl-C', () => {
    const target = fakeTarget();
    let stopped = 0;
    stopOnInterrupt(() => {
      stopped += 1;
    }, target);
    target.handlers.get('SIGTERM')?.forEach((h) => h());
    expect(stopped).toBe(1);
    expect(target.exited).toEqual([143]);
  });

  // The handlers must not outlive the phase that needed them: `init` keeps running after setup, and
  // a stale handler would kill a server it no longer owns.
  it('unregisters when the phase finishes normally', () => {
    const target = fakeTarget();
    const dispose = stopOnInterrupt(() => undefined, target);
    dispose();
    expect(target.handlers.get('SIGINT')).toEqual([]);
    expect(target.handlers.get('SIGTERM')).toEqual([]);
  });

  // Two signals in a row must not run the teardown twice — stop() is not guaranteed idempotent, and
  // a double kill on a recycled pid is somebody else's process.
  it('stops once however many signals arrive', () => {
    const target = fakeTarget();
    let stopped = 0;
    stopOnInterrupt(() => {
      stopped += 1;
    }, target);
    target.handlers.get('SIGINT')?.forEach((h) => h());
    target.handlers.get('SIGINT')?.forEach((h) => h());
    expect(stopped).toBe(1);
  });
});
