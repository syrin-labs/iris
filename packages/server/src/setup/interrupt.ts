/**
 * Take the dev server with us when setup is interrupted.
 *
 * `setup` starts a dev server the user did not start — detached, in its own process group — and
 * stops it in a `finally`. A `finally` does not run on SIGINT: the process is terminated. So Ctrl-C
 * during setup left that server running forever, holding a port nobody could account for, and the
 * next run's port probe then found a stranger on it.
 *
 * It hid behind an earlier bug. `init` used to exit before the dev server was ever started whenever
 * instrumentation needed a manual step, so the orphan check found nothing and passed for the wrong
 * reason. Letting the runtime phase run is what exposed this.
 */

/** The parts of `process` this needs, so the behaviour is testable without signalling anything. */
export interface SignalTarget {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  exit(code: number): void;
}

/** 128 + the signal number, which is what a shell reports — so a caller can tell Ctrl-C from a failure. */
const EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Run `stop` if this process is interrupted, then leave with the signal's own code.
 *
 * Returns a disposer, and callers must use it: `init` keeps running after setup, and a handler left
 * behind would tear down a server it no longer owns.
 */
export function stopOnInterrupt(stop: () => void, target: SignalTarget): () => void {
  // Once only. `stop` is not idempotent — it kills a process GROUP — and on a recycled pid a second
  // kill is somebody else's process.
  let done = false;
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = (): void => {
      if (!done) {
        done = true;
        stop();
      }
      target.exit(EXIT_CODE[signal]);
    };
    target.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) target.off(signal, handler);
  };
}
