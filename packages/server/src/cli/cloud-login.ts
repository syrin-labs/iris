/**
 * `reticle login` and `reticle logout` — getting a session onto this machine, and off it.
 *
 * Split from `cloud-cli` because this is a coherent story on its own: prove who you are, write the
 * token where the other verbs will find it, and finish the job by binding the repo you are standing
 * in. The rest of the CLI reads sessions; only this file creates and destroys them.
 *
 * `cmdLink` arrives as a PARAMETER rather than an import. Login ends by linking and link needs a
 * session, so the two genuinely depend on each other; passing the linker in breaks the cycle at the
 * one call site instead of merging two commands into one file to satisfy the module graph.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNodeFileSystem } from '../project/fs-port.js';
import { CLOUD_LINK_FILE } from '../cloud/cloud-config.js';
import { RETICLE_CONFIG_BASENAME } from './cli-port.js';
import { DevicePollSchema, DeviceStartSchema, openBrowser } from './device-flow.js';
import { normalizeUrl, sessionPath, SESSIONS_DIR } from './cloud-session.js';
import {
  api,
  baseUrl,
  emit,
  err,
  flags,
  hint,
  home,
  readSession,
  RETICLE_DIR,
  SESSION_FILE,
} from './cloud-kit.js';

/** Run `reticle link` with these arguments. Injected; see the note at the top of this file. */
type Linker = (argv: readonly string[]) => Promise<number>;

const LoginSchema = z.object({
  token: z.string(),
  org: z.object({ id: z.string().optional(), name: z.string() }),
});

/**
 * `reticle login --email <e> [--org <name>] [--code <123456>]` — sign in, cache the token under
 * ~/.reticle.
 *
 * TWO STEPS, because the cloud proves you own the inbox before it hands out a session: ask for a code,
 * then exchange it. (It used to take an email alone — which meant anyone who knew your address owned your
 * org.) `--org` is only consulted when the account is brand new; a returning user never needs it.
 *
 * Without `--code` we request one and stop, telling the user to re-run with it. The one exception is a
 * LOCAL cloud, whose dev mailer cannot actually deliver mail and so echoes the code back in its response
 * (`devCode`) — there we complete the login in a single command rather than asking a developer to read a
 * code out of a server log they may not even be tailing.
 */
const RequestCodeSchema = z.object({ devCode: z.string().optional() });

/** Persist a session token under ~/.reticle and print the next step. Shared by both login paths. */
const writeSession = async (
  url: string,
  token: string,
  orgName: string,
  orgId: string | undefined,
  project: string | undefined,
  link: Linker,
): Promise<void> => {
  await mkdir(join(home(), SESSIONS_DIR), { recursive: true });
  const body = `${JSON.stringify(
    { url: normalizeUrl(url), token, orgName, ...(orgId === undefined ? {} : { orgId }) },
    null,
    2,
  )}\n`;
  // Both, on purpose. The per-host file is what lets another environment stay logged in; the active
  // file is what a bare command with no override resolves through, and keeping it means nothing
  // about the single-environment workflow changes.
  await writeFile(sessionPath(home(), url), body);
  await writeFile(join(home(), SESSION_FILE), body);
  emit({ loggedIn: orgName, session: join(home(), SESSION_FILE) });
  await linkAfterLogin(url, project, link);
};

/**
 * Finish the job when the shell is already standing in an unlinked Reticle project.
 *
 * `login` used to end by printing "next: `reticle link`", which made getting from local-only to
 * reporting a TWO command trip whose second half nothing enforces — and the HUD's own invitation
 * names one command, so the gap was ours to close rather than the reader's to notice. Somebody who
 * ran `reticle login` inside their instrumented repo wanted their runs on the dashboard; there is no
 * second thing they could have meant.
 *
 * Deliberately narrow, because a login that writes files in a directory the user did not mean is
 * worse than an extra step:
 *   - a `.reticle.json` must already exist. That is what `init` writes and what puts a projectId in
 *     the app's BUNDLE, which is the only thing letting the daemon attribute runs to this repo. A
 *     bare `.reticle/` directory is NOT the marker: gating on it produced repos that were linked and
 *     structurally unable to report, whose runs pooled under the daemon's own root instead.
 *   - an existing `cloud.json` is left completely alone. Re-linking would re-resolve the project and
 *     is exactly how somebody re-pointing an environment loses a binding they meant to keep.
 *   - a failure is reported and swallowed. The login SUCCEEDED and its token is already on disk;
 *     turning that into a non-zero exit would make the recoverable half look like the broken one.
 */
