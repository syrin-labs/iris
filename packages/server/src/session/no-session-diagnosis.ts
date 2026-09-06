/**
 * Turning "no browser session connected" from a dead end into a next action.
 *
 * This is the most consequential sentence in the product. Most sessions never call a Reticle tool at
 * all, and of the ones that do, a large share make exactly ONE call — usually `reticle_sessions` —
 * and stop. Almost none of those ever touched a browser, and this is the session error they hit. The
 * agent asks whether anything is connected, is told no, and leaves.
 *
 * The old message asked the agent to check two things it cannot see from where it stands ("is your
 * app running with the SDK enabled?", "does it point at this port?"). The daemon can actually tell
 * the three cases apart, and each has a different, concrete fix:
 *
 *   - a session was here and went away    -> the tab closed or reloaded; reopen it
 *   - something is listening, never dialled, project not wired -> run `reticle init` in THAT app
 *   - something is listening, project wired -> port mismatch or a stale build; restart the dev server
 *   - nothing is listening anywhere       -> there is no app running; start it
 *
 * Pure: everything it needs is passed in, so the probe that discovers listening ports stays out of
 * the hot resolve() path and this stays unit-testable.
 */

import { NoSessionReason } from '@reticlehq/core';

import { leaseCaveat, type LeaseBrowserState } from './lease-availability.js';
import { DEV_SERVER_PORTS } from '../cli/cli-port.js';
import { siblingListenerNote } from '../cli/sibling-ports.js';
import { STALL_AFTER_MS } from './stall-clock.js';

export interface NoSessionFacts {
  /** Whether ANY session has connected to this daemon since it booted. */
  everConnected: boolean;
  /** Whether this project has been through `reticle init` (a .reticle.json / projectId is present). */
  initialized: boolean;
  /** Localhost ports with something listening that looks like a dev server. */
  listening: readonly number[];
  /**
   * Ports that ACCEPTED a connection and then answered nothing inside the probe budget.
   *
   * Not dev servers as far as the probe knows, and absolutely not absent. An SSR framework
   * compiling its first route lands here every time, and calling that "nothing is listening" told a
   * reporter to start a Nuxt server that was already serving — advice that would have hit their dev
   * lock. Named in the message so the reader can tell the two apart.
   */
  slowListeners?: readonly number[];
  /** The port this daemon is on — half of the mismatch the old message asked about. */
  port: number;
  /**
   * What the caller knows about the Chromium a lease would drive.
   *
   * Every branch below offers `reticle_lease` as the way not to wait for a human. When that browser
   * is missing or at a revision this Playwright will not use, the offer is the one thing that cannot
   * help — and it was being made by the same output that had just diagnosed exactly that. Optional:
   * absent means the caller did not probe, which is not evidence the browser is missing.
   */
  leaseBrowser?: LeaseBrowserState | undefined;
  /**
   * The directory `initialized` was decided in, named in the message when it is known.
   *
   * "There is no `.reticle.json`" is only ever true OF A DIRECTORY, and a reader who cannot see
   * which one has to guess whether the claim is about their app at all — reported by someone whose
   * app lives in `src/admin` while the daemon stands at the repo root.
   */
  directory?: string;
  /**
   * This daemon has reaped at least one EXPIRED pooled lease.
   *
   * Deliberately not "the session that just vanished was that lease" — nothing knows that. It is
   * evidence, not proof, and the message below is worded accordingly.
   */
  leaseExpired?: boolean;
  /**
   * The port `.reticle.json` configures for this project, when there is one.
   *
   * Half of a mismatch the daemon can settle rather than hint at: it knows the port it bound, and
   * this is the number the app's SDK was built to dial. `doctor` already compares them and prints a
   * precise line; the agent reading `why` was getting "check that the port matches" instead.
   *
   * Absent means no config, or one without a port, which is NOT a mismatch: a plugin-wired app has
   * no `.reticle.json` at all and is working perfectly.
   */
  projectPort?: number;
  /**
   * An app HAS connected on this port for this project before — read from durable state, not from
   * this process.
   *
   * `everConnected` is a per-process boolean, and daemons are short-lived by design: they idle out
   * and respawn. So a fresh daemon said it had "never seen one" seconds after its predecessor served
   * a session, and the reader was sent hunting a `.reticle.json` that was never missing. The two
   * claims mean opposite things — one is evidence about an install, the other is a fact about a
   * process that booted four seconds ago — and only this one can tell them apart.
   */
  previouslyConnected?: boolean;
  /**
   * The framework `.reticle.json` declares, when there is one.
   *
   * Used to RANK the causes rather than to print a static differential. Nuxt is the case that made
   * the difference: it does not register a new plugin on HMR, so a dev server older than the wiring
   * is the single most likely cause there — and `reticle init` says so at install time while the
   * hint the agent reads hours later never mentioned it.
   */
  framework?: string;
  /**
   * `.reticle.json` files found OUTSIDE this daemon's directory — a workspace app, a repo root.
   *
   * Editors launch MCP servers from wherever they like, and the config then sits under the app
   * package while the daemon stands in the user's home. The old message read that as "this project
   * has no SDK" and sent a working install back through `reticle init`.
   */
  configsElsewhere?: readonly { directory: string; projectId?: string }[];
  /**
   * Every directory the config search actually checked.
   *
   * "There is no `.reticle.json`" is unfalsifiable without it, and the claim was wrong often enough
   * that a reader deserves to check it.
   */
  searchedDirectories?: readonly string[];
  /**
   * How long this daemon has been running with no app connected, in milliseconds.
   *
   * Present only when the stall clock is active and no app has arrived. Used to surface "the
   * install never finished" to the user-facing diagnosis rather than only to telemetry.
   */
  daemonUpMs?: number;
  /**
   * Well-known Reticle ports other than `port` that currently accept a connection.
   *
   * Remaining half of #261. We cannot see an SDK dialling a port we are not on, but we can see that
   * a well-known Reticle port has a listener. That is an observation: somebody else's daemon, another
   * project, and an unrelated process all look the same from here. The sentence that reports it
   * names the ports and refuses the conclusion. Absent or empty means nothing else was listening,
   * which is the common case and must not gain a paragraph.
   */
  siblingListeners?: readonly number[];
}

