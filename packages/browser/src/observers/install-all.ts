/**
 * Install every page observer, guarded.
 *
 * Extracted from `reticle.ts` because it is one job with one rule, and because that file is the SDK's
 * public surface — the more of this that lived there, the harder it was to see what `connect()`
 * actually does.
 *
 * THE RULE: one observer failing must never stop the others. This array used to be built bare, so a
 * single `install*` that threw took the whole `connect()` down with it — one bad patch on one exotic
 * page and the app got no instrumentation at all, silently, because the SDK\'s own catch blocks
 * ensured nobody ever found out. Each install is now wrapped: the healthy observers still run, the
 * failure is reported over the bridge, and the caller gets a teardown list of the same length.
 */
import { installDom } from './dom.js';
import { installStorage } from './storage.js';
import { installStoreState } from './state.js';
import { installFocus } from './focus.js';
import { installBlindSpots } from './blind-spots.js';
import { installDownload } from './download.js';
import { installContextOpen } from './context-open.js';
import { installNetwork } from './network.js';
import { installIpc, ipcNetOverrides, isReticleOwnIpc } from './ipc.js';
import { installPerf } from './perf.js';
import { installRoute } from './route.js';
import { installConsole } from './console.js';
import { installAnimation } from './animation.js';
import { installScroll } from './scroll.js';
import { installHealth } from './health.js';
import { reportSdkFailure, SdkSite } from './sdk-failure.js';
import type { Emit, Teardown } from './types.js';

interface InstallOptions {
  captureBodies: boolean;
}

/** Run one install, reporting rather than throwing if it cannot start. */
function guard(emit: Emit, site: SdkSite, install: () => Teardown): Teardown {
  try {
    return install();
  } catch (error) {
    reportSdkFailure(emit, site, error);
    return () => {}; // nothing was installed, so there is nothing to tear down
  }
}

export function installAllObservers(emit: Emit, options: InstallOptions): Teardown[] {
  return [
    // Composition happens HERE, not inside the network observer: the network observer knows
    // nothing about desktop IPC, and the IPC observer knows nothing about fetch plumbing.
    guard(emit, SdkSite.NETWORK_OBSERVER, () =>
      installNetwork(emit, {
        captureBodies: options.captureBodies,
        reinterpret: ipcNetOverrides,
        // The SDK's own Tauri screenshot is a fetch like any other — skip it, or the observer
        // reports its own captures as the app's writes.
        ignore: isReticleOwnIpc,
      }),
    ),
    // Desktop backends are reached over IPC, not HTTP — inert on a plain web page.
    guard(emit, SdkSite.IPC_OBSERVER, () =>
      installIpc(emit, { captureBodies: options.captureBodies }),
    ),
    guard(emit, SdkSite.ANIMATION_OBSERVER, () => installPerf(emit)),
    guard(emit, SdkSite.ROUTER_OBSERVER, () => installRoute(emit)),
    guard(emit, SdkSite.CONSOLE_OBSERVER, () => installConsole(emit)),
    guard(emit, SdkSite.ANIMATION_OBSERVER, () => installAnimation(emit)),
    guard(emit, SdkSite.DOM_OBSERVER, () => installScroll(emit)),
    guard(emit, SdkSite.DOM_OBSERVER, () => installDom(emit)),
    guard(emit, SdkSite.STORE_ADAPTER, () => installStorage(emit)), // storage WRITES → STORAGE_CHANGE diffs (pull remains the fallback)
    guard(emit, SdkSite.STORE_ADAPTER, () => installStoreState(emit)), // subscribed-store mutations → STATE_CHANGE path diffs
    guard(emit, SdkSite.DOM_OBSERVER, () => installFocus(emit)), // element focus movement → FOCUS_CHANGE (focus-to-body = a regression)
    // Files the app PRODUCES — never cross the network, so no outside-the-page tool can see them.
    guard(emit, SdkSite.NETWORK_OBSERVER, () =>
      installDownload(emit, { capturePreview: options.captureBodies }),
    ),
    guard(emit, SdkSite.DOM_OBSERVER, () => installBlindSpots(emit)), // cross-origin iframes the SDK can't see → BLIND_SPOT (coverage: partial)
    guard(emit, SdkSite.HEALTH_OBSERVER, () => installHealth(emit)), // page visibility/focus health + heartbeat
    guard(emit, SdkSite.DOM_OBSERVER, () => installContextOpen(emit)), // window.open → CONTEXT_OPENED (the consequence may live in another context)
  ];
}
