/**
 * The page opening ANOTHER browsing context must be visible to the contradiction layer, or an OAuth
 * popup flow reads as a lost write in the original tab (#508). This pins the wrap: the call goes
 * through unchanged (arguments, return value), the event carries the requested href, and teardown
 * puts the previous implementation back.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installContextOpen } from './context-open.js';
import type { Emit, Teardown } from './types.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

const capture = (): { events: Captured[]; emit: Emit } => {
  const events: Captured[] = [];
  const emit = ((type: EventType, data: Record<string, unknown>): void => {
    events.push({ type, data });
  }) as Emit;
  return { events, emit };
};

describe('installContextOpen', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits context.opened with the requested href and passes the call through', () => {
    const { events, emit } = capture();
    const sentinel = {} as Window;
    window.open = () => sentinel;

    teardown = installContextOpen(emit);
    const returned = window.open('https://accounts.example.test/auth', '_blank');
    expect(returned).toBe(sentinel);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.CONTEXT_OPENED);
    expect(events[0]?.data['href']).toBe('https://accounts.example.test/auth');
  });

  it('the blank-tab form emits without an href', () => {
    const { events, emit } = capture();
    window.open = () => null;
    teardown = installContextOpen(emit);
    window.open();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.CONTEXT_OPENED);
    expect(events[0]?.data['href']).toBeUndefined();
  });

  it('teardown restores the previous implementation', () => {
    const { events, emit } = capture();
    const sentinel = {} as Window;
    window.open = () => sentinel;

    teardown = installContextOpen(emit);
    teardown();
    teardown = undefined;

    // The pre-install stub answers again, so the wrap is gone — and nothing was emitted through it.
    expect(window.open()).toBe(sentinel);
    expect(events).toHaveLength(0);
  });
});