/** The one framework whose most likely cause differs from every other framework's. */
const NUXT = 'nuxt';

/**
 * Every branch ends with this, and `recoveryFor` keys on it to suppress the generic no-session
 * recovery: a message that already carries its own next action must not be handed a second, more
 * generic one that contradicts it.
 */
export const SELF_RECOVERING_MARKER =
  'Then call reticle_sessions again — it will appear within a second of the page loading.';
const RETRY = SELF_RECOVERING_MARKER;

/**
 * The way out that needs no human at all.
 *
 * `reticle_lease` opens a browser Reticle drives itself, instead of waiting for somebody's tab to
 * dial in. In the field it is the single strongest predictor of a session that works: sessions that
 * use it drive an order of magnitude more tool calls than those that do not, they account for a
 * disproportionate share of every bug found, and no single-call bounce has ever used one. It is also
 * advertised on no profile except `full`, so an agent only ever finds it if it already knew it
 * existed. Naming it HERE puts it in front of the agent at the one moment it is the answer, and
 * costs nothing on the turns when it is not.
 *
 * Only offered when the app is known to carry the SDK: leasing an uninstrumented app just burns a
 * browser and comes back `ready:false`.
 */
/**
 * The no-shell path, for the branches where a BLIND lease would be wrong.
 *
 * A lease opens a URL, so offering one while nothing is listening is offering to open nothing —
 * which is why these branches deliberately withheld it, and a test pins that. But withholding it
 * left an agent with no CLI holding no path at all: reported from Windows, where the MCP server was
 * registered and every tool advertised while no `reticle` binary existed on disk, so every remedy
 * offered was a shell command that could not be run.
 *
 * The resolution is the ORDER, not the offer. Get the URL first — which these branches already tell
 * the reader to do — and then the lease is the way to open it without a shell.
 */
