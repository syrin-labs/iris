/**
 * A scoped text predicate must actually narrow WHERE it looks.
 *
 * The shape tests pin that the schema accepts `scope` and that `parsePredicate` carries it, but
 * neither reaches the forwarding in `evaluatePredicate`: drop the field on its way into the element
 * query and both still pass. So this file asserts the only thing that fails when the forwarding is
 * dropped — the match itself changing. The session below honours `scope` the way the browser does,
 * with the same text present both inside and outside the container.
 */
import { describe, it, expect } from 'vitest';
import {
  asRef,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

const DIALOG = '[role=dialog]';

/** An element on the page, plus the container it sits in — the DOM fact `scope` selects on. */
interface Placed {
  readonly element: ElementDescriptor;
  readonly container?: string;
}

function button(ref: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: 'Delete', states: [], visible: true };
}

/** The same label twice: once inside the dialog, once in the page behind it. */
const IN_DIALOG: Placed = { element: button('r-dialog'), container: DIALOG };
const OUTSIDE: Placed = { element: button('r-page') };

/** Honours `scope` by filtering on the container, the way the browser-side locator does. */
class ScopedSession implements PredicateSession {
  seen: ElementQuery[] = [];
  constructor(private readonly placed: readonly Placed[]) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    const query = (args['query'] ?? {}) as ElementQuery;
    this.seen.push(query);
    const scope = query.scope;
    const matched = (
      undefined === scope ? [...this.placed] : this.placed.filter((p) => p.container === scope)
    ).map((p) => p.element);
    const result: MatchResult = {
      matched: matched.length > 0,
      count: matched.length,
      elements: matched,
    };
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

describe('text predicate: scope narrows the search', () => {
  it('reaches both copies when no scope is given', async () => {
    const session = new ScopedSession([IN_DIALOG, OUTSIDE]);
    const result = await evaluatePredicate(session, { kind: 'text', contains: 'Delete' });
    expect(result.pass).toBe(true);
    expect(session.seen[0]?.scope, 'no scope asked for, none forwarded').toBeUndefined();
  });

  it('forwards the scope into the element query', async () => {
    const session = new ScopedSession([IN_DIALOG, OUTSIDE]);
    await evaluatePredicate(session, { kind: 'text', contains: 'Delete', scope: DIALOG });
    expect(session.seen[0]?.scope, 'scope must reach the MATCH query').toBe(DIALOG);
  });

  it('still matches when the text is inside the scope', async () => {
    const session = new ScopedSession([IN_DIALOG, OUTSIDE]);
    const result = await evaluatePredicate(session, {
      kind: 'text',
      contains: 'Delete',
      scope: DIALOG,
    });
    expect(result.pass).toBe(true);
  });

  it('does NOT match text that only exists outside the scope', async () => {
    // The assertion the whole field exists for: unscoped this passes, scoped it must not.
    const session = new ScopedSession([OUTSIDE]);
    const unscoped = await evaluatePredicate(session, { kind: 'text', contains: 'Delete' });
    expect(unscoped.pass, 'the text is on the page, so an unscoped check passes').toBe(true);

    const scopedSession = new ScopedSession([OUTSIDE]);
    const scoped = await evaluatePredicate(scopedSession, {
      kind: 'text',
      contains: 'Delete',
      scope: DIALOG,
    });
    expect(scoped.pass, 'the text is not in the dialog, so a scoped check must fail').toBe(false);
  });

  it('an absent assertion inside a scope ignores the copy outside it', async () => {
    const session = new ScopedSession([OUTSIDE]);
    const result = await evaluatePredicate(session, {
      kind: 'text',
      contains: 'Delete',
      scope: DIALOG,
      absent: true,
    });
    expect(result.pass, 'nothing named Delete inside the dialog, so absent holds').toBe(true);
  });

  it("can assert the scope root's combined subtree text without turning every root into a match", async () => {
    const owner: ElementDescriptor = {
      ref: asRef('e12'),
      role: 'generic',
      name: '',
      text: 'Move to Reticle Repro Folder',
      states: [],
      visible: true,
    };
    class SplitTextSession extends ScopedSession {
      override command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
        if (name !== ReticleCommand.MATCH) return super.command(name, args);
        const query = (args['query'] ?? {}) as ElementQuery;
        this.seen.push(query);
        const elements =
          true === query.self && true === owner.text?.includes(query.text ?? '') ? [owner] : [];
        const result: MatchResult = {
          matched: 0 < elements.length,
          count: elements.length,
          elements,
          ...(0 === elements.length
            ? {
                hint: {
                  route: '/',
                  presentTestids: [],
                  presentRegions: [],
                  knownEmptyState: false,
                  splitText: owner,
                },
              }
            : {}),
        };
        return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
      }
    }

    const matching = await evaluatePredicate(new SplitTextSession([]), {
      kind: 'text',
      contains: 'Move to Reticle Repro Folder',
      scope: 'e12',
      self: true,
    });
    expect(matching.pass).toBe(true);

    const different = await evaluatePredicate(new SplitTextSession([]), {
      kind: 'text',
      contains: 'A different sentence',
      scope: 'e12',
      self: true,
    });
    expect(different.pass, 'self must still enforce the requested text').toBe(false);
  });
});
