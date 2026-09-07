import {
  BrowserBrand,
  EventType,
  HealthReason,
  RETICLE_IPC_GLOBAL,
  SESSION_HEALTH,
} from '@reticlehq/core';
import { nativeSetInterval } from '../timers/native-timers.js';
import type { Emit, Teardown } from './types.js';

/**
 * Which shell this page runs in. Reported with health because it is what makes a timeout
 * diagnosable: an occluded WKWebView is SUSPENDED by macOS, so the session stays connected while
 * every command times out — and a URL cannot tell a Tauri dev server from a plain localhost app, so
 * the runtime has to come from the page itself.
 */
function detectRuntime(): 'electron' | 'tauri' | 'web' {
  const w = window as unknown as Record<string, unknown>;
  if (w['__TAURI_INTERNALS__'] !== undefined || w['__TAURI__'] !== undefined) return 'tauri';
  if (navigator.userAgent.includes('Electron') || w[RETICLE_IPC_GLOBAL] !== undefined)
    return 'electron';
  return 'web';
}

/**
 * The rendering engine, coarse on purpose. Three buckets — never the UA string itself, which is
 * high-cardinality and semi-identifying. Order matters: every Chromium UA also contains "Safari", and
 * Gecko is the only engine that reports a real `Gecko/` build token.
 */
function detectEngine(): 'blink' | 'gecko' | 'webkit' {
  const ua = navigator.userAgent;
  if (/Chrome|Chromium|Edg\//.test(ua)) return 'blink';
  if (/Gecko\/|Firefox/.test(ua)) return 'gecko';
  return 'webkit';
}

/**
 * Brand names as the Chromium family and the UA string spell them, mapped to our closed vocabulary.
 * Matched on the WHOLE lowercased name, never a substring: brand strings are attacker-influenced
 * free text, and a substring rule is how "Search Browser" becomes `arc`.
 */
const BRAND_BY_NAME: Readonly<Record<string, BrowserBrand>> = {
  'google chrome': BrowserBrand.CHROME,
  chrome: BrowserBrand.CHROME,
  'microsoft edge': BrowserBrand.EDGE,
  edge: BrowserBrand.EDGE,
  brave: BrowserBrand.BRAVE,
  opera: BrowserBrand.OPERA,
  arc: BrowserBrand.ARC,
  dia: BrowserBrand.DIA,
  firefox: BrowserBrand.FIREFOX,
  safari: BrowserBrand.SAFARI,
};

/** Chromium's own filler entries: the greased `Not_A Brand` (spelt differently every release) and the generic engine name. */
function isFiller(name: string): boolean {
  return 'chromium' === name || (name.includes('not') && name.includes('brand'));
}

/**
 * The brand, from `navigator.userAgentData.brands` where it exists and the UA string where it does
 * not (Firefox and Safari expose no userAgentData at all). Every fork claims `Google Chrome`
 * alongside its own entry, so a non-Chrome match always wins; a Chromium that names nothing but
 * filler is `other`, because calling it Chrome would be a guess.
 *
 * Never throws — a desktop webview may expose a `userAgentData` of any shape, and health reporting
 * must survive it.
 */
function detectBrand(): BrowserBrand {
  try {
    const nav = navigator as Navigator & { userAgentData?: { brands?: unknown } };
    const brands = nav.userAgentData?.brands;
    if (Array.isArray(brands)) {
      let chrome: BrowserBrand | undefined;
      for (const entry of brands as { brand?: unknown }[]) {
        const name = 'string' === typeof entry?.brand ? entry.brand.toLowerCase() : '';
        if ('' === name || isFiller(name)) continue;
        const known = BRAND_BY_NAME[name];
        if (known === undefined) continue;
        if (BrowserBrand.CHROME === known) chrome = known;
        else return known;
      }
      return chrome ?? BrowserBrand.OTHER;
    }
  } catch {
    /* a health report must never depend on an exotic userAgentData */
  }
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return BrowserBrand.EDGE;
  if (/OPR\/|Opera/.test(ua)) return BrowserBrand.OPERA;
  if (/Firefox/.test(ua)) return BrowserBrand.FIREFOX;
  if (/Chrome|Chromium/.test(ua)) return BrowserBrand.CHROME;
  if (/Safari/.test(ua)) return BrowserBrand.SAFARI;
  return BrowserBrand.OTHER;
}

function snapshotHealth(): {
  hidden: boolean;
  focused: boolean;
  runtime: string;
  engine: string;
  brand: BrowserBrand;
} {
  return {
    hidden: 'hidden' === document.visibilityState,
    focused: document.hasFocus(),
    runtime: detectRuntime(),
    engine: detectEngine(),
    brand: detectBrand(),
  };
}

/**
 * Report page visibility/focus immediately on change + a lightweight native heartbeat.
 * Lets the bridge know whether the tab is foregrounded so the agent never drives a throttled
 * tab blind. Uses a native (pre-bound) timer so a frozen app clock (reticle_clock) never stalls it.
 */
export function installHealth(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;

  const report = (reason: HealthReason): void => {
    emit(EventType.PAGE_HEALTH, { ...snapshotHealth(), reason });
  };

  document.addEventListener('visibilitychange', () => report(HealthReason.VISIBILITY), { signal });
  window.addEventListener('focus', () => report(HealthReason.FOCUS), { signal });
  window.addEventListener('blur', () => report(HealthReason.BLUR), { signal });

  report(HealthReason.INITIAL); // baseline so the server knows state before the first change
  const stopHeartbeat = nativeSetInterval(
    () => report(HealthReason.HEARTBEAT),
    SESSION_HEALTH.HEARTBEAT_MS,
  );

  return () => {
    stopHeartbeat();
    ac.abort();
  };
}