const URL_THEN_LEASE =
  'Once you have that URL, open it with reticle_lease {action:"acquire", url} rather than a shell ' +
  'command — it needs no CLI on PATH (reach it with reticle_run {tool:"reticle_lease"} if it is ' +
  'not advertised directly).';

/**
 * The lease advice, with the reason it cannot be taken when that is the case.
 *
 * A function rather than a constant so the caveat cannot be forgotten at one of the six sites that
 * offer the lease — which is exactly how the offer came to be made by the command that had already
 * diagnosed the problem.
 */
function leaseAdvice(base: string, facts: NoSessionFacts): string {
  const caveat = leaseCaveat(facts.leaseBrowser);
  return caveat === undefined ? base : `${base} ${caveat}`;
}

const SELF_SERVE =
  'You do not have to wait for the human: reticle_lease {action:"acquire", url} opens a browser ' +
  'Reticle drives itself, and returns a sessionId you can use immediately (reach it with ' +
  'reticle_run {tool:"reticle_lease"} if it is not advertised directly; release it when you finish).';

/**
 * The ports the scan actually covers, rendered for the message.
 *
 * Derived from DEV_SERVER_PORTS rather than re-typed: a message that lists ports the scan does not
 * check, or omits ones it does, is a new version of the same defect — a confident claim about
 * evidence that was never gathered.
 */
/**
 * The one cause that produces a PERFECTLY healthy everything and still never connects.
 *
 * The SDK refuses to dial from a page that is not on localhost unless `allowNonLocalhost` is set.
 * That is deliberate — Reticle must not be reachable from a page it does not trust — but the refusal
 * happens page-side, so the daemon sees only silence, `doctor` sees only a healthy daemon, and every
 * checklist item passes. Reported from the field by an agent on a hosts-file alias (the normal setup
 * for white-label and multi-tenant apps): the whole setup was lost to a flag named in no checklist,
 * and `init`'s own fallback snippet guards on `hostname === 'localhost'`, so on such a host the
 * connect never runs and there is not even a console line to find.
 *
 * Only offered on the wired-and-listening branch: that is where a correctly installed app that
 * cannot connect actually lands.
 */
const NON_LOCALHOST_GATE =
  'One more cause that leaves every other check healthy: if the app is served on anything other ' +
  'than localhost (a hosts-file alias, a LAN IP, a tunnel), the SDK refuses to connect unless it ' +
  'is given `allowNonLocalhost: true` AND a pairing token — the flag alone is NOT sufficient off ' +
  'localhost, which cost one reporter their whole setup until they read our compiled SDK by hand. ' +
  'The token is the one in `~/.reticle/pairing-token`, passed as `token` to the same connect(). ' +
  'The refusal is page-side, so nothing here can see it: check the browser console for that ' +
  "message and pass both in the app's reticle.connect().";

/**
 * The causes that actually occurred in the field, for an app that is wired and still silent.
 *
 * Every one of these is indistinguishable from "no SDK installed" from every surface an agent can
 * reach, and the old message modelled none of them — it modelled a missing SDK and a wrong port, and
 * across a batch of reports on four apps the port was right every time. An agent that is told the
 * wrong differential does not merely waste calls: several of these reports end with the agent
 * telling its human that Reticle was not set up, on an app that was correctly wired.
 */
const REAL_CAUSES =
  'Causes that produce exactly this and are NOT a port problem, in the order they actually occur: ' +
  '(a) the SDK is in the bundle but `connect()` is never reached — a dev-mode guard or a missing ' +
  'runtime-config value returning early, which emits nothing at all, so grep the app for the ' +
  'connect call and confirm it runs; (b) the dev server was started BEFORE the Reticle plugin was ' +
  'added, so it is not in the bundle at all — restart the dev server, do not rely on HMR; ' +
  '(c) a peer dependency is missing, typically `@reticlehq/react` in a non-React app, so the ' +
  "dynamic import fails silently; (d) this daemon's working directory is not the project, so it is " +
  'scoped to the wrong app entirely — check the directory named above is really where your app ' +
  'lives.';

