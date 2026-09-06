/**
 * Ambient page traffic — the noise a real application carries, which a VERDICT must not blame it for.
 *
 * Every other knob in this fixture injects a DEFECT and asks whether a tool can see it. This one
 * injects no defect at all: it reproduces the traffic a correct app emits anyway — a vendor analytics
 * beacon, an ad-blocked pixel, a page-load bootstrap, a background poll, a StrictMode double effect —
 * so the benchmark can ask the opposite question. Does a verdict about an action the user DID take
 * survive traffic the user did not cause?
 *
 * That question was unmeasured. The observation suite had ten scenarios where the correct answer is
 * "something is wrong" and one where it is "nothing is wrong", so a detector that fired on absolutely
 * everything still scored 0.909, and the defect four separate field reports actually described — a
 * `contradicted` verdict citing traffic the assertion never mentioned — could not lower any number
 * here. These are the negative cases that give the accuracy figure a denominator.
 *
 * No-op unless `?ambient=<ids>` is present, so every existing scenario and every app the fixture
 * serves is byte-identical to before.
 */
import { API_BASE } from './lib/api.js';

/** Which ambient behaviours the URL can switch on. */
export const Ambient = {
  /** A third-party analytics beacon that FAILS. The field report, almost verbatim. */
  BEACON: 'beacon',
  /** A third-party pixel an ad-blocker eats. The most common real-world state on the open web. */
  ADBLOCK: 'adblock',
  /** A FIRST-party bootstrap that fails once at page load and never again. */
  PAGELOAD: 'pageload',
  /** FIRST-party telemetry that keeps failing: a background poll AND a per-interaction ping. */
  POLL: 'poll',
  /** A mount effect React StrictMode invokes twice in dev — one write, two requests. */
  STRICT_DUP: 'strictdup',
} as const;
export type Ambient = (typeof Ambient)[keyof typeof Ambient];

const AMBIENT_PARAM = 'ambient';

/**
 * Somebody else's servers.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, which is the point: these are genuinely
 * cross-origin requests to genuinely different registrable domains that genuinely fail, not
 * same-origin URLs dressed up to look foreign. A beacon whose DNS never answers and a beacon an
 * ad-blocker refuses reach the page as the same thing — a rejected fetch carrying no status.
 */
const VENDOR_BEACON_URL = 'https://collect.telemetry-vendor.invalid/collect';
const AD_NETWORK_PIXEL_URL = 'https://ads.tracker-network.invalid/px.gif';

/** The app's own endpoints. `/api/broken/500` answers 500 every time — a first-party failure. */
const FIRST_PARTY_FAILING_URL = `${API_BASE}/api/broken/500`;

/**
 * Cadences — and why an interval alone is not enough.
 *
 * An `act_and_wait` window closes the moment its predicate is satisfied, which on this fixture is
 * about 15ms. A beacon on a 700ms timer lands inside a 15ms window roughly one time in fifty, so an
 * interval-only fixture produces a negative case that is 98% vacuous and 2% flaky — it passes
 * because the traffic was never shown to the detector, which is precisely the shape of empty green
 * these scenarios exist to refuse.
 *
 * So the traffic is also fired ON CLICK, which is not a workaround but the commoner truth: analytics
 * beacons, ad pixels and first-party interaction pings are attached to a document-level click
 * listener in every tag manager there is. The user's click causes the app's action and the vendor's
 * beacon at the same instant, and that coincidence IS the field report.
 */
const BEACON_INTERVAL_MS = 700;
const POLL_INTERVAL_MS = 500;

/** The label the StrictMode-doubled mount effect writes. Named so the duplicate is recognisable. */
export const STRICT_DUP_MOUNT_LABEL = 'mount-ping';

/** Fire and forget, exactly as a real beacon does — the app never learns whether it landed. */
function ignoreFailure(request: Promise<unknown>): void {
  void request.catch(() => undefined);
}

/**
 * Fire on every click, capture-phase — where a tag manager installs itself.
 *
 * Capture so the beacon is dispatched BEFORE the app's own handler runs, which is both what the real
 * ones do and the harder case for a verdict: the failing request is already under way when the
 * action starts.
 */
function onEveryClick(fire: () => void): void {
  document.addEventListener('click', fire, true);
}

function post(url: string, body: Record<string, unknown>): void {
  ignoreFailure(
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Is this ambient behaviour switched on for this page load? */
export function ambientEnabled(id: Ambient): boolean {
  const raw = new URLSearchParams(window.location.search).get(AMBIENT_PARAM);
  if (null === raw) return false;
  return raw.split(',').includes(id);
}

/**
 * Install whichever ambient behaviours the URL asked for.
 *
 * Intervals are never cleared. That is deliberate rather than sloppy: this only runs for a page the
 * benchmark opened with `?ambient=…`, and the whole property under test is that the traffic keeps
 * arriving while the agent acts and asserts.
 */
export function installAmbientTraffic(): void {
  if (ambientEnabled(Ambient.BEACON)) {
    const beacon = (): void => post(VENDOR_BEACON_URL, { event: 'interaction' });
    beacon();
    setInterval(beacon, BEACON_INTERVAL_MS);
    onEveryClick(beacon);
  }
  if (ambientEnabled(Ambient.ADBLOCK)) {
    // Both shapes an ad-blocker meets: the fetch a tag manager makes, and the <img> pixel it writes.
    const pixel = (): void => {
      ignoreFailure(fetch(AD_NETWORK_PIXEL_URL, { mode: 'no-cors' }));
      new Image().src = AD_NETWORK_PIXEL_URL;
    };
    pixel();
    onEveryClick(pixel);
  }
  if (ambientEnabled(Ambient.PAGELOAD)) {
    // ONCE, at load, and never again: the traffic that predates every action the agent will take.
    ignoreFailure(fetch(FIRST_PARTY_FAILING_URL));
  }
  if (ambientEnabled(Ambient.POLL)) {
    const ping = (): void => ignoreFailure(fetch(FIRST_PARTY_FAILING_URL));
    ping();
    setInterval(ping, POLL_INTERVAL_MS);
    onEveryClick(ping);
  }
  // STRICT_DUP is not installed here — a double-invoked effect only happens inside React, so it
  // lives in the component that mounts (views/SavedItems.tsx). Faking it from here would produce two
  // requests that no StrictMode ever caused.
}
