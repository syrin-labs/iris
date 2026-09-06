'use strict';
/**
 * Reticle's Electron preload shim. Add ONE line at the top of your preload, before you expose
 * anything:
 *
 *     require('@reticlehq/electron/preload');
 *
 * ...and every `ipcRenderer.invoke`, `sendSync` and `send` your app makes becomes a Reticle-visible
 * request (`ipc://<channel>`), so net assertions and settle-waiting cover the main-process hop.
 * A one-way `send` is recorded as DISPATCHED with no outcome, because that is all the renderer knows.
 *
 * Why a preload shim and not renderer-side patching, like every other Reticle observer:
 * `contextBridge.exposeInMainWorld` hands the renderer a DEEPLY FROZEN object, installed on `window`
 * as non-writable AND non-configurable. Neither assignment nor defineProperty can replace a method on
 * it — verified, not assumed. The renderer physically cannot instrument an app's IPC surface. The
 * preload is the last point where the functions are still ordinary and writable.
 *
 * This file is hand-written CommonJS on purpose: a sandboxed Electron preload is CJS-only and cannot
 * load the ESM SDK build.
 *
 * Dev-only, like the rest of Reticle. Gate the require behind your dev check so it never ships.
 */
const { contextBridge, ipcRenderer } = require('electron');
// The ONE definition of these strings, generated from @reticlehq/core's TypeScript source so a CJS
// preload and the ESM renderer cannot drift apart. Previously hand-copied into six files.
const {
  RETICLE_IPC_GLOBAL,
  RETICLE_CAPTURE_CHANNEL,
  RETICLE_FULL_PAGE_UNSUPPORTED,
} = require('@reticlehq/core/desktop-contract');

/**
 * Renderer-side subscribers, keyed by a token.
 *
 * A Map rather than one slot, and a token rather than the callback itself, for two reasons. A single
 * slot meant a second `connect()` in the same renderer silently STOLE the first one's subscription —
 * and "unsubscribing" was really "overwrite with a no-op", so an SDK teardown left the app in a
 * different state than it found it. Tokens rather than function identity because a callback crosses
 * `contextBridge` as a proxy, so the reference the preload holds is not the one the renderer passes
 * back and `delete(callback)` would never match.
 *
 * Empty until a renderer subscribes. What happens to records made before that is `backlog`, below.
 */
const sinks = new Map();
let sinkToken = 0;
let seq = 0;

/**
 * IPC that happened before the SDK was watching, held for the first subscriber.
 *
 * This used to be dropped, on the reasoning that the SDK only wants activity from the moment it is
 * watching. That reasoning is a web reflex and it is wrong here. A desktop app loads its data over
 * IPC on mount, and `connect()` is injected and does asynchronous work, so the app's FIRST calls —
 * the ones that populate the entire screen — routinely land before any sink exists. Dropping them
 * does not produce a gap a reader can see: it produces a network view that is empty and looks clean,
 * which is the failure this project treats as the worst kind. An agent reads it as "the app made no
 * backend calls" and reports so.
 *
 * Bounded, because an app running for hours with no SDK attached must not grow a queue, and replayed
 * to the FIRST subscriber only: a second `connect()` in the same renderer is not entitled to history
 * it was not present for.
 */
const backlog = [];
const BACKLOG_MAX = 200;
let backlogDelivered = false;

function report(record) {
  if (sinks.size === 0) {
    if (!backlogDelivered && backlog.length < BACKLOG_MAX) backlog.push(record);
    return;
  }
  for (const sink of sinks.values()) {
    try {
      sink(record);
    } catch {
      /* a renderer sink is best-effort; it must never break the app's IPC call */
    }
  }
}

/**
 * Longest payload reported per IPC call, matching the HTTP body cap.
 *
 * A desktop app's ENTIRE API surface is IPC. The web side has recorded request/response bodies for a
 * long time — which is what lets Reticle catch a batch whose 200 hides per-item failures, or a refund
 * posting a major-unit number into a minor-unit field. On Electron none of that could ever fire,
 * because this shim reported only channel, ok and duration and dropped the payloads it was already
 * holding. Every payload-based check was silently web-only on the platform this release is about.
 */
const IPC_BODY_MAX = 8192;

/**
 * Serialize an IPC payload, or report why it could not be.
 *
 * Size is computed even when the body is not forwarded, because "a write returned ok and its payload
 * went unread" is a caveat the verdict layer needs and it cannot infer it from an absent field.
 */
function payload(value) {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return undefined;
    return text.length > IPC_BODY_MAX
      ? { text: text.slice(0, IPC_BODY_MAX), size: text.length, truncated: true }
      : { text, size: text.length };
  } catch {
    // Circular, or carrying something structured-cloneable but not JSON-able. Not an error — the
    // call is still reported, just without a readable payload.
    return undefined;
  }
}