const linkAfterLogin = async (
  url: string,
  project: string | undefined,
  link: Linker,
): Promise<void> => {
  const fs = createNodeFileSystem();
  /*
   * The marker is `.reticle.json`, NOT a `.reticle/` directory.
   *
   * `.reticle.json` is what `init` writes and what puts a projectId in the app's bundle, which is
   * the only thing that lets the daemon attribute a session's runs to this repo. A bare `.reticle/`
   * proves nothing — it is also created by artifacts and by older builds — and auto-linking on it
   * produced a repo that was LINKED to a cloud project and yet unable to report to it: runs pooled
   * into the daemon's own ledger, and `reticle sync` here answered "nothing to send" straight after
   * two verdicts had been recorded. Measured, on this very repo's bench app.
   */
  if (!(await fs.exists(join(process.cwd(), RETICLE_CONFIG_BASENAME)))) {
    hint(
      'next: `reticle init` here first, then `reticle link` — or log in from a project directory',
    );
    return;
  }
  /*
   * An explicit `--project` is an instruction, so it re-binds even a repo that is already linked.
   * Without a project named, an existing binding is left completely alone — re-resolving it is how
   * somebody repointing an environment loses a binding they meant to keep.
   */
  if (
    project === undefined &&
    (await fs.exists(join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE)))
  ) {
    hint('this repo is already linked — `reticle push` to send what it has recorded');
    return;
  }
  try {
    await link(project === undefined ? ['--url', url] : ['--url', url, '--project', project]);
  } catch {
    hint('signed in, but linking this repo failed — run `reticle link` to retry');
  }
};

/**
 * Browser device flow — the DEFAULT `reticle login` (like `gh auth login`): fetch a device + user code,
 * open the browser to approve, then poll until the user confirms. No email to type, no code to copy back.
 */
const cmdLoginDevice = async (
  explicitUrl: string | undefined,
  project: string | undefined,
  link: Linker,
): Promise<number> => {
  const url = baseUrl(null, explicitUrl);
  const started = DeviceStartSchema.parse(
    await api('POST', `${url}/v1/auth/device/start`, null, {}),
  );
  hint(
    `Opening ${started.verificationUri} — confirm this code in the browser: ${started.userCode}`,
  );
  openBrowser(started.verificationUriComplete);
  const intervalMs = Math.max(1, started.interval) * 1000;
  for (;;) {
    await sleep(intervalMs);
    const poll = DevicePollSchema.parse(
      await api('POST', `${url}/v1/auth/device/token`, null, { deviceCode: started.deviceCode }),
    );
    if ('approved' === poll.status && poll.token !== undefined && poll.org !== undefined) {
      await writeSession(url, poll.token, poll.org.name, poll.org.id, project, link);
      return 0;
    }
    if ('pending' === poll.status) {
      if (Date.now() > started.expiresAt) {
        err('device login expired — run `reticle login` again');
        return 1;
      }
      continue;
    }
    err(
      'denied' === poll.status
        ? 'device login was denied in the browser'
        : 'device login expired — run `reticle login` again',
    );
    return 1;
  }
};

/**
 * `reticle login` — browser device flow by default; `--email <e>` (or a positional email) keeps the
 * headless two-step code path for CI/servers where opening a browser makes no sense.
 */
export const cmdLogin = async (argv: readonly string[], link: Linker): Promise<number> => {
  const f = flags(argv);
  const positional = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined;
  const email = f['email'] ?? positional;
  if (email === undefined) return cmdLoginDevice(f['url'], f['project'], link);
  const org = f['org'];
  const url = baseUrl(null, f['url']);

  let code = f['code'];
  if (code === undefined) {
    const requested = RequestCodeSchema.parse(
      await api('POST', `${url}/v1/auth/request-code`, null, {
        email,
        ...(org !== undefined ? { orgName: org } : {}),
      }),
    );
    // A real cloud mails the code and never echoes it; a local one cannot mail, so it hands it back.
    if (requested.devCode === undefined) {
      emit({ codeSent: true, to: email });
      hint(`check your inbox, then: \`reticle login --email ${email} --code <the 6-digit code>\``);
      return 0;
    }
    code = requested.devCode;
  }

  const parsed = LoginSchema.parse(
    await api('POST', `${url}/v1/auth/login`, null, { email, code }),
  );
  await writeSession(url, parsed.token, parsed.org.name, parsed.org.id, f['project'], link);
  return 0;
};

/** `reticle logout` — forget the cached session token (per-project keys under credentials.json stay). */
/**
 * `reticle logout` — sign out of ONE host, not of everywhere.
 *
 * Which host is the same question every other verb asks: `--url`, else the environment, else the
 * active session. Signing out of staging must leave production alone — a logout that quietly
 * cleared every environment would be discovered at the worst possible moment, mid-incident, on the
 * one you did not mean.
 */
export const cmdLogout = async (argv: readonly string[] = []): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active, flags(argv)['url']);
  await rm(sessionPath(home(), url), { force: true }).catch(() => undefined);
  // The active pointer only moves if it was pointing at the host just signed out of.
  if (null !== active && normalizeUrl(active.url) === url)
    await writeFile(join(home(), SESSION_FILE), '').catch(() => undefined);
  emit({ loggedOut: true, url });
  return 0;
};
