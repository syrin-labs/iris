import { EventType } from '@reticlehq/core';
import { captureMethod } from '../patching/capture-method.js';
import type { Emit, Teardown } from './types.js';

/**
 * The page asked for ANOTHER browsing context — `window.open` — so the consequence of whatever was
 * just clicked may live where this document's SDK cannot follow. An OAuth sign-in is the archetype:
 * the POST succeeds, the popup carries the whole flow, and the original tab legitimately never
 * changes (#508). Without this event the contradiction layer reads that shape as response-ignored,
 * accusing the client of ignoring a response it handed to a window nobody can see.
 *
 * The wrap preserves the call exactly: same arguments, same return value, and a null/undefined
 * first argument (the "open a blank tab" form) still emits, since a blank tab can navigate anywhere.
 */
export function installContextOpen(emit: Emit): Teardown {
  const originalOpen = captureMethod(window, 'open');
  if (originalOpen === undefined) return () => {};

  const openPatch = function (
    this: Window,
    href?: string,
    target?: string,
    features?: string,
  ): Window | null {
    emit(EventType.CONTEXT_OPENED, { ...(href === undefined ? {} : { href }) });
    return originalOpen.call(this, href, target, features);
  };

  window.open = openPatch as typeof window.open;
  return () => {
    window.open = originalOpen;
  };
}