/** Nuxt's most likely cause is (b), and Nuxt is the framework where it is nearly certain. */
const NUXT_STALE_BUNDLE =
  'This project is Nuxt: the most likely cause by a distance is a dev server that predates the ' +
  'Reticle plugin. Nuxt does NOT register a newly added plugin on HMR, so the running bundle ' +
  'carries no SDK however correct the config is — STOP and restart `nuxt dev`, then reload the ' +
  'page, before investigating anything else.';

/**
 * The lead when durable state proves this project has connected on this port before.
 *
 * The daemon used to contradict itself inside one response: `reticle_sessions` said a session HAD
 * connected earlier "so the wiring is correct", and a lease seconds later said the usual cause was a
 * port mismatch. It already held the evidence against its own hint.
 */
const RESTARTED_LEAD =
  'no browser session connected. This daemon has served none since it started, but it is a NEW ' +
  'process — an app for this project HAS connected on this port before, which is recorded ' +
  'durably. So the wiring is correct and the port is correct: what is failing now is the SDK ' +
  'reaching initialise on the page. Re-running the install is the wrong move here: it cannot help ' +
  'on a project that has demonstrably connected, and it can overwrite a working config.';

const SCANNED_PORTS = [...DEV_SERVER_PORTS].join(', ');

/**
 * How to say "open the app" to an agent that may have no `reticle` binary.
 *
 * These strings are read by an AGENT that is already blocked, and they used to name a bare
 * `reticle open <url>`. Reticle registers its MCP server as `npx @reticlehq/server mcp`, so the
 * ordinary install puts NOTHING on PATH — the binary those messages assume is missing on most
 * machines that ever read them.
 *
 * Reported from Windows, where a half-failed plugin install left the MCP server registered and all
 * the tools advertised while no CLI existed on disk. The agent followed the remediation, found no
 * `reticle`, tried `npx @reticlehq/reticle` (a package that does not exist and 404s), and had no
 * path forward at all. The remedy has to be a command that works from a bare npm environment.
 *
 * Init-time messages keep the short form on purpose: there, the reader is already running the CLI.
 */
const OPEN_CMD = '`npx @reticlehq/server open <url>`';
const OPEN_CMD_BARE = '`npx @reticlehq/server open`';
const INIT_CMD = '`npx @reticlehq/server init`';

/**
 * The one sentence that stops the scan lying about a server that is running.
 *
 * A port that accepted a connection and then said nothing is evidence FOR the app being up, not
 * against it, and it has to be read before the "nothing is listening" sentence rather than after —
 * the reader acts on the first claim.
 */
function slowListenerClause(facts: NoSessionFacts): string {
  const slow = facts.slowListeners ?? [];
  if (0 === slow.length) return '';
  const ports = slow.join(', ');
  const subject = 1 === slow.length ? `Port ${ports} ACCEPTED` : `Ports ${ports} ACCEPTED`;
  return (
    `${subject} a connection but did not answer in time, which is what a server-rendered dev ` +
    'server compiling its first route looks like — so something IS running there and you should ' +
    'open it rather than start it. Setting that aside: '
  );
}

/**
 * The commonest first-run state there is, and until #320 the message named it nowhere.
 *
 * Reticle sees a page only once a browser has LOADED it. A wired app that nobody has opened produces
 * exactly the same empty list as a broken install, and the reporter who hit it spent an afternoon
 * re-verifying their init output, diffing their Vite config and curling their own page before
 * discovering that one `reticle open` fixed it instantly.
 */
const OPEN_THE_APP =
  'Reticle only ever sees a page that is LOADED, so the commonest cause by a distance is that no ' +
  `browser has opened the app yet: run ${OPEN_CMD} with the app's own URL (or ask the ` +
  'human to open it).';

