/**
 * BrowserPool — one headless browser, many cheap isolated contexts.
 *
 * The "10 agents test 10 flows" scenario does NOT mean 10 Chromiums (each ~hundreds of MB). It means
 * ONE launched browser and N `newContext` calls (each ~a few MB, fully isolated cookies/storage).
 * The pool owns that single browser, hands out per-flow leases, caps concurrency so a machine is
 * never overwhelmed (over-cap acquires queue FIFO), and transparently relaunches if the browser dies.
 *
 * The browser is injected via a `Launcher` so all lifecycle logic is testable without real Chromium;
 * the thin Playwright adapter that satisfies these interfaces lives separately.
 */

/** The minimal page surface the pool drives. Real Playwright `Page` satisfies this. */
import { unreachableUrlIn } from '@reticlehq/core';

export interface PooledPage {
  goto(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
  /** Fires when THIS page's renderer crashes — lets the pool reclaim just this lease, not the fleet. */
  onCrash(handler: () => void): void;
  /**
   * Fires for each console message the page logs. OPTIONAL: a fake that does not implement it makes
   * the pool record nothing, which is the correct degradation — an absent dial address must read as
   * "the page said nothing", never as "the page dialled correctly".
   */
  onConsole?(handler: (text: string) => void): void;
  /**
   * Capture the page as a PNG. OPTIONAL, like `onConsole`: a fake that does not implement it makes
   * the pool report "no provider", which is the correct degradation — an absent screenshotter must
   * read as "this context cannot be captured", never as a blank image that a visual diff would then
   * compare against and pass.
   */
  screenshot?(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  /**
   * Move the real pointer to (x, y) so CSS `:hover` applies. OPTIONAL, like `screenshot`: a fake
   * that does not implement it makes hover refuse rather than dispatch a synthetic mouseover that
   * reports dispatched/settled while the styles never ran.
   */
  hover?(x: number, y: number): Promise<void>;
  /**
   * Install (or clear) network mocks on this page. OPTIONAL: a fake that does not implement it
   * makes `reticle_network_mock` refuse rather than claiming it stubbed a request it cannot intercept.
   */
  installMocks?(rules: readonly PooledMockRule[]): Promise<void>;
}

/**
 * One interception rule the pool can install. Same fields as the drive-path mock rule, kept here so
 * the pool does not import Playwright.
 */
export interface PooledMockRule {
  urlContains: string;
  method?: string;
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
  abort?: boolean;
}

/** An isolated browsing context (cookies/storage). Real Playwright `BrowserContext` satisfies this. */
export interface PooledContext {
  newPage(): Promise<PooledPage>;
  close(): Promise<void>;
}

/** The launched browser. Real Playwright `Browser` satisfies this. */
export interface PooledBrowser {
  isConnected(): boolean;
  newContext(): Promise<PooledContext>;
  close(): Promise<void>;
  /** Fires when the browser process dies/crashes so the pool can relaunch on the next acquire. */
  onDisconnected(handler: () => void): void;
}

/** Produces a freshly launched browser. Injected so tests can supply a fake. */
export type Launcher = () => Promise<PooledBrowser>;

/** A leased context+page for one flow. `release` frees the slot and closes the context. */
export interface Lease {
  readonly sessionId: string;
  readonly url: string;
  release(): Promise<void>;
}

/** Default lease time-to-live: a lease untouched for this long is presumed orphaned and reclaimed. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** Default cap on how long a lease's initial navigation may take before it fails (frees the slot). */
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * How many reaped lease ids to remember. Only the most recent departure is ever asked about, so
 * this is slack for a burst sweep, not a history.
 */
const MAX_REMEMBERED_REAPED_LEASES = 64;

interface BrowserPoolOptions {
  /** Max simultaneous leased contexts. Over-cap acquires queue. */
  maxContexts: number;
  /** Stable id generator for lease sessionIds (injected to stay clock-/random-free in logic). */
  genSessionId: () => string;
  /** Injected clock (ms). Defaults to Date.now; tests pass a controllable one. */
  now?: () => number;
  /** A lease untouched for longer than this is reclaimed by sweepExpired. */
  leaseTtlMs?: number;
  /** Per-lease navigation timeout — a page that won't load fails its own lease, never blocks a slot. */
  navTimeoutMs?: number;
}

interface ActiveLease {
  context: PooledContext;
  page: PooledPage;
  url: string;
  /** Last time an agent touched this lease (acquire or any tool call); drives orphan reclaim. */
  touchedAt: number;
  /**
   * The websocket address the page's SDK reported it could not reach, if it said so.
   *
   * One string, overwritten — not a buffer. The SDK retries and logs each failure, so accumulating
   * them would grow without bound for exactly the app that is already misconfigured, and every entry
   * after the first says the same thing.
   */
  dialFailureUrl?: string;
}

/**
 * Owns a single browser and leases isolated contexts out of it, capped at `maxContexts`.
 * Not exported as a singleton — the daemon owns one instance.
 */
export class BrowserPool {
  readonly #launch: Launcher;
  readonly #max: number;
  readonly #genId: () => string;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #navTimeout: number;

  #browser: PooledBrowser | undefined;
  #launching: Promise<PooledBrowser> | undefined;
  #closed = false;
  /** Leases reclaimed for going stale — see reapedLeaseCount(). */
  #reapedLeases = 0;
  /**
   * The session ids of recently reaped leases, most recent last.
   *
   * The count above answers "has anything ever aged out", which is not a
   * question any caller actually has: it latches true for the life of the
   * daemon (#611). The ids answer the question the no-session diagnosis is
   * really asking — was THIS session a lease that aged out — so a closed
   * human tab is no longer blamed on an expired lease forever after.
   *
   * Bounded because a long-lived daemon reaps unboundedly many.
   */
  readonly #reapedLeaseIds: string[] = [];
  readonly #active = new Map<string, ActiveLease>();
  /** Registered-session-id → lease id, for apps that keep their own session name. See `alias`. */
  readonly #aliases = new Map<string, string>();
  /**
   * Slots claimed-or-active — the real concurrency gate. Incremented SYNCHRONOUSLY the instant an
   * acquire passes the cap check, BEFORE the async context creation, so a burst of concurrent
   * acquires (the "10 agents at once" case) can't all slip through the gate before any has been
   * recorded. `#active.size` only reflects fully-created leases; `#occupied` also counts in-flight
   * ones, and is what the cap is enforced against.
   */
  #occupied = 0;
  /** FIFO of acquires waiting for a slot; each resolves when one frees. */
  readonly #waiters: Array<() => void> = [];

  constructor(launch: Launcher, opts: BrowserPoolOptions) {
    if (opts.maxContexts < 1) throw new Error('maxContexts must be >= 1');
    this.#launch = launch;
    this.#max = opts.maxContexts;
    this.#genId = opts.genSessionId;
    this.#now = opts.now ?? ((): number => Date.now());
    this.#ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  }

  /** The TTL configured for leases — how long an untouched lease lives before the reaper reclaims it. */
  leaseTtlMs(): number {
    return this.#ttl;
  }

  /** Max simultaneous leases — the ceiling the parallel suite sizes its concurrency to. */
  capacity(): number {
    return this.#max;
  }

  activeCount(): number {
    return this.#active.size;
  }

  /** Acquires waiting for a free slot. */
  queuedCount(): number {
    return this.#waiters.length;
  }

  /** The sessionIds of every currently leased context — used to report/group leased sessions. */
  leasedSessionIds(): string[] {
    return [...this.#active.keys()];
  }

  /**
   * The public session id of an active lease on this origin, if we already hold one.
   *
   * The lease TOOL reuses that id instead of minting a second context: a second acquire on the same
   * origin used to leave both tabs connected and poison default session resolution (#600). The pool's
   * own `acquire` still mints — the parallel suite needs isolation on purpose.
   *
   * Prefers the alias the agent was given, when the app registered under its own name.
   */
  leaseIdOnOrigin(origin: string): string | undefined {
    for (const [leaseId, lease] of this.#active) {
      let leaseOrigin: string | undefined;
      try {
        leaseOrigin = new URL(lease.url).origin;
      } catch {
        continue;
      }
      if (leaseOrigin !== origin) continue;
      for (const [alias, id] of this.#aliases) {
        if (id === leaseId) return alias;
      }
      return leaseId;
    }
    return undefined;
  }

  /**
   * Release a lease by its sessionId (closes the context, frees the slot). No-op if unknown.
   *
   * Resolves an alias first, because the agent releases with the id it was GIVEN, which for an app
   * that named its own session is not the id the pool navigated with. Releasing by that name used to
   * be a silent no-op that left the slot held until the reaper took it.
   */
  release(sessionId: string): Promise<void> {
    return this.#release(this.#leaseIdOf(sessionId));
  }

  /**
   * Record that a lease is also known by the name the APP registered.
   *
   * Leases are keyed by the id the pool navigated with, and the SDK normally adopts that id off the
   * URL so the two agree. An app that passes an explicit `session` to `connect()` keeps its own name
   * instead, which is legitimate, and the lease tool then hands the agent THAT name because it is the
   * one it has to drive with. Every later touch and release arrives under it.
   *
   * Without this the touches hit nothing, the lease ages out despite continuous activity, and the
   * reaper closes the context mid-flow — the failure in #157, where a session died on the very call
   * that would have read a computed value.
   */
  alias(registeredId: string, leaseId: string): void {
    if (registeredId === leaseId) return;
    if (!this.#active.has(leaseId)) return;
    this.#aliases.set(registeredId, leaseId);
  }

  /** The lease this id refers to: itself, or whatever it is an alias for. */
  #leaseIdOf(sessionId: string): string {
    return this.#active.has(sessionId) ? sessionId : (this.#aliases.get(sessionId) ?? sessionId);
  }

  /** Mark a lease as still in use (called on agent activity) so the reaper doesn't reclaim it. */
  touch(sessionId: string): void {
    const lease = this.#active.get(this.#leaseIdOf(sessionId));
    if (lease !== undefined) lease.touchedAt = this.#now();
  }

  /**
   * Reclaim leases untouched for longer than the TTL — a hung/crashed agent never holds a slot
   * forever. Returns the released sessionIds. This is the fault-tolerance backstop for the pool.
   */
  /**
   * Capture a leased page, or undefined when this session is not a lease or cannot be captured.
   *
   * A lease IS a real browser page, so the pixels were always available — the visual tools simply had
   * no route to them and answered "no provider" for every context an agent can actually get. That
   * made visual regression impossible on exactly the isolated contexts the pool exists to hand out.
   *
   * Touches the lease like any other tool call, so capturing keeps it alive rather than letting the
   * reaper take it out from under a diff.
   */
  async screenshotLease(
    sessionId: string,
    opts: { fullPage?: boolean } = {},
  ): Promise<Uint8Array | undefined> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined || lease.page.screenshot === undefined) return undefined;
    this.touch(sessionId);
    try {
      return await lease.page.screenshot(opts);
    } catch {
      // A capture that fails is not a broken lease. Report "could not capture" and leave the lease
      // usable — the alternative is losing a working context to one bad frame.
      return undefined;
    }
  }

  /**
   * Move the real pointer on a leased page, or false when this session is not a lease or cannot
   * hover. Same optional-capability contract as screenshotLease: absence must read as "could not
   * hover", never as a successful dispatch of a synthetic mouseover.
   *
   * Touches the lease like any other tool call, so hovering keeps it alive.
   */
  async hoverLease(sessionId: string, x: number, y: number): Promise<boolean> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined || lease.page.hover === undefined) return false;
    this.touch(sessionId);
    try {
      await lease.page.hover(x, y);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install network mocks on a leased page, or false when this session is not a lease or cannot
   * intercept. Same optional-capability contract as screenshotLease: absence must read as "could not
   * mock", never as a stub that applied to nothing.
   *
   * Touches the lease like any other tool call, so mocking keeps it alive.
   */
  async setMocksLease(sessionId: string, rules: readonly PooledMockRule[]): Promise<boolean> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined || lease.page.installMocks === undefined) return false;
    this.touch(sessionId);
    try {
      await lease.page.installMocks(rules);
      return true;
    } catch {
      return false;
    }
  }

