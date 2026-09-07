/**
 * Why a leased tab did not dial in.
 *
 * The lease pool opens the app itself, which is what makes it the highest-value path in the product
 * — it does not wait for the human's tab. Measured over a day: lease sessions had a median of 30
 * tool calls and produced 46% of all bugs found, against a median of 1 call for everything else.
 *
 * The old hint asked "is <url> running with @reticlehq/core enabled?", which is the one thing that
 * cannot be in doubt: the pool just navigated a real browser to it. Its replacement then swung to
 * the other confident-but-unevidenced claim — "the usual cause is a PORT MISMATCH" — and the daemon
 * ended up contradicting ITSELF inside one response, saying in `reticle_sessions` that a session had
 * connected earlier "so the wiring is correct" and here that the port was probably wrong. Across a
 * batch of field reports on four apps the port was correct every single time, and `reticle init`
 * would have been the wrong action every single time.
 *
 * So: rank by what the daemon actually knows, and fall back to the differential only when it knows
 * nothing. A cause we hold positive evidence against is not printed at all.
 */

/** What the daemon can say for certain at the moment a lease comes back unconnected. */
export interface LeaseEvidence {
  /** A dial WAS made and turned away, with the reason. The only certain cause there is. */
  refusal?: string;
  /** An app for this project has connected on this port before (durable, survives a restart). */
  previouslyConnected?: boolean;
  /** The project has been through `init` — so recommending it again cannot help. */
  initialized?: boolean;
  /** The framework `.reticle.json` declares, used to rank rather than to decorate. */
  framework?: string;
  /**
   * Whether any Reticle marker was found in the page the lease loaded.
   *
   * The single bit that separates the two commonest cases — "this app ships no SDK" and "the SDK
   * loaded but could not reach the daemon" — which today produce identical messages. Absent means
   * NOT CHECKED, and an absent bit prints nothing: a marker check that could not run must not be
   * reported as a marker that was not found.
   */
  sdkMarker?: boolean;
  /**
   * The websocket URL the leased page actually tried, read from its own console.
   *
   * The only per-page proof there is about where the dial WENT. `refusal` proves a dial arrived
   * HERE; this proves where one was aimed, which is the strictly more useful fact when it was aimed
   * somewhere else — the case in which no refusal exists to be recorded, because nothing arrived.
   *
   * Absent means the page said nothing, never that it dialled correctly.
   */
  dialledUrl?: string;
}

const NUXT = 'nuxt';

const PORT_DIFFERENTIAL =
  "The usual cause is a PORT MISMATCH: the app's SDK connects to the port it was BUILT with, so a " +
  "daemon on a different port never hears from it — check the app's reticle port (`.reticle.json`, " +
  "RETICLE_PORT, or the build plugin's `port`), or start the daemon on the port the app expects.";

/**
 * The causes that actually occur on a wired app, in the order they occur. Mirrors the no-session
 * diagnosis deliberately: two surfaces answering the same question must not rank it differently.
 */
const REAL_CAUSES =
  'Causes that produce exactly this and are NOT a port problem: (a) the SDK is in the bundle but ' +
  '`connect()` is never reached — a dev-mode guard or a missing runtime-config value returning ' +
  'early, which emits nothing at all; (b) the dev server was started BEFORE the Reticle plugin was ' +
  'added, so it is not in the bundle — restart it, HMR is not enough; (c) a peer dependency is ' +
  'missing (typically `@reticlehq/react` in a non-React app) so the dynamic import fails silently; ' +
  '(d) the page is not on localhost, where the SDK needs BOTH `allowNonLocalhost: true` and a ' +
  'pairing token — the flag alone is not sufficient.';

const NUXT_FIRST =
  'This project is Nuxt: the most likely cause by a distance is a dev server that predates the ' +
  'Reticle plugin, because Nuxt does NOT register a newly added plugin on HMR. Restart `nuxt dev` ' +
  'and re-acquire before investigating anything else.';

const RELEASE =
  'The tab stays leased either way — release it with reticle_lease{action:"release"}.';

function markerClause(sdkMarker: boolean | undefined): string {
  if (sdkMarker === undefined) return '';
  return sdkMarker
    ? ' A Reticle SDK marker WAS found in the page that loaded, so the app does ship the SDK — the ' +
        'question is only why it did not reach this daemon.'
    : ' No Reticle SDK marker was found in the page that loaded. That is a check of the SERVED ' +
        'document, so a lazily-imported SDK can still be missed — but combined with the rest it ' +
        'points at a bundle that carries no Reticle at all, i.e. wiring that never took effect.';
}

