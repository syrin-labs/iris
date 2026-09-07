import type { CommandResult } from '@reticlehq/core';

/**
 * The in-flight command table for one session: correlate a reply to its request, time out the ones
 * that never come back, and fail the rest when the socket drops.
 *
 * Extracted from Session because it is a self-contained mechanism with its own invariant — every
 * entry is either resolved, rejected, or timed out exactly once, and its timer is always cleared —
 * and because Session had grown past the file-size cap. Nothing here knows about health, events, or
 * the browser; it takes the timeout message as a callback so the diagnosis stays with the code that
 * can explain it.
 */

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The page was asked and did not answer inside the caller's budget.
 *
 * A distinct type because the two ways a command can fail mean opposite things, and a caller that
 * cannot tell them apart will do the wrong thing with one of them. A rejection from a replaced
 * transport says the question never reached the page and is worth asking again; a timeout says it
 * did reach the page, which did not answer in the time granted — and asking again spends a budget
 * that is already gone. Retrying a timeout as though it were a disconnect turned one read into
 * hundreds of commands on the wire against a page that was reconnecting in a loop.
 */
export class CommandTimeoutError extends Error {}

/**
 * The transport under this command was displaced by a newer connection claiming the same id.
 *
 * Typed, not a string to match on, because the two failures need OPPOSITE handling and the only
 * thing separating them used to be the wording of a message. A read can simply be re-asked on the
 * successor; a WRITE cannot — nobody can prove it did not land — so the honest answer is that the
 * outcome went unobserved, which is a verdict this engine already has a word for.
 */
export class SessionReplacedError extends Error {}

export class PendingCommands {
  readonly #pending = new Map<string, PendingCommand>();
  #seq = 0;

  /** Next correlation id. Monotonic per session, so a reply can never match an earlier command. */
  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}${String(this.#seq)}`;
  }

  /** Register a command and arm its timeout. `describeTimeout` runs only if the reply never lands. */
  track(id: string, timeoutMs: number, describeTimeout: () => string): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CommandTimeoutError(describeTimeout()));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  /** Resolve the command this reply belongs to. Unknown ids are ignored, never thrown on. */
  settle(result: CommandResult): void {
    const pending = this.#pending.get(result.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(result.id);
    pending.resolve(result);
  }

  /** Reject everything still in flight — used on disconnect, so no caller waits on a dead socket. */
  rejectAll(reason: string, replaced = false): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(replaced ? new SessionReplacedError(reason) : new Error(reason));
      this.#pending.delete(id);
    }
  }
}
