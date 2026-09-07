/**
 * A port this machine will actually let us bind.
 *
 * Once daemons are per-project, "which port" stops being a constant and becomes a question. The
 * answer must not be "the next number up": probing 4401, 4402, 4403 races every other agent doing
 * the same arithmetic at the same moment, and the loser finds out at bind time, which is after it has
 * already told the caller which port to use.
 *
 * So the OS assigns it. Binding port 0 asks the kernel for a free one and hands back the number it
 * chose, and nothing else can be holding it at that instant. There is still a window between closing
 * the probe socket and the daemon binding for real — unavoidable without passing the listener itself
 * to the child — but it is microseconds wide and loses to a retry, where a guessed number loses every
 * time on a busy machine.
 *
 * The preferred port is tried first so the ordinary single-project install keeps landing on the
 * documented default, and every doc, log line and troubleshooting page that says 4400 stays true.
 */

import { createServer } from 'node:net';
import { LOOPBACK_HOST } from '@reticlehq/core';

/** Can we bind `port` on the loopback interface right now? */
export function portIsFree(port: number, host: string = LOOPBACK_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Ask the kernel for a free port. Rejects only if the machine cannot bind loopback at all. */
export function osAssignedPort(host: string = LOOPBACK_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (null === address || 'string' === typeof address) {
        probe.close(() => reject(new Error('could not read an OS-assigned port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * `preferred` when it is free, otherwise whatever the OS gives us.
 *
 * Injectable so the decision is unit-testable without binding anything: the interesting case is the
 * one where the preferred port is taken, and a test must be able to say so without racing a real
 * socket.
 */
export async function pickDaemonPortToBind(
  preferred: number,
  isFree: (port: number) => Promise<boolean> = portIsFree,
  assign: () => Promise<number> = osAssignedPort,
): Promise<number> {
  return (await isFree(preferred)) ? preferred : assign();
}
