import { EventType } from '@reticlehq/core';
import { getAccessibleName, getRole } from '../dom/a11y.js';
import type { Emit, Teardown } from './types.js';

/** A human-legible label for a focused element, or undefined for body/none. Pure; exported for testing. */
export function focusLabel(el: EventTarget | null): string | undefined {
  if (!(el instanceof Element) || el === document.body) return undefined;
  const role = getRole(el);
  const name = getAccessibleName(el);
  return name.length > 0 ? `${role} "${name}"` : role;
}

function toBody(el: EventTarget | null): boolean {
  return null === el || el === document.body;
}

/**
 * Track element focus movement. Focus dropping to <body> after an act — a modal that closed and stranded
 * focus, a button that vanished — is a real accessibility/UX regression no screenshot names. Emits
 * FOCUS_CHANGE {to, from, toBody}. Reversible.
 */
export function installFocus(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;
  let last: EventTarget | null = null;

  const onFocusIn = (event: FocusEvent): void => {
    const to = event.target;
    const from = last;
    last = to;
    emit(EventType.FOCUS_CHANGE, {
      ...(focusLabel(to) === undefined ? {} : { to: focusLabel(to) }),
      ...(focusLabel(from) === undefined ? {} : { from: focusLabel(from) }),
      toBody: toBody(to),
    });
  };

  const onFocusOut = (event: FocusEvent): void => {
    // Focus left with nothing gaining it → it dropped to the body (the regression case).
    if (event.relatedTarget !== null) return;
    const from = last;
    last = null;
    emit(EventType.FOCUS_CHANGE, {
      ...(focusLabel(from) === undefined ? {} : { from: focusLabel(from) }),
      toBody: true,
    });
  };

  document.addEventListener('focusin', onFocusIn, { signal });
  document.addEventListener('focusout', onFocusOut, { signal });
  return () => ac.abort();
}
