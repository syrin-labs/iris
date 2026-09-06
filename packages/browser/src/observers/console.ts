import { EventType, TRANSPORT_LIMITS } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';
import { safeStringify } from '../security/serialization.js';
import { requireCapturedMethod } from '../util/captured-method.js';

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

const METHOD_EVENT: Record<ConsoleMethod, EventType> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
  // info/debug are captured for the raw console channel but excluded from summaries/deviation reports
  // (low signal — most apps chatter here). Lean: no stack, like log/warn.
  info: EventType.CONSOLE_INFO,
  debug: EventType.CONSOLE_DEBUG,
};

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if ('string' === typeof a) return a;
      if (a instanceof Error) return a.message;
      return safeStringify(a);
    })
    .join(' ');
}

/** Stacks can be long; cap so a deep async trace never blows the event budget. */
const MAX_STACK_LEN = TRANSPORT_LIMITS.MAX_STACK_LENGTH;

function capStack(stack: string | undefined): string | undefined {
  if (stack === undefined || 0 === stack.length) return undefined;
  return stack.length > MAX_STACK_LEN ? stack.slice(0, MAX_STACK_LEN) : stack;
}

/** The stack of the first Error argument, if any — the single biggest diagnosis upgrade, near-zero cost. */
function firstErrorStack(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error) return capStack(arg.stack);
  }
  return undefined;
}

/**
 * A resource that failed to load fires `error` ON THE ELEMENT, and it does not bubble.
 *
 * `addEventListener('error', ...)` without `capture` therefore never sees a broken `<img>`,
 * `<script>` or `<link>` — only uncaught exceptions, which reach `window` directly. On a page whose
 * font host is blocked, DevTools shows dozens of failures and this channel reported nothing
 * (#666). Capture phase is the only way a listener on `window` can observe an event that never
 * travels upward.
 */
const CAPTURE: AddEventListenerOptions = { capture: true };

/** The element kinds whose load failure is worth naming, and the attribute the URL lives on. */
function resourceTarget(target: EventTarget | null): { tag: string; url: string } | undefined {
  if (null === target || !('tagName' in target)) return undefined;
  const element = target as Element & { src?: unknown; href?: unknown };
  const tag = element.tagName.toLowerCase();
  const raw = 'string' === typeof element.src ? element.src : element.href;
  if ('string' !== typeof raw || 0 === raw.length) return undefined;
  return { tag, url: raw };
}

/** Patch console.{log,warn,error} and window error events. Reversible. */
export function installConsole(emit: Emit): Teardown {
  const methods: ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const patched = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of methods) {
    // Store the true original for teardown identity; call through a bound copy. Read as a stored
    // VALUE rather than a method reference — see capturedMethod for why that distinction is the
    // honest way to say "I am detaching this deliberately and putting it back".
    const original = requireCapturedMethod<(...args: unknown[]) => void>(console, method);
    originals.set(method, original);
    const callOriginal = original.bind(console);
    const wrapper = (...args: unknown[]): void => {
      // Only console.error carries a stack — the diagnosis case; log/warn stay lean.
      const stack = 'error' === method ? firstErrorStack(args) : undefined;
      emit(METHOD_EVENT[method], {
        message: stringifyArgs(args),
        ...(stack === undefined ? {} : { stack }),
      });
      callOriginal(...args);
    };
    patched.set(method, wrapper);
    console[method] = wrapper;
  }

  const onError = (event: ErrorEvent | Event): void => {
    // A RESOURCE failure is an `Event`, not an `ErrorEvent`: no message, no filename, and the thing
    // that failed is the target. Reporting it as an empty-message uncaught error would be worse
    // than not reporting it, so it is named from the element instead.
    const resource = resourceTarget(event.target);
    if (resource !== undefined && window !== event.target && document !== event.target) {
      emit(EventType.ERROR_UNCAUGHT, {
        message: `failed to load ${resource.tag}: ${resource.url}`,
        kind: 'resource',
        source: resource.url,
      });
      return;
    }
    const errorEvent = event as ErrorEvent;
    const stack = capStack(errorEvent.error instanceof Error ? errorEvent.error.stack : undefined);
    emit(EventType.ERROR_UNCAUGHT, {
      message: errorEvent.message,
      source: errorEvent.filename,
      line: errorEvent.lineno,
      ...(stack === undefined ? {} : { stack }),
    });
  };
  /**
   * A CSP violation is not a console call, and the browser never routes it through one.
   *
   * DevTools prints it, so a human reading the page sees dozens of them while
   * `reticle_assert({ kind: "console", level: "error", absent: true })` returned a confident pass.
   * That is a false green in the one place the product's claim rests, and the event exists
   * precisely so a page can observe what the browser refused.
   */
  const onViolation = (event: SecurityPolicyViolationEvent): void => {
    emit(EventType.CONSOLE_ERROR, {
      message:
        `Content Security Policy directive: ${event.violatedDirective} blocked ` +
        `${0 === event.blockedURI.length ? 'inline content' : event.blockedURI}`,
      kind: 'securitypolicyviolation',
      source: event.blockedURI,
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    const stack = capStack(reason instanceof Error ? reason.stack : undefined);
    emit(EventType.ERROR_UNCAUGHT, {
      message: reason instanceof Error ? reason.message : String(reason),
      kind: 'unhandledrejection',
      ...(stack === undefined ? {} : { stack }),
    });
  };
  // Capture phase, so a resource load failure — which never bubbles — is seen at all.
  window.addEventListener('error', onError, CAPTURE);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('securitypolicyviolation', onViolation);

  return () => {
    for (const [method, original] of originals) {
      // Restore only if console[method] still holds our wrapper — a logging SDK (Sentry, LogRocket)
      // that wrapped console AFTER connect() must keep its instrumentation on teardown.
      if (console[method] === patched.get(method)) console[method] = original as typeof console.log;
    }
    // The options must match the add, or the listener is not the one being removed.
    window.removeEventListener('error', onError, CAPTURE);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('securitypolicyviolation', onViolation);
  };
}