  async sweepExpired(): Promise<string[]> {
    const now = this.#now();
    const expired = [...this.#active.entries()]
      .filter(([, lease]) => now - lease.touchedAt > this.#ttl)
      .map(([sessionId]) => sessionId);
    for (const sessionId of expired) await this.#release(sessionId);
    this.#reapedLeases += expired.length;
    for (const sessionId of expired) {
      this.#reapedLeaseIds.push(sessionId);
      if (this.#reapedLeaseIds.length > MAX_REMEMBERED_REAPED_LEASES) this.#reapedLeaseIds.shift();
    }
    return expired;
  }

  /**
   * How many leases this pool has reclaimed for going stale.
   *
   * Kept for reporting. NOT a basis for diagnosis: it is a lifetime total that never resets, so
   * `count > 0` latches true forever after the first reap. Ask `wasReapedLease` instead, which
   * answers about a specific session.
   */
  reapedLeaseCount(): number {
    return this.#reapedLeases;
  }

  /**
   * Did THIS session id belong to a lease this pool aged out?
   *
   * The question the no-session diagnosis actually has. It used to ask `reapedLeaseCount() > 0`,
   * which meant that once any lease had ever aged out, every closed human tab for the rest of the
   * daemon's life was reported as an expired lease — and the recovery that followed
   * (`reticle_lease {acquire}`) would open an unauthenticated headless context and lose the app
   * session (#611).
   *
   * Only the last {@link MAX_REMEMBERED_REAPED_LEASES} are remembered, so this answers `false` for
   * a lease reaped long enough ago that thousands have followed. That direction is the safe one:
   * it falls back to the generic "the tab was closed" wording rather than inventing a lease.
   */
  wasReapedLease(sessionId: string): boolean {
    return this.#reapedLeaseIds.includes(sessionId);
  }

  /**
   * Lease an isolated context, navigate it to `url`, and return a handle. If the pool is at capacity,
   * waits FIFO until a slot frees (or until `signal` aborts, if provided).
   */
  async acquire(
    url: string,
    opts: { signal?: AbortSignal; sessionId?: string } = {},
  ): Promise<Lease> {
    if (this.#closed) throw new Error('browser pool is shut down');
    // #waitForSlot claims the slot synchronously (bumps #occupied) before returning, so the cap holds
    // even when many acquires race through the gate in the same tick.
    await this.#waitForSlot(opts.signal);
    const sessionId = opts.sessionId ?? this.#genId();
    let context: PooledContext | undefined;
    let pending: string | undefined;
    try {
      const browser = await this.#ensureBrowser();
      context = await browser.newContext();
      const page = await context.newPage();
      // Per-page crash isolation: if THIS renderer dies, reclaim only this lease — the shared browser
      // and every other agent's context keep running. (A full browser death is handled by #onCrash.)
      page.onCrash(() => {
        void this.#release(sessionId);
      });
      // Listen BEFORE goto: the SDK's connect attempt races the navigation's own resolution, and a
      // listener attached afterwards misses the first failures — the only ones logged before the
      // retry backoff stretches out.
      page.onConsole?.((text) => {
        const dialled = unreachableUrlIn(text);
        if (dialled === undefined) return;
        const active = this.#active.get(sessionId);
        if (active !== undefined) active.dialFailureUrl = dialled;
        else pending = dialled; // logged during goto, before the lease is registered below
      });
      await page.goto(url, { timeoutMs: this.#navTimeout });
      // The browser can crash WHILE goto is resolving; #onCrash then clears #active and zeroes
      // #occupied. Registering the lease now would resurrect a dead entry against a crashed browser with
      // the slot count out of sync (drifting below #active.size, eventually exceeding the cap). If we're
      // no longer the live browser, bail — the catch below closes the context and returns the slot.
      if (this.#browser !== browser) throw new Error('browser crashed during navigation');
      this.#active.set(sessionId, {
        context,
        page,
        url,
        touchedAt: this.#now(),
        ...(pending === undefined ? {} : { dialFailureUrl: pending }),
      });
      return {
        sessionId,
        url,
        release: () => this.#release(sessionId),
      };
    } catch (err) {
      // Setup failed after we claimed the slot — give it back so a queued acquire isn't stuck, and
      // close the half-open context.
      if (context !== undefined) await context.close().catch(() => undefined);
      this.#releaseSlot();
      throw err;
    }
  }

  /**
   * The websocket address this lease's page reported it could not reach, if it reported one.
   *
   * Undefined means the page said nothing — never that it dialled the right place.
   */
  dialFailureUrl(sessionId: string): string | undefined {
    return this.#active.get(sessionId)?.dialFailureUrl;
  }

  /** Close every context and the browser. Pending waiters are rejected (the pool is terminal now). */
  async shutdown(): Promise<void> {
    this.#closed = true; // set first so any woken waiter rejects instead of relaunching a browser
    const contexts = [...this.#active.values()].map((a) => a.context);
    this.#active.clear();
    this.#occupied = 0;
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    // If a launch is in flight, await it so we can close the resulting browser — otherwise it
    // resolves after shutdown returns and the Chromium process is orphaned (hundreds of MB leaked).
    const inflight = this.#launching;
    if (inflight !== undefined) {
      const launched = await inflight.catch(() => undefined);
      if (launched !== undefined && launched !== this.#browser) {
        await launched.close().catch(() => undefined);
      }
    }
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async #release(sessionId: string): Promise<void> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined) return; // already released or lost to a crash
    this.#active.delete(sessionId);
    // Drop any alias pointing here, or the map grows for the life of the daemon and a later lease
    // reusing that registered name would resolve to a context that is already closed.
    for (const [registered, leaseId] of this.#aliases) {
      if (leaseId === sessionId) this.#aliases.delete(registered);
    }
    await lease.context.close().catch(() => undefined);
    this.#releaseSlot();
  }

  /** Synchronously claim a slot if under the cap. Returns true on success (caller proceeds). */
  #tryClaim(): boolean {
    if (this.#occupied < this.#max) {
      this.#occupied += 1;
      return true;
    }
    return false;
  }

  #waitForSlot(signal?: AbortSignal): Promise<void> {
    if (this.#tryClaim()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onFree = (): void => {
        // The pool shut down while we waited → reject rather than relaunch a browser.
        if (this.#closed) {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          reject(new Error('browser pool is shut down'));
          return;
        }
        // Claim the freed slot; if another woken waiter beat us to it, re-queue.
        if (this.#tryClaim()) {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolve();
        } else {
          this.#waiters.push(onFree);
        }
      };
      const onAbort = (): void => {
        const i = this.#waiters.indexOf(onFree);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error('acquire aborted'));
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new Error('acquire aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.push(onFree);
    });
  }

  /** Give back one occupied slot and hand it to the next waiter (which re-claims it synchronously). */
  #releaseSlot(): void {
    if (this.#occupied > 0) this.#occupied -= 1;
    const next = this.#waiters.shift();
    if (next !== undefined) next();
  }

  async #ensureBrowser(): Promise<PooledBrowser> {
    if (this.#closed) throw new Error('browser pool is shut down');
    if (this.#browser !== undefined && this.#browser.isConnected()) return this.#browser;
    // De-dupe concurrent launches: the first acquire to find no browser starts one; the rest await it.
    if (this.#launching === undefined) {
      // The in-flight promise MUST be cleared on failure as well as success. It used to be cleared only
      // in the success callback, so the first failed launch — Chromium not downloaded, a transient
      // EAGAIN — left a permanently rejected promise here, and every subsequent acquire for the daemon's
      // lifetime re-returned that same stale rejection. Running `npx playwright install` did not help;
      // only restarting the daemon did. A retry must be allowed to actually retry.
      this.#launching = this.#launch()
        .then((b) => {
          b.onDisconnected(() => this.#onCrash(b));
          this.#browser = b;
          return b;
        })
        .finally(() => {
          this.#launching = undefined;
        });
    }
    return this.#launching;
  }

  /** The browser process died: drop every lease (they're invalid) and clear so the next acquire relaunches. */
  #onCrash(crashed: PooledBrowser): void {
    if (this.#browser !== crashed) return; // a stale handler from a prior browser
    this.#browser = undefined;
    this.#active.clear();
    this.#occupied = 0; // every slot is gone with the browser
    for (const waiter of this.#waiters.splice(0)) waiter(); // let them re-claim + relaunch
  }
}