/**
 * What a machine-wide port scan can and cannot say.
 *
 * It finds listeners anywhere on localhost and knows nothing about who owns them. The old wording
 * spent that as evidence — "something IS listening on port 5173, 8000, 8080, SO a server is up and
 * has never dialled this daemon" — about three ports that belonged to three other repositories on
 * the reporter's machine, while their own app sat on a port the scan does not cover. On any machine
 * running more than one instrumented repo, which is the normal case here, that inference is unsound.
 */
function unattributedListeners(listening: readonly number[]): string {
  if (0 === listening.length) {
    return (
      `No listener found that I can attribute to this project: the scan covers ${SCANNED_PORTS} ` +
      'across the whole machine, so an app on any other port is invisible to it.'
    );
  }
  return (
    `Something is listening on port ${listening.join(', ')}, but I cannot attribute any of it to ` +
    `this project: that is a machine-wide scan of ${SCANNED_PORTS}, so on a machine running more ` +
    "than one repo those are as likely to be somebody else's dev server, and the app's own port " +
    'may not be in the set at all. Treat them as unattributed rather than as evidence.'
  );
}

/**
 * The mismatch, stated with both numbers, when we can actually see one. Empty otherwise.
 *
 * Leading space so the caller can concatenate it unconditionally without producing a double space
 * in the common case where there is nothing to say.
 */
function portMismatchClause(facts: NoSessionFacts): string {
  const configured = facts.projectPort;
  if (configured === undefined || configured === facts.port) return '';
  return (
    ` They already disagree: \`.reticle.json\` says port ${String(configured)} and this daemon is` +
    ` on ${String(facts.port)}, so the SDK is dialling ${String(configured)} and nothing is there.` +
    ` Either restart the daemon on ${String(configured)}, or update \`.reticle.json\` to` +
    ` ${String(facts.port)} and restart the dev server so the app picks it up.`
  );
}

/**
 * A listener on a well-known Reticle port we did not bind. Observation, not a cause.
 *
 * Leading space so the caller can concatenate it unconditionally. Empty when there is nothing to
 * say, including when the occupied sibling is already the configured-port mismatch — that sentence
 * already named both numbers, and repeating 4460 as a second "cause" would overclaim.
 */
function siblingListenerClause(facts: NoSessionFacts): string {
  const occupied = facts.siblingListeners ?? [];
  if (0 === occupied.length) return '';
  const mismatch = facts.projectPort;
  const extra =
    mismatch !== undefined && mismatch !== facts.port
      ? occupied.filter((port) => port !== mismatch)
      : occupied;
  const note = siblingListenerNote(facts.port, extra);
  return note === undefined ? '' : ` ${note}`;
}

/**
 * The tail every "the app is wired and silent" branch ends with, ranked.
 *
 * One place, because the ranking is the whole fix: a hint that lists "no server", "no SDK" and
 * "no tab" at equal weight is a hint the reader has to rank itself, with strictly less evidence
 * than the daemon has.
 */
function rankedCauses(facts: NoSessionFacts): string {
  const nuxt = facts.framework?.toLowerCase() === NUXT ? `${NUXT_STALE_BUNDLE} ` : '';
  return (
    `${nuxt}${REAL_CAUSES} If none of those, the app may be dialling a different daemon than this ` +
    `one (on ${String(facts.port)}): check the app's reticle port matches ` +
    `${String(facts.port)}.${portMismatchClause(facts)}${siblingListenerClause(facts)} ${NON_LOCALHOST_GATE}`
  );
}

/**
 * The scope answer, when the config was somewhere else all along.
 *
 * This OUTRANKS every "you may have no SDK" sentence in this file, because it is positive evidence:
 * a `.reticle.json` in `apps/web` means that app has been through `init` whatever the daemon's own
 * directory looks like. Naming the directories rather than adopting one is deliberate — several
 * configs means several projects, and choosing silently is how an agent gets a confident verdict
 * about an app it never touched.
 */