/** Wrap one invoke-style function so each call reports a start and an end. */
function observe(original, channelFromArg, name) {
  return function reticleObservedIpc(...args) {
    const id = `i${String(++seq)}`;
    const channel = channelFromArg && typeof args[0] === 'string' ? args[0] : name;
    const startedAt = Date.now();
    report({ phase: 'start', id, channel });
    // The arguments after the channel name ARE the request payload.
    const request = payload(channelFromArg ? args.slice(1) : args);
    const finish = (ok, error, value) => {
      const response = payload(value);
      report({
        phase: 'end',
        id,
        channel,
        ok,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
        ...(request === undefined ? {} : { requestBody: request.text, requestSize: request.size }),
        ...(response === undefined
          ? {}
          : {
              responseBody: response.text,
              responseSize: response.size,
              ...(response.truncated === true ? { responseBodyTruncated: true } : {}),
            }),
      });
    };
    let result;
    try {
      result = original.apply(this, args);
    } catch (err) {
      finish(false, String(err && err.message ? err.message : err));
      throw err;
    }
    if (result === null || typeof result !== 'object' || typeof result.then !== 'function') {
      finish(true, undefined, result);
      return result;
    }
    return result.then(
      (value) => {
        finish(true, undefined, value);
        return value;
      },
      (err) => {
        finish(false, String(err && err.message ? err.message : err));
        throw err;
      },
    );
  };
}

/**
 * Wrap a ONE-WAY send. It has no verdict to wait for, so it is recorded as DISPATCHED and never as
 * succeeded: `ok` and `status` are omitted entirely rather than defaulted to true/200.
 *
 * That distinction is the whole point. `ipcRenderer.send` hands the message to the main process and
 * returns; whether the handler ran, threw, or does not exist is information the renderer never gets.
 * Recording it as a 200 would manufacture a verdict nobody produced — so `reticle_network { ok }`
 * matches it in NEITHER direction, and the record carries `oneWay: true` so a reader can see why
 * there is no outcome rather than assume one.
 *
 * Only a throw at the call site (a closed port, a serialization failure) is a real failure the
 * renderer can observe, and that one IS reported as `ok: false`.
 */
function observeOneWay(original, name) {
  return function reticleObservedOneWayIpc(...args) {
    const id = `i${String(++seq)}`;
    const channel = typeof args[0] === 'string' ? args[0] : name;
    try {
      const result = original.apply(this, args);
      report({ phase: 'end', id, channel, oneWay: true, durationMs: 0 });
      return result;
    } catch (err) {
      report({
        phase: 'end',
        id,
        channel,
        oneWay: true,
        ok: false,
        durationMs: 0,
        error: String(err && err.message ? err.message : err),
      });
      throw err;
    }
  };
}

// Patch the three entry points an app's IPC actually leaves through, before its own
// `exposeInMainWorld` captures the references.
//
// `invoke` alone is NOT the whole surface — that claim used to be in this comment and it was wrong.
// A `send` + `on('reply')` pair is a mainstream Electron pattern, and an app built that way had
// EVERY backend call invisible while `coverage` still read full. `sendSync` genuinely returns its
// result, so it is observed like an invoke; `send` cannot be, so it is recorded as one-way.
//
// `postMessage` (MessagePort transfer) is deliberately not wrapped: the ports outlive the call, so a
// single record could not describe it honestly. An app using it should say so in its own signals.
const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = observe(originalInvoke, true, 'invoke');
if (typeof ipcRenderer.sendSync === 'function') {
  ipcRenderer.sendSync = observe(ipcRenderer.sendSync.bind(ipcRenderer), true, 'sendSync');
}
if (typeof ipcRenderer.send === 'function') {
  ipcRenderer.send = observeOneWay(ipcRenderer.send.bind(ipcRenderer), 'send');
}

contextBridge.exposeInMainWorld(RETICLE_IPC_GLOBAL, {
  /** Start receiving records. Returns a token to hand back to `unsubscribe`. */
  subscribe(callback) {
    if (typeof callback !== 'function') return -1;
    sinkToken += 1;
    sinks.set(sinkToken, callback);
    // Whatever the app did before anyone was listening, in the order it did it. Delivered once: the
    // records carry their own ids and timestamps, so a duplicate would read as a second call.
    if (!backlogDelivered) {
      backlogDelivered = true;
      const pending = backlog.splice(0, backlog.length);
      for (const record of pending) {
        try {
          callback(record);
        } catch {
          /* a renderer sink is best-effort; a bad one must not lose the rest of the backlog */
        }
      }
    }
    return sinkToken;
  },
  /**
   * Stop receiving records. A real removal, so an SDK teardown leaves the app as it found it.
   *
   * The `ipcRenderer.invoke` patch itself is deliberately NOT reverted: it is a pass-through with no
   * observable effect once no sinks remain, and un-patching it mid-flight would strand any call that
   * had already started inside the wrapper.
   */
  unsubscribe(token) {
    sinks.delete(token);
  },
  /**
   * Screenshot this window. Resolves to a base64 PNG, or null when the app did not install the
   * main-process helper (`@reticlehq/electron/main`) — there is no handler to answer, and a
   * missing screenshot must read as missing, never as a blank image.
   *
   * Uses the ORIGINAL invoke: this is Reticle's own plumbing, and recording it as an app IPC call
   * would put `ipc://__reticle:capture` in the agent's own network evidence.
   */
  capture(fullPage) {
    return originalInvoke(RETICLE_CAPTURE_CHANNEL, { fullPage: fullPage === true }).catch(
      (error) => {
        // A missing handler must stay `null` ("this app installed no capture helper"). An explicit
        // refusal is different information and has to reach the tool, or `fullPage` would silently
        // come back as a viewport image the caller believes is the whole page.
        const message = String((error && error.message) || error);
        if (message.includes(RETICLE_FULL_PAGE_UNSUPPORTED)) {
          throw new Error(RETICLE_FULL_PAGE_UNSUPPORTED);
        }
        return null;
      },
    );
  },
});
