/**
 * Optional CDP/Playwright real-input mode.
 *
 * Synthetic `dispatchEvent` cannot drive native hover/pointer state (an onMouseEnter never
 * fires, hit-testing never runs). When a CDP endpoint is configured, this module connects a
 * Playwright `Browser` over CDP and drives REAL pointer/keyboard input against the element box
 * the SDK resolves (viewport CSS px from getBoundingClientRect).
 *
 * Node-only. Playwright is loaded via DYNAMIC `import('playwright')` so non-CDP users never
 * pay for it; the type-only import is elided by `tsc`, so the build stays green without it.
 */
import type { Browser, Page } from 'playwright';
import { chromiumLaunchOptions } from '../chromium-launch-options.js';
import { gotoOptions } from '../pool/playwright-launcher.js';
import { BrowserLaunchKind } from '@reticlehq/core';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { classifyConnectFailure } from '../telemetry/connect-failure.js';
import { ActionType, DriveErrorCode, DRIVE_PLAYWRIGHT_MISSING_MSG } from '@reticlehq/core';
import { installNetworkMocks, type MockRule } from './network-mock.js';
import { attachNetworkDetail, type NetworkDetail } from './network-detail.js';

/** Viewport CSS-px box as returned by the INSPECT command (getBoundingClientRect). */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Args forwarded from reticle_act (fill value, type text, drag drop-target box). */
export interface RealInputArgs {
  value?: string;
  text?: string;
  /** For drag: the resolved box of the drop-target ref (toRef). */
  toBox?: ElementBox;
  steps?: number;
}

interface RealInputResult {
  /** True if a native gesture was actually driven. */
  performed: boolean;
  /** Center used, for diagnostics/tests. */
  center: { cx: number; cy: number };
}

/** Options for a page screenshot — full-page scroll capture and/or a clip box. */
export interface ScreenshotOpts {
  fullPage?: boolean;
  /** Restrict the capture to one element/region (viewport CSS px). */
  clip?: ElementBox;
}

/** The capability surface reticle_act depends on. A FAKE implementing this is injected in tests. */
export interface RealInputProvider {
  /** Whether a Playwright Page currently matches this SDK session URL. */
  isAvailableFor(sessionUrl: string): Promise<boolean>;
  /** Drive a native gesture for `action` at the element `box`. */
  perform(
    sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult>;
  /**
   * Capture a PNG of the correlated page, or undefined if no page matches. Optional
   * so the visual layer stays opt-in — a provider that cannot screenshot simply omits it.
   */
  screenshot?(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined>;
  /**
   * Install (or replace, or with [] clear) network-mock rules on the correlated page — stub a 500,
   * force offline, delay a response — for deterministic error/edge-state testing. Returns true when
   * a page matched and the rules were applied, false when no driven page matches this session.
   * Optional: a provider with no owned browser simply omits it.
   */
  setMocks?(sessionUrl: string, rules: MockRule[]): Promise<boolean>;
  /**
   * Pin the correlated page's viewport to fixed pixel dimensions so a screenshot baseline is
   * reproducible across machines (the missing piece of CI-stable visual regression, alongside masks
   * and the frozen clock). Returns true when a page matched, false otherwise. Optional.
   */
  setViewport?(sessionUrl: string, size: { width: number; height: number }): Promise<boolean>;
}

/**
 * Optional lifecycle a provider that OWNS a browser implements (`reticle drive`). The
 * reticle_act routing still depends only on `RealInputProvider`; the server uses these to boot/tear-down.
 */
export interface OwnedRealInputProvider extends RealInputProvider {
  /** Launch + navigate the owned browser. Must reject (never hang) on failure. */
  navigate(): Promise<void>;
  /** Close the owned browser. Idempotent. */
  dispose(): Promise<void>;
}

/** Structured, code-tagged failure so callers branch on cause, not message text. */
export class DriveError extends Error {
  readonly code: DriveErrorCode;
  constructor(code: DriveErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'DriveError';
  }
}

/** Center of a viewport box in CSS px. Pure — unit-tested directly. */
export function boxCenter(box: ElementBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/**
 * Which actions are driven by native pointer input. fill/type stay synthetic unless a
 * provider explicitly runs them.
 */
export function isPointerAction(action: ActionType): boolean {
  return (
    action === ActionType.HOVER ||
    action === ActionType.CLICK ||
    action === ActionType.DBLCLICK ||
    action === ActionType.DRAG
  );
}

/** Settle delay after a native gesture so the reaction can begin to flush (named, not free). */
const REAL_INPUT_SETTLE_MS = 16;
/** Default number of interpolation steps for a native drag. */
const DEFAULT_DRAG_STEPS = 8;

type SleepFn = (ms: number) => Promise<void>;
type ConnectFn = (url: string) => Promise<Browser>;

/**
 * Shared gesture executor: drive a native gesture on an already-resolved Page. Used by both the
 * CDP-attached and the launched (drive) providers so the pointer logic lives in one place.
 */
export async function performGesture(
  page: Page,
  action: ActionType,
  box: ElementBox,
  args: RealInputArgs,
  sleep: SleepFn,
): Promise<RealInputResult> {
  const center = boxCenter(box);
  const { cx, cy } = center;

  if (action === ActionType.HOVER) {
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + 1, cy);
    await page.mouse.move(cx, cy);
    await sleep(REAL_INPUT_SETTLE_MS);
    return { performed: true, center };
  }
  if (action === ActionType.CLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);
    return { performed: true, center };
  }
  if (action === ActionType.DBLCLICK) {
    await page.mouse.move(cx, cy);
    await page.mouse.dblclick(cx, cy);
    return { performed: true, center };
  }
  if (action === ActionType.DRAG) {
    if (args.toBox === undefined) return { performed: false, center };
    const dst = boxCenter(args.toBox);
    const steps = args.steps ?? DEFAULT_DRAG_STEPS;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= steps; i += 1) {
      const px = cx + ((dst.cx - cx) * i) / steps;
      const py = cy + ((dst.cy - cy) * i) / steps;
      await page.mouse.move(px, py, { steps: 1 });
    }
    await page.mouse.up();
    return { performed: true, center };
  }
  if (action === ActionType.FILL || action === ActionType.TYPE) {
    await page.mouse.click(cx, cy);
    await page.keyboard.type(args.value ?? args.text ?? '');
    return { performed: true, center };
  }
  return { performed: false, center };
}