/**
 * The port a websocket URL names, or undefined when it names none we can read.
 *
 * `ws://host/path` with no explicit port is deliberately undefined rather than defaulted to 80: a
 * guessed port compared against the daemon's would manufacture a mismatch out of nothing, and this
 * branch outranks every other cause. No answer is correct here; a plausible one is not.
 */
function dialledPort(url: string | undefined): number | undefined {
  if (url === undefined) return undefined;
  try {
    const port = new URL(url).port;
    return '' === port ? undefined : Number(port);
  } catch {
    return undefined;
  }
}

export function leaseNotConnectedHint(
  url: string,
  port: number,
  evidence: LeaseEvidence = {},
): string {
  const opening = `the leased tab loaded ${url} but never dialled this daemon (port ${String(port)}).`;
  const marker = markerClause(evidence.sdkMarker);

  // 0. The page told us where it dialled, and it was not here. Proof, and it outranks the refusal
  //    branch below: a refusal proves a dial reached THIS daemon, which is a fact about some page;
  //    this is a fact about the page in hand. When they disagree, the specific one wins.
  //
  //    Neither side can reach this conclusion alone, which is why it went unsaid for so long. The
  //    page's own warning deliberately refuses to diagnose the daemon — from inside a browser a
  //    daemon that is absent and one that is unreachable are the same observation. The daemon cannot
  //    see a dial that never arrived. Put the address the page names beside the port the daemon is
  //    bound to and the ambiguity disappears.
  const dialled = dialledPort(evidence.dialledUrl);
  if (dialled !== undefined && dialled !== port) {
    return (
      `${opening} The page dialled ${String(evidence.dialledUrl)} (port ${String(dialled)}) and ` +
      `this daemon is on ${String(port)}, so the dial never reached it. Nothing about the app's ` +
      `wiring is in question. Either start the daemon on ${String(dialled)}, or point the app at ` +
      `${String(port)} — the app's port comes from its build config (\`.reticle.json\`, ` +
      `RETICLE_PORT, or the build plugin's \`port\`), and \`VITE_RETICLE_WS_URL\` overrides it ` +
      `outright.${marker} ${RELEASE}`
    );
  }

  // 1. A recorded refusal. The only cause with proof behind it, so nothing outranks it.
  if (evidence.refusal !== undefined) {
    return `${opening} A dial DID arrive and was refused: ${evidence.refusal}${marker} ${RELEASE}`;
  }

  // 2. Nuxt, whose most likely cause differs from every other framework's and which `init` warns
  //    about at install time — while this hint never mentioned it.
  const nuxt = evidence.framework?.toLowerCase() === NUXT ? ` ${NUXT_FIRST}` : '';

  // 3. Proven PORT. Blaming the port here is the self-contradiction this rewrite exists to end —
  //    but "the wiring is correct" was a second claim, and it was not proven at all.
  //
  //    `previouslyConnected` is scoped to project + port, never to the app. In a monorepo, or for
  //    anyone adding a second app, the thing that connected yesterday is a DIFFERENT app. Measured:
  //    an uninstrumented app driven in exactly that situation was told its wiring was correct, and
  //    handed four causes — a dev-mode guard, a stale dev server, a missing peer dependency, a
  //    non-localhost page — every one of which presupposes the SDK is already installed. It was
  //    not. That is the commonest failure there is, and `reticle init` appeared nowhere in the
  //    answer, because the only branch that mentions it is the one reached when nothing is known.
  if (true === evidence.previouslyConnected) {
    const notThisApp =
      true === evidence.sdkMarker
        ? ''
        : ' That may have been a DIFFERENT app, though: this one may carry no Reticle SDK at all, ' +
          'in which case run `reticle init` in ITS directory first — every cause below assumes the ' +
          'SDK is already installed.';
    return (
      `${opening} An app for this project HAS connected on this port before, so the port is ` +
      `proven.${notThisApp}${nuxt}${marker} ${REAL_CAUSES} ${RELEASE}`
    );
  }

  // 4. Wired, but never seen connect. Rank the real causes; keep the port differential last, where
  //    the evidence for it actually sits.
  if (true === evidence.initialized) {
    return `${opening}${nuxt}${marker} ${REAL_CAUSES} If none of those, it may be dialling a different daemon than this one: check the app's reticle port matches ${String(port)}. ${RELEASE}`;
  }

  // 5. Nothing known. The differential, plus the possibility this app carries no SDK at all —
  //    except when the marker check already ruled that out, which is the whole reason for the bit.
  const noSdk =
    true === evidence.sdkMarker
      ? ''
      : ' If the app carries no Reticle SDK at all, run `reticle init` in it first.';
  return `${opening}${nuxt}${marker} ${PORT_DIFFERENTIAL}${noSdk} ${REAL_CAUSES} ${RELEASE}`;
}
