/**
 * Telling the agent that a newer Reticle exists.
 *
 * Until now nothing did. `checkForUpdate` had exactly one caller — the `reticle update` command — so
 * a published release was invisible to every install until a human happened to type that command,
 * which in practice meant never. A fix could ship and sit unused for months on the machines that hit
 * the bug it fixed.
 *
 * The nudge rides the tool-result envelope rather than being a tool of its own, for the same reason
 * the session-health and pool-lease reminders do: the agent is mid-task, and something it has to go
 * and ASK for is something it will not ask for. Delivered ONCE per daemon process — a repeated
 * "please update" during someone's work is noise, and noise is what gets filtered out.
 *
 * It deliberately does NOT update anything by itself. A silent self-install would swap the binary
 * under a running session, restart the daemon, and drop every agent attached to it — during work the
 * human never agreed to interrupt. So the envelope carries the fact and the exact command, and the
 * decision stays with the people whose machine it is.
 */
import { checkForUpdate, loadManifest } from './update-checker.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { log } from '../log.js';
import { creditNudge } from './nudge-credit.js';

/**
 * Is `candidate` a strictly NEWER release than `current`?
 *
 * Replaces a plain `!==`, which told anyone on a version newer than the published one — a
 * prerelease, a local build, a rollback in progress — to "update" to something older. A nudge that
 * prompts a downgrade is one people learn to ignore, and this is the mechanism the entire adoption
 * story rests on. Numeric per segment, so 2.10.0 correctly beats 2.9.0 (string order does not), and
 * a bare release beats its own prerelease.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): { parts: number[]; pre: boolean } => {
    const [core = '', ...rest] = v.split(/[-+]/);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: rest.length > 0 };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left > right;
  }
  // Same numbers: a final release is newer than its own prerelease, and nothing else counts.
  return !a.pre && b.pre;
}

/** Let the daemon finish coming up before touching the network. */
const CHECK_DELAY_MS = 8_000;

interface UpdateNudge {
  /** The version available, so the agent can tell the human what they would be moving to. */
  latestVersion: string;
  currentVersion: string;
  /** The exact command. Spelled out so the agent never has to guess or invent one. */
  command: string;
  action: string;
}

const UPDATE_COMMAND = 'reticle update';

let pending: UpdateNudge | undefined;
let delivered = false;

/**
 * Kick off a background check. Non-blocking and best-effort: `checkForUpdate` never throws, caches
 * for 24h on disk, and falls back to the cached manifest when the registry is unreachable — so this
 * costs one npm registry request per day per machine, and nothing at all when offline.
 */
/** How much of the release description may ride on a tool result. See buildNudge. */
const MAX_CHANGELOG_CHARS = 240;
const MAX_LISTED_BREAKING = 4;

/**
 * Describe the release, not just its number.
 *
 * `packages/server/package.json` carries `reticle.changelog` and `reticle.breakingChanges`, and
 * `update-checker` parses both into the manifest — where they stopped. This function named two
 * versions and nothing else, so both fields were written, shipped, parsed and discarded. Latent
 * metadata nobody ever printed.
 *
 * Survivable while releases are additive; actively harmful for one that is not. An agent told only
 * "2.4.1 → 2.5.0" runs `reticle update` mid-task and discovers a retired environment variable and
 * six newly-strict parameters by breaking on them.
 *
 * Bounded on purpose: this rides on a tool result every turn until it is delivered, so a long
 * changelog is a per-turn tax. The count of anything elided is stated rather than silently dropped.
 *
 * It also names what `update` does to the RULE FILES, which is the half nobody would guess. A new
 * release changes what the always-loaded instructions should say — that is the whole reason
 * `refreshAgentRules` exists — and an agent that reads "it restarts the daemon" has no reason to
 * think its CLAUDE.md is now a release behind. Saying so costs one clause on a message that is
 * delivered once per daemon, and it is the difference between a fleet that upgrades its rules and
 * one that upgrades its binary and keeps last release's instructions forever.
 */
export function buildNudge(
  latestVersion: string,
  currentVersion: string,
  release?: { changelog?: string; breakingChanges?: string[] },
): UpdateNudge {
  const changelog = (release?.changelog ?? '').trim();
  const breaking = (release?.breakingChanges ?? []).filter((line) => 0 < line.trim().length);
  const listed = breaking.slice(0, MAX_LISTED_BREAKING);
  const rest = breaking.length - listed.length;
  return {
    currentVersion,
    latestVersion,
    command: UPDATE_COMMAND,
    action:
      `A newer Reticle is available (${currentVersion} → ${latestVersion}). ` +
      ('' === changelog ? '' : `${changelog.slice(0, MAX_CHANGELOG_CHARS)} `) +
      (0 === breaking.length
        ? ''
        : `This release has BREAKING changes: ${listed.join('; ')}` +
          (0 < rest ? ` (+${String(rest)} more — see the changelog)` : '') +
          '. Read them before updating. ') +
      `Tell the human, and run \`${UPDATE_COMMAND}\` if they agree — it upgrades the packages, ` +
      "refreshes the Reticle rules in this project's CLAUDE.md / AGENTS.md, and restarts the " +
      'daemon, so do it between tasks rather than mid-verification. Continue your current task ' +
      'first.',
  };
}