/**
 * Reticle paints its own dev overlay (presenter HUD + border glow) into the page. That chrome is
 * time-varying — the activity log and border state change with every command — so capturing it
 * makes a fresh screenshot of an unchanged page differ from its baseline. Hide it during capture
 * (Playwright applies this stylesheet only for the shot, then reverts) so visual baselines reflect
 * the app, not Reticle. Disabling animations settles any remaining transitions for determinism.
 */
const HIDE_RETICLE_CHROME_CSS = '[data-reticle-overlay]{display:none !important}';
const SCREENSHOT_DETERMINISM = { style: HIDE_RETICLE_CHROME_CSS, animations: 'disabled' } as const;

/**
 * Capture a PNG from a Playwright page. Shared by the CDP + launched providers so the
 * screenshot path lives in one place (mirrors performGesture). Returns the raw PNG bytes.
 */
export async function capturePage(page: Page, opts: ScreenshotOpts): Promise<Uint8Array> {
  const buf = await page.screenshot(
    opts.clip !== undefined
      ? { ...SCREENSHOT_DETERMINISM, clip: opts.clip }
      : true === opts.fullPage
        ? { ...SCREENSHOT_DETERMINISM, fullPage: true }
        : { ...SCREENSHOT_DETERMINISM },
  );
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface CdpProviderOptions {
  cdpUrl: string;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected connector so unit tests can stub Playwright without import. */
  connect?: ConnectFn;
  /**
   * Sink for CDP-authoritative network detail. Optional, so the capture stays opt-in.
   *
   * This used to exist only on the LAUNCHED provider, which gated wire-level network visibility on
   * whether Reticle happened to open the browser. That is the wrong axis: owning the browser says
   * nothing about being able to see its network, and both providers speak CDP. The authoritative
   * request body is the one thing an in-page fetch wrapper structurally cannot get.
   */
  onNetworkDetail?: (detail: NetworkDetail) => void;
}

const nodeSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const cdpConnect: ConnectFn = async (url) => {
  const { chromium } = await import('playwright');
  // Attaching to someone's already-running browser is the fragile path — a stale CDP url, a browser
  // that was closed — so its FAILURE rate is the number worth watching. Settled with the outcome
  // rather than counted up front, which is what the first version got wrong: it incremented before
  // the await, so it silently reported attempts while the other paths reported successes.
  const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.ATTACHED);
  try {
    const browser = await chromium.connectOverCDP(url);
    settle();
    return browser;
  } catch (error) {
    settle(classifyConnectFailure(error));
    throw error;
  }
};