function configsElsewhereClause(facts: NoSessionFacts): string {
  const configs = facts.configsElsewhere ?? [];
  if (0 === configs.length) return '';
  const named = configs
    .map((c) => (c.projectId === undefined ? c.directory : `${c.directory} ('${c.projectId}')`))
    .join(', ');
  return (
    `A \`.reticle.json\` WAS found outside this daemon's directory: ${named}. So the app is wired ` +
    'and this is a SCOPE problem, not an install problem — this daemon was started somewhere that ' +
    'is not the project, which is the normal outcome when an editor launches it from your home ' +
    "directory. Restart the daemon from the app's directory (or point it there) rather than " +
    'installing anything.'
  );
}

/** Where we looked, when we found nothing. An absence nobody can check is not evidence. */
function searchedClause(facts: NoSessionFacts): string {
  const searched = facts.searchedDirectories ?? [];
  if (0 === searched.length) return '';
  if ((facts.configsElsewhere ?? []).length > 0) return '';
  return ` I looked in: ${searched.join(', ')}. If your app is not in that list, that is the answer — this daemon is standing somewhere else.`;
}

/**
 * A leading sentence when the daemon has been up long enough that no app is coming.
 *
 * Only fires for a WIRED project (initialized) that has NEVER connected and is past the
 * threshold. An unwired project already names the install gap as its primary cause; adding a time
 * sentence there would double-blame.
 */
function stallClause(facts: NoSessionFacts): string {
  const { daemonUpMs, initialized, everConnected } = facts;
  if (everConnected) return '';
  if (!initialized) return '';
  if (daemonUpMs === undefined || daemonUpMs < STALL_AFTER_MS) return '';
  const minutes = Math.round(daemonUpMs / 60_000);
  return (
    `This daemon has been running for ${String(minutes)} minutes and no app has connected. ` +
    'The most likely cause is that the dev server was not restarted after adding the Reticle ' +
    'plugin, so the running bundle carries no SDK. Restart the dev server first. '
  );
}

function alreadyListeningClause(listening: readonly number[]): string {
  if (0 === listening.length) return '';
  if (1 === listening.length) {
    const port = listening[0];
    return (
      ` An app is already listening on ${String(port)}; just open http://localhost:${String(port)} ` +
      '— do not start a second stack.'
    );
  }
  return (
    ` An app is already listening on ${listening.join(', ')}; just open one of those URLs — do not ` +
    'start a second stack.'
  );
}

/**
 * The diagnosis, and the CODE for the branch that produced it.
 *
 * The prose has always been well-ranked and it was the only output, so the population that installs
 * Reticle and never gets an app connected arrived as one undifferentiated silence. "Restarted the
 * dev server and it still did not connect" and "never started the app" need opposite fixes and were
 * the same absence (#615).
 *
 * One function returning both, rather than a classifier beside the writer. A reason computed
 * separately would drift from the sentence the user is actually shown, and then the metric would
 * describe a diagnosis nobody received.
 */