export function startUpdateCheck(now: () => number = () => Date.now()): void {
  // The cached answer first, so the very first tool call can carry it — see armUpdateNudgeFrom.
  armUpdateNudgeFrom(loadManifest());
  setTimeout(() => {
    void checkForUpdate(SERVER_VERSION, now)
      .then((manifest) => {
        if (!manifest.updateAvailable || manifest.latestVersion === undefined) return;
        if (!isNewerVersion(manifest.latestVersion, SERVER_VERSION)) return;
        // WITH the release description. The manifest has carried `changelog` and `breakingChanges`
        // all along; nothing read them.
        pending = buildNudge(manifest.latestVersion, SERVER_VERSION, {
          ...(manifest.changelog === undefined ? {} : { changelog: manifest.changelog }),
          ...(manifest.breakingChanges === undefined
            ? {}
            : { breakingChanges: manifest.breakingChanges }),
        });
        delivered = false;
        log('reticle_update_available', {
          from: SERVER_VERSION,
          to: manifest.latestVersion,
        });
      })
      .catch(() => {
        /* a version check must never surface to a user */
      });
  }, CHECK_DELAY_MS).unref();
}

/**
 * What `reticle update` should install, or undefined when it should do nothing.
 *
 * `handleUpdate` gated on `manifest.updateAvailable`, a plain `latest !== current`, so whenever the
 * registry's latest was OLDER than the running build — a prerelease, a local build, a rollback in
 * progress, a stale npx cache — it announced the move and then installed the downgrade. Reported by
 * a real user on 2026-08-06: "both the `update_available` banner and `reticle update` report the
 * current and target versions swapped, so an upgrade is described as a downgrade."
 */
export function updateTarget(
  manifest: { updateAvailable?: boolean; latestVersion?: string },
  currentVersion: string = SERVER_VERSION,
): string | undefined {
  const latest = manifest.latestVersion;
  if (latest === undefined || !isNewerVersion(latest, currentVersion)) return undefined;
  return latest;
}

/**
 * Arm from an already-cached answer, synchronously, at daemon boot.
 *
 * The network check fires 8s after boot and the nudge is delivered by riding a tool result — but
 * half the sessions that use Reticle at all make exactly ONE tool call, usually in the first
 * seconds. The check had not finished, so the single chance to tell them was gone, and the
 * population most in need of the update is precisely the one that never heard about it. Yesterday's
 * answer is already on disk; use it now and let the network refresh behind it.
 */
export function armUpdateNudgeFrom(
  cached: {
    latestVersion?: string;
    updateAvailable?: boolean;
    changelog?: string;
    breakingChanges?: string[];
  } | null,
  currentVersion: string = SERVER_VERSION,
): void {
  const latest = cached?.latestVersion;
  if (latest === undefined || !isNewerVersion(latest, currentVersion)) return;
  // The CACHED path matters more than the live one: it is what the very first tool call carries, and
  // it is the only nudge an offline machine ever sees. Dropping the release description here would
  // have left the fields unread on the commonest path while looking fixed.
  pending = buildNudge(latest, currentVersion, {
    ...(cached?.changelog === undefined ? {} : { changelog: cached.changelog }),
    ...(cached?.breakingChanges === undefined ? {} : { breakingChanges: cached.breakingChanges }),
  });
  delivered = false;
}

/** The nudge, once. Returns undefined afterwards so a long session is told exactly one time. */
export function takeUpdateNudge(): UpdateNudge | undefined {
  if (delivered || pending === undefined) return undefined;
  delivered = true;
  // Leave a mark an `reticle update` in another process can read, so version_changed can say whether
  // this nudge is what caused the upgrade. Best-effort by construction — see nudge-credit.
  creditNudge(pending.latestVersion);
  return pending;
}

/**
 * The newer version, if the cached answer says there is one — WITHOUT consuming the agent's
 * one-shot nudge. `reticle status` is a human reading a terminal; the two channels are separate
 * audiences and must not steal each other's message.
 */
export function availableUpdate(currentVersion: string = SERVER_VERSION): string | undefined {
  const latest = loadManifest()?.latestVersion;
  return latest !== undefined && isNewerVersion(latest, currentVersion) ? latest : undefined;
}

/**
 * What the nudge did this daemon run, for the session summary.
 *
 * The nudge has shipped for several releases and emitted nothing, so "did the agent get told about
 * a release, and did anything happen" was unanswerable — and it is the whole adoption mechanism for
 * a published fix. `versionChange.nudged` is the half that only ever arrives from machines that DID
 * update; the pinned cohort never fires `version_changed` at all.
 *
 * Reads the same module state the delivery path uses rather than adding a counter beside it, so the
 * two cannot disagree. `shown` is the one-shot delivery flag: it means "an agent was told", never
 * how often. `offered` is present whenever a newer release was known, whether or not it was
 * delivered — without it, `shown: false` would mean "nothing was available" and "something was and
 * the nudge did not fire" at the same time, and only one of those is a defect.
 */
export function updateNudgeState(): { shown: boolean; offered?: string } {
  return {
    shown: delivered,
    ...(pending === undefined ? {} : { offered: pending.latestVersion }),
  };
}

/** Tests only — drop the module state so each case starts clean. */
export function resetUpdateNudge(): void {
  pending = undefined;
  delivered = false;
}