/** CDP-backed real-input provider. Lazily connects on first availability check / perform. */
export class CdpRealInputProvider implements RealInputProvider {
  readonly #cdpUrl: string;
  readonly #sleep: SleepFn;
  readonly #connect: ConnectFn;
  readonly #onNetworkDetail: ((detail: NetworkDetail) => void) | undefined;
  /** Pages already listening. #pageFor resolves on EVERY call, so without this each action would add
   *  another listener and every response would be emitted once per action taken so far. */
  readonly #listening = new WeakSet<object>();
  #browser: Browser | undefined;

  constructor(options: CdpProviderOptions) {
    this.#cdpUrl = options.cdpUrl;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#connect = options.connect ?? cdpConnect;
    this.#onNetworkDetail = options.onNetworkDetail;
  }

  /** Attach the response listener the first time we see a page; a no-op afterwards. */
  #listen(page: Page): void {
    const sink = this.#onNetworkDetail;
    if (sink === undefined || this.#listening.has(page)) return;
    this.#listening.add(page);
    attachNetworkDetail(page, sink);
  }

  async #ensureBrowser(): Promise<Browser | undefined> {
    if (this.#browser !== undefined) {
      // A cached browser can be DEAD: CDP dropped (the page was closed, the debugged Chrome exited,
      // the network blipped). The old code cached it forever, so every later call handed back a
      // corpse and the whole drive path went silently unavailable until the daemon restarted.
      // Playwright's Browser exposes isConnected(); a test fake may not, so only an EXPLICIT false
      // drops the cache — a fake without the method is assumed live.
      const alive = this.#browser.isConnected?.() ?? true;
      if (alive) return this.#browser;
      this.#browser = undefined; // fall through and reconnect
    }
    try {
      this.#browser = await this.#connect(this.#cdpUrl);
      return this.#browser;
    } catch {
      this.#browser = undefined; // a failed reconnect must not leave a stale handle behind
      return undefined;
    }
  }

  async #pageFor(sessionUrl: string): Promise<Page | undefined> {
    const browser = await this.#ensureBrowser();
    if (browser === undefined) return undefined;
    const page = selectPage(
      browser.contexts().flatMap((c) => c.pages()),
      sessionUrl,
    );
    if (page !== undefined) this.#listen(page);
    return page;
  }

  async isAvailableFor(sessionUrl: string): Promise<boolean> {
    try {
      return (await this.#pageFor(sessionUrl)) !== undefined;
    } catch {
      return false;
    }
  }

  async perform(
    sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return { performed: false, center: boxCenter(box) };
    return performGesture(page, action, box, args, this.#sleep);
  }

  /** PNG of the correlated page, or undefined if none matches. */
  async screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return undefined;
    return capturePage(page, opts);
  }

  /** Apply network-mock rules to the correlated page; false when no driven page matches. */
  async setMocks(sessionUrl: string, rules: MockRule[]): Promise<boolean> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return false;
    await installNetworkMocks(page, rules);
    return true;
  }

  /** Pin the correlated page's viewport to fixed dimensions; false when no driven page matches. */
  async setViewport(sessionUrl: string, size: { width: number; height: number }): Promise<boolean> {
    const page = await this.#pageFor(sessionUrl);
    if (page === undefined) return false;
    await page.setViewportSize({ width: size.width, height: size.height });
    return true;
  }

  /** Best-effort cleanup; idempotent. */
  async dispose(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close();
  }
}

/** Injected launcher so unit tests stub Playwright without import. */
export type LaunchFn = (headless: boolean) => Promise<Browser>;

/**
 * Force a driven page's already-loaded SDK to connect to our loopback bridge with a pairing token,
 * overriding the app's own (often localhost-only) reticle.connect — so a hosted preview verifies with
 * no app redeploy. connect is a no-op once connected, so re-invoking it is safe.
 */
export interface InjectConnectOptions {
  token: string;
  url: string;
}