export function explainNoSession(facts: NoSessionFacts): {
  reason: NoSessionReason;
  message: string;
} {
  const { everConnected, initialized, listening, port } = facts;
  // Named when known: a claim about a missing file is a claim about ONE directory.
  const where =
    facts.directory === undefined
      ? 'the directory this daemon is running in'
      : `the directory this daemon is running in (${facts.directory})`;

  if (everConnected) {
    // A reaped lease first, because it is the one cause we have POSITIVE evidence for. Reported
    // from the field (#157): an aged-out lease produced "the tab was closed … ask the human to
    // reopen the app", which is wrong on every clause — there is no human tab, and the recovery it
    // names is unavailable to the caller while the one that works goes unmentioned. The reporter
    // went looking for a port mismatch.
    //
    // The hedge that used to close this branch ("if you were driving a human tab instead…") is
    // gone with the reason for it. `leaseExpired` was a lifetime count of reaps, so it could not
    // tell which session went and had to cover both; it now names the session that actually
    // departed (#611), so this branch is only reached when the thing that vanished WAS the lease.
    if (true === facts.leaseExpired) {
      return reason(
        NoSessionReason.LEASE_EXPIRED,
        'no browser session connected, but one WAS connected to this daemon earlier, so the wiring ' +
          'is correct. The session that went away was a pooled lease and it aged out; a lease is a ' +
          'headless context, not a human tab, and it takes its cookies with it (so an authenticated ' +
          'app needs signing in again). Re-acquire with reticle_lease {action:"acquire", url} and ' +
          `carry on.${alreadyListeningClause(listening)} ${RETRY}`,
      );
    }
    return reason(
      NoSessionReason.TAB_GONE,
      'no browser session connected, but one WAS connected to this daemon earlier, so the wiring ' +
        'is correct. The tab was closed, navigated away, or hard-reloaded. Ask the human to reopen ' +
        `the app (or run ${OPEN_CMD_BARE}), or reload the tab.${alreadyListeningClause(listening)} ` +
        `${leaseAdvice(SELF_SERVE, facts)} ${RETRY}`,
    );
  }

  // Ranked ahead of every "we have never seen one" branch below, because it is the one fact that
  // OUTRANKS them: those branches all reason from an absence, and this reasons from a recorded
  // connection. It is also the branch that stops the daemon contradicting itself — a hint that the
  // wiring is unproven, printed by a daemon holding proof that it is.
  if (true === facts.previouslyConnected) {
    const listeners =
      0 === listening.length
        ? `${unattributedListeners(listening)} If the dev server is not running, start it first ` +
          '(the command is in `next_action`).'
        : unattributedListeners(listening);
    return reason(
      NoSessionReason.APP_NOT_REOPENED,
      `${RESTARTED_LEAD} ${OPEN_THE_APP} ${listeners} ${rankedCauses(facts)} ${leaseAdvice(SELF_SERVE, facts)} ${RETRY}`,
    );
  }

  // A config found elsewhere outranks every "you may have no SDK" branch below: those reason from
  // an absence in ONE directory, and this is a file we read in another. Ranked here so the reader is
  // never sent through an install on a project that has demonstrably been installed.
  if (!initialized && (facts.configsElsewhere ?? []).length > 0) {
    return reason(
      NoSessionReason.CONFIG_ELSEWHERE,
      'no browser session connected, and this daemon has never seen one. ' +
        `${configsElsewhereClause(facts)} ${unattributedListeners(listening)} ${OPEN_THE_APP} ` +
        `${rankedCauses(facts)} ${leaseAdvice(SELF_SERVE, facts)} ${RETRY}`,
    );
  }

  if (0 === listening.length) {
    // Lead with the stronger EVIDENCE, and do not overstate what it is.
    //
    // `initialized` is one thing only: whether a `.reticle.json` sits in the directory this daemon
    // is running in. It is NOT "this project has never been through `reticle init`", and the two
    // come apart constantly — a monorepo whose daemon runs at the root while the app lives in
    // `apps/web`, or any app wired by the babel/vite plugin rather than by `init`. An earlier
    // version of this branch asserted the strong claim and led with it, on the reasoning that it was
    // a certainty while the port scan was a guess. It is not a certainty. Caught driving Reticle's
    // OWN repo, where the message told an agent the project had never been through `init` about a
    // fixture that is instrumented and working — "the one sentence I was most likely to act on was
    // wrong", which is the exact failure this whole file exists to prevent.
    //
    // So: report what was actually checked, name the directory, and name the case where the absence
    // is expected rather than diagnostic.
    if (!initialized) {
      return reason(
        NoSessionReason.NO_LISTENER_NO_CONFIG,
        'no browser session connected. Two things to weigh, and neither of them is proof. ' +
          `(1) ${slowListenerClause(facts)}Nothing is listening on the ports Reticle scans (${SCANNED_PORTS}), so the dev server ` +
          'may not be running — START IT YOURSELF, in the background, using the command in ' +
          "`next_action` (it is read from this project's own scripts; if there is none, that field " +
          'says so and you should ask rather than guess). Tell the human in one line that it is ' +
          'running. That scan is narrow ' +
          'though: a server on any other port is invisible to it, so if the app IS running, ask for ' +
          `its URL rather than assuming it is down, and open it with ${OPEN_CMD}. ` +
          `(2) There is no \`.reticle.json\` in ${where}. That is the ` +
          `file ${INIT_CMD} writes, so the app may carry no Reticle SDK — but check the app's ` +
          'OWN directory before re-running `init`: in a monorepo the daemon often runs at the root ' +
          'while the app lives in a subdirectory, and an app wired by the Vite or Babel plugin ' +
          `carries the SDK without that file at all.${searchedClause(facts)}${siblingListenerClause(facts)} ${leaseAdvice(URL_THEN_LEASE, facts)} ${RETRY}`,
      );
    }
    return reason(
      NoSessionReason.NO_LISTENER,
      `${stallClause(facts)}no browser session connected, and this daemon has never seen one. ${OPEN_THE_APP} ` +
        'Nothing is listening on the ports Reticle scans ' +
        `(${SCANNED_PORTS}) either, and the most common reason for that is a dev server that is not ` +
        'running: start it yourself in the background with the command in `next_action` — it is read ' +
        "from this project's own scripts, and says so rather than guessing when there is none — tell " +
        'the human in one line that it is running, then open the app in a browser. ' +
        // The caveat is here rather than omitted because the scan is NARROW, and the old sentence
        // spent its confidence as though an empty result were proof of absence. Reported twice: a
        // scripted drive of 2.5.0 asserted the app was not running while it served 200 on :7699, and
        // an agent was told nothing was listening while a dev server answered on :5000 under a custom
        // hostname. The common defaults have since been added to the scanned set, which narrows the
        // gap and cannot close it — anything passed to `--port` is still invisible.
        'That scan is narrow, so it is not proof: a server on any other port is invisible to it. If ' +
        // Deliberately NOT offering reticle_lease here, and a test pins that: a lease opens a URL, and
        // if nothing is listening there is nothing at any URL to open. Asking for the real one is the
        // only move that can recover the :7699 case.
        `the app IS running, ask the human for its URL rather than assuming it is down. ${leaseAdvice(URL_THEN_LEASE, facts)}` +
        `${siblingListenerClause(facts)} ${RETRY}`,
    );
  }

  if (!initialized) {
    return reason(
      NoSessionReason.NO_CONFIG,
      'no browser session connected, and this daemon has never seen one. ' +
        `What was actually checked: there is no \`.reticle.json\` in ${where}. That is the file ` +
        `${INIT_CMD} writes, so the app may carry no Reticle SDK — but it is not proof, and the ` +
        'same absence is expected in a monorepo whose daemon runs at the root while the app lives in ' +
        "a subdirectory, or in an app wired by the Vite or Babel plugin. Check the app's OWN " +
        `directory: if it has no config, run ${INIT_CMD} there and restart the dev server; if it ` +
        `has one, the app is wired and simply has no page open — ${OPEN_CMD}. ` +
        `${unattributedListeners(listening)}${searchedClause(facts)}${siblingListenerClause(facts)} ${RETRY}`,
    );
  }

  return reason(
    NoSessionReason.SDK_NOT_REACHING_DAEMON,
    `${stallClause(facts)}no browser session connected, and this daemon has never seen one for this project, which is ` +
      `wired for Reticle. ${OPEN_THE_APP} ${unattributedListeners(listening)} ` +
      'If the page IS open and still does not appear, the app is wired and the SDK is not reaching ' +
      `this daemon (on ${String(port)}). ${rankedCauses(facts)} ${leaseAdvice(SELF_SERVE, facts)} ${RETRY}`,
  );
}

/** Pair a branch's verdict with its prose, so neither can be produced without the other. */
function reason(
  code: NoSessionReason,
  message: string,
): { reason: NoSessionReason; message: string } {
  return { reason: code, message };
}

/**
 * The message alone, for the callers that render it.
 *
 * Kept as the narrow surface it always was: most callers want the sentence, and handing them the
 * pair would spread a telemetry concern across every error path that shows a user this text.
 */
export function diagnoseNoSession(facts: NoSessionFacts): string {
  return explainNoSession(facts).message;
}