export interface LaunchedProviderOptions {
  driveUrl: string;
  headless: boolean;
  /** Injected so the settle delay is deterministic in tests; defaults to a real Node timer. */
  sleep?: SleepFn;
  /** Injected launcher so unit tests can stub Playwright; defaults to dynamic import('playwright'). */
  launch?: LaunchFn;
  /** When set, re-invoke the page's reticle.connect with these after load (drive-a-hosted-preview). */
  injectConnect?: InjectConnectOptions;
  /** Path to a Playwright storageState JSON (cookies/localStorage) — starts the page authenticated. */
  storageState?: string;
  /**
   * Sink for CDP-authoritative network detail. When set, every driven-page response is captured
   * as a NET_DETAIL and handed here — the daemon routes it onto the driven session's journal so the
   * inside-app view never loses fidelity to the outside-in view. Omitted → no network detail captured.
   */
  onNetworkDetail?: (detail: NetworkDetail) => void;
}

const INJECT_CONNECT_WAIT_MS = 8_000;

/** The only place the dynamic value import of Playwright lives for the launched (drive) path. */
export const launchedChromium: LaunchFn = async (headless) => {
  let mod: typeof import('playwright');
  try {
    mod = await import('playwright');
  } catch {
    throw new DriveError(DriveErrorCode.PLAYWRIGHT_MISSING, DRIVE_PLAYWRIGHT_MISSING_MSG);
  }
  const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.LAUNCHED);
  try {
    const browser = await mod.chromium.launch(chromiumLaunchOptions(headless));
    settle();
    return browser;
  } catch (e) {
    settle(classifyConnectFailure(e));
    throw new DriveError(DriveErrorCode.LAUNCH_FAILED, e instanceof Error ? e.message : String(e));
  }
};

/**
 * Launches and OWNS a Playwright Chromium, navigates it to `driveUrl`, then drives native
 * input on that page. Headless-capable so @reticlehq/test / CI can run hover/drag unattended.
 */
export class LaunchedRealInputProvider implements OwnedRealInputProvider {
  readonly #driveUrl: string;
  readonly #headless: boolean;
  readonly #sleep: SleepFn;
  readonly #launch: LaunchFn;
  readonly #injectConnect: InjectConnectOptions | undefined;
  readonly #storageState: string | undefined;
  readonly #onNetworkDetail: ((detail: NetworkDetail) => void) | undefined;
  #browser: Browser | undefined;
  #page: Page | undefined;

  constructor(options: LaunchedProviderOptions) {
    this.#driveUrl = options.driveUrl;
    this.#headless = options.headless;
    this.#sleep = options.sleep ?? nodeSleep;
    this.#launch = options.launch ?? launchedChromium;
    this.#injectConnect = options.injectConnect;
    this.#storageState = options.storageState;
    this.#onNetworkDetail = options.onNetworkDetail;
  }

  async navigate(): Promise<void> {
    this.#browser = await this.#launch(this.#headless);
    const page = await this.#browser.newPage(
      this.#storageState !== undefined ? { storageState: this.#storageState } : undefined,
    );
    this.#page = page;
    // Capture CDP-authoritative response detail into the driven session's journal (best-effort).
    if (this.#onNetworkDetail !== undefined) attachNetworkDetail(page, this.#onNetworkDetail);
    try {
      // Same navigation rule as the pool, and for the same measured reason: Playwright's default
      // waits for `load`, which an app with one never-finishing subresource never fires — 30s of
      // nothing and then a failure that blames the app. The SDK connect is a module script, so it
      // has already run by DOMContentLoaded. See gotoOptions.
      await page.goto(this.#driveUrl, gotoOptions(undefined));
    } catch (e) {
      throw new DriveError(
        DriveErrorCode.NAVIGATE_FAILED,
        e instanceof Error ? e.message : String(e),
      );
    }
    await this.#tryInjectConnect(page);
  }

  /**
   * Wait for the page's Reticle singleton to exist, then re-invoke connect with our token + loopback
   * URL so a hosted (non-localhost) preview pairs to our bridge without the app being reconfigured.
   * Best-effort: a page with no SDK simply never exposes the global, and we move on.
   */
  async #tryInjectConnect(page: Page): Promise<void> {
    const opts = this.#injectConnect;
    if (opts === undefined) return;
    try {
      await page.waitForFunction('!!globalThis.__reticleInstance', {
        timeout: INJECT_CONNECT_WAIT_MS,
      });
      const arg = JSON.stringify({ allowNonLocalhost: true, token: opts.token, url: opts.url });
      await page.evaluate(`globalThis.__reticleInstance.connect(${arg})`);
    } catch {
      // No SDK on the page (or it connected already) — the no-session guard in verify reports it.
    }
  }

  /**
   * The page we own, or undefined once it is gone.
   *
   * The handle is cached for the life of the provider and Playwright keeps answering `url()` after
   * the page has closed, so a closed window read as AVAILABLE and every method below threw
   * "Target page, context or browser has been closed" — the raw Playwright message, surfaced to the
   * agent as a tool error, on every call for the rest of the run. A dead page is the same fact as no
   * page, and every caller already handles that. Only an EXPLICIT `true` drops it, matching
   * `CdpRealInputProvider`'s `isConnected` check: a test fake without the method is assumed live.
   */
  #livePage(): Page | undefined {
    const page = this.#page;
    if (page === undefined) return undefined;
    if (true === page.isClosed?.()) {
      this.#page = undefined; // never ask a corpse twice
      return undefined;
    }
    return page;
  }

  isAvailableFor(sessionUrl: string): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return Promise.resolve(false);
    if (page.url() === sessionUrl) return Promise.resolve(true);
    return Promise.resolve(stripVolatile(page.url()) === stripVolatile(sessionUrl));
  }

  perform(
    _sessionUrl: string,
    action: ActionType,
    box: ElementBox,
    args: RealInputArgs,
  ): Promise<RealInputResult> {
    const page = this.#livePage();
    if (page === undefined) return Promise.resolve({ performed: false, center: boxCenter(box) });
    return performGesture(page, action, box, args, this.#sleep);
  }

  /** PNG of the owned page, or undefined before navigate / after dispose. */
  screenshot(_sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined> {
    const page = this.#livePage();
    if (page === undefined) return Promise.resolve(undefined);
    return capturePage(page, opts);
  }

  /**
   * Pin the owned page's viewport; false before navigate / after dispose.
   *
   * `CdpRealInputProvider` has had this since it shipped and THIS provider did not, so
   * `reticle_viewport` refused with `no-cdp-provider` under `reticle drive` — while recommending
   * `reticle drive` as the fix. Same for `setMocks` below. A driven browser was attached and taking
   * screenshots the whole time; only these two methods were missing.
   */
  async setViewport(
    _sessionUrl: string,
    size: { width: number; height: number },
  ): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return false;
    await page.setViewportSize({ width: size.width, height: size.height });
    return true;
  }

  /** Apply network-mock rules to the owned page; false before navigate / after dispose. */
  async setMocks(_sessionUrl: string, rules: MockRule[]): Promise<boolean> {
    const page = this.#livePage();
    if (page === undefined) return false;
    await installNetworkMocks(page, rules);
    return true;
  }

  /** Close the owned browser once. Idempotent and safe before navigate. */
  async dispose(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#page = undefined;
    if (browser !== undefined) await browser.close();
  }
}

/** Drop hash/query so a page whose URL drifted by fragment still correlates to the session. */
/**
 * Correlate a session URL to one driven page, or refuse.
 *
 * Exact match first, query string included — that is the only fully reliable signal. The stripped
 * fallback exists for a real case (an app pushState's to /overview, so the page's URL no longer
 * equals the session's) but it is only sound when UNAMBIGUOUS.
 *
 * Returning the first loose match was a false-green generator: the benchmark fixture selects a bug
 * purely by query string, so two pages differing only there stripped to the same key, and a visual
 * diff happily compared the wrong page to itself and reported "0.00% changed, matched" for pixels
 * that demonstrably differed. Ambiguity now yields undefined, which callers already surface as
 * "no driven page" rather than as a passing comparison.
 */
export function selectPage<T extends { url(): string }>(
  pages: readonly T[],
  sessionUrl: string,
): T | undefined {
  const exact = pages.find((p) => p.url() === sessionUrl);
  if (exact !== undefined) return exact;
  const target = stripVolatile(sessionUrl);
  const loose = pages.filter((p) => stripVolatile(p.url()) === target);
  return 1 === loose.length ? loose[0] : undefined;
}

function stripVolatile(url: string): string {
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const query = base.indexOf('?');
  return query >= 0 ? base.slice(0, query) : base;
}
