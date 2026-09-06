/**
 * Cloud subcommands for the `reticle` CLI — the user/agent door to the hosted service, folded into the ONE
 * tool (was the standalone `reticle-cloud` bootstrap script). These are THIN clients over the `/v1` API:
 * the moat is the server, not these verbs, and OSS reticle already ships the cloud-sync client — this just
 * surfaces it. Creds live under `~/.reticle`: `session.json` (human token from `reticle login`) and
 * `credentials.json` (per-project api keys from `reticle link`). The non-secret repo binding + sync policy
 * is `<repo>/.reticle/cloud.json`. Auth for a command = `RETICLE_CLOUD_KEY` env (agent) OR the login token.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { createNodeFileSystem } from '../project/fs-port.js';
import { CLOUD_LINK_FILE, resolveProjectCloud } from '../cloud/cloud-config.js';
import { applyCredential, findCredential } from './cloud-keystore.js';
import { defaultProjectFor } from './project-name.js';
import { RETICLE_CONFIG_BASENAME } from './cli-port.js';
import { normalizeUrl } from './cloud-session.js';
import { cmdLogin, cmdLogout } from './cloud-login.js';
import {
  api,
  baseUrl,
  bearer,
  CREDENTIALS_FILE,
  emit,
  err,
  flags,
  hint,
  home,
  readJson,
  readSession,
  readSessionFor,
  RETICLE_DIR,
} from './cloud-kit.js';
import { describeSync, runSyncCycle } from '../cloud/sync-cycle.js';
import { diskSink, diskSource, readCloudIssues, readCloudState } from '../cloud/sync-disk.js';

/**
 * Where `reticle login` dials when nothing says otherwise: the hosted service.
 *
 * This is the same origin as the dashboard — the API serves the built console — so there is one
 * host for a user to know and one for us to configure.
 *
 * It used to be `http://localhost:8890`, which is correct for exactly one audience: whoever is
 * developing the service itself. Every other user — the entire point of publishing the package —
 * typed `reticle login` and got a connection refused against a port on their own machine, which
 * reads as "the cloud is down", not "you are dialling the wrong host". Developing against a local
 * API is now what needs saying out loud, via RETICLE_CLOUD_URL, because that is the rarer case.
 */
/**
 * One session file per host, so more than one environment can be logged in at once.
 *
 * `session.json` stays what it always was — the ACTIVE login, and the thing a bare command with no
 * override resolves through. This directory is what makes staging and production hold at the same
 * time instead of clobbering each other, which is the whole reason a single file was not enough.
 */
const CLOUD_COMMANDS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'whoami',
  'link',
  'project',
  'config',
  'issues',
  'memory',
  'push',
  'sync',
  'runs',
  'regression',
  'share',
]);
export const isCloudCommand = (cmd: string | undefined): boolean =>
  cmd !== undefined && CLOUD_COMMANDS.has(cmd);

/** `reticle sync --watch` — keep cycling instead of exiting. */
const WATCH_FLAG = '--watch';

/**
 * How often `--watch` cycles.
 *
 * A minute is chosen against what a cycle COSTS, not against how fresh anybody needs the dashboard:
 * an unchanged session sends one small GET and nothing else, so a minute is cheap enough that nobody
 * turns it off — and a sync people turn off is the only kind that actually loses data.
 */
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

/**
 * How a key is named out loud: enough to match it against the dashboard, never enough to use.
 *
 * The same shape the console shows (`displayPrefix`), so the two surfaces name one key identically
 * and somebody can tell at a glance which row this repo is using.
 */
const KEY_HINT_CHARS = 16;
const keyHint = (key: string): string =>
  key.length <= KEY_HINT_CHARS ? key : `${key.slice(0, KEY_HINT_CHARS)}…`;

/**
 * The api key this machine already holds for a project ON THIS CLOUD, if any.
 *
 * Two shapes, matching the resolver: `{ key, url }` is what `link` writes now and is only returned
 * when the URL matches, and a bare string is the legacy shape with no URL to check. Without the URL
 * check this would happily reuse a production key for a self-hosted link, because `link` names
 * every project "default" and the two collide in one slot.
 */
const storedCredential = async (
  projectId: string,
  url: string,
  orgId: string | undefined,
): Promise<string | undefined> =>
  findCredential(await readJson(join(home(), CREDENTIALS_FILE)), projectId, url, orgId);

/**
 * What a key is good for, or undefined when the cloud will not accept it.
 *
 * Never throws: a revoked key, a rotated one and an unreachable cloud are all "cannot reuse this",
 * and the caller's answer to every one of them is the same — mint a fresh one.
 */
const validateKey = async (
  url: string,
  key: string,
): Promise<z.infer<typeof WhoamiSchema> | undefined> => {
  try {
    return WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, key));
  } catch {
    return undefined;
  }
};

const KeySchema = z.object({ projectId: z.string(), projectName: z.string(), key: z.string() });
const WhoamiSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /**
   * Which tenant the key belongs to. Optional for the same reason `dashboardUrl` is — an older
   * cloud does not send it — and when it is missing a stored key cannot be proved to be ours, which
   * is why the reuse path below mints instead of guessing.
   */
  orgId: z.string().optional(),
  /**
   * Where this project's dashboard lives. Optional because an older cloud does not send it, and a
   * CLI that refused to link against one would break the thing it is supposed to connect.
   */
  dashboardUrl: z.string().optional(),
});
const CreatedProjectSchema = z.object({ projectId: z.string(), name: z.string() });
const ProjectsListSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), name: z.string() })),
});

/** Resolve a --project value that may be a slug id OR a display name into the canonical projectId. */
/**
 * The id for the project the caller named, creating it if it does not exist yet.
 *
 * It used to refuse — "create it with `reticle project create`" — which made naming a project a
 * two-command bookkeeping ritual for the COMMON case: a first repo, whose project has of course not
 * been created yet. That refusal is also the only reason the magic path existed: bare `link` binds
 * to a project called `Default` precisely so nobody has to meet this error.
 *
 * Creating is announced rather than silent. A tool that quietly invents a durable, billable object
 * is its own surprise, and the whole point of this change is that the automatic path SAYS what it
 * did.
 */
const resolveProjectId = async (url: string, token: string, wanted: string): Promise<string> => {
  const { projects } = ProjectsListSchema.parse(await api('GET', `${url}/v1/projects`, token));
  const lc = wanted.toLowerCase();
  const match = projects.find((p) => p.projectId === wanted || p.name.toLowerCase() === lc);
  if (match !== undefined) return match.projectId;
  const created = CreatedProjectSchema.parse(
    await api('POST', `${url}/v1/projects`, token, { name: wanted }),
  );
  hint(`created project "${wanted}" (${created.projectId}) — it did not exist yet`);
  return created.projectId;
};

/**
 * `reticle whoami` — the one call an agent (or a confused human) makes to know its state: who am I logged
 * in as, and is THIS repo attached to a cloud project (and with what sync policy / verify mode)?
 */
const cmdWhoami = async (): Promise<number> => {
  const session = await readSession();
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(
    fs,
    join(process.cwd(), RETICLE_DIR),
    homedir(),
    process.env,
  );
  /*
   * The sync half of "what is my state". Without it the honest answer to "why does the dashboard
   * look old?" was to go and read a JSON file — and the two failure modes a person actually hits
   * (nothing has synced yet, and the last attempt errored) looked identical from out here.
   */
  const reticleRoot = join(process.cwd(), RETICLE_DIR);
  const state = readCloudState(reticleRoot);
  const decisions = Object.keys(readCloudIssues(reticleRoot).triage).length;
  emit({
    loggedInAs: session?.orgName ?? null,
    sync: {
      lastPushAt: state.lastPushAt ?? null,
      lastPullAt: state.lastPullAt ?? null,
      /** Present only when the machine is behind BECAUSE something failed, which is the useful case. */
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      /** Decisions collected from the dashboard and readable locally. */
      decisionsHeld: decisions,
      neverSynced: state.lastPullAt === undefined,
    },
    repo: {
      attached: cloud.config !== null,
      projectId: cloud.projectId,
      url: cloud.config?.url ?? null,
      sync: cloud.policy,
      verify: cloud.verify,
    },
  });
  if (null === cloud.config) hint('this repo is not attached — run `reticle link`');
  return 0;
};

/** `reticle project ls` / `reticle project create <name>` — key- or session-authed. */
const cmdProject = async (argv: readonly string[]): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active);
  const session = await readSessionFor(url);
  const token = bearer(session);
  if (null === token) {
    // Name BOTH hosts when there is a session for a different one. "Run reticle login" on its own is
    // baffling to somebody who just did — the useful fact is that they logged in somewhere else.
    err(
      null !== active && normalizeUrl(active.url) !== url
        ? `signed in to ${normalizeUrl(active.url)}, but this command targets ${url} — run \`reticle login --url ${url}\`, or set RETICLE_CLOUD_KEY`
        : `not signed in to ${url} — run \`reticle login --url ${url}\`, or set RETICLE_CLOUD_KEY`,
    );
    return 2;
  }
  const sub = argv[0];
  if ('ls' === sub) {
    emit(await api('GET', `${url}/v1/projects`, token));
    return 0;
  }
  if ('create' === sub) {
    const name = argv.slice(1).join(' ').trim();
    if (0 === name.length) {
      err('usage: reticle project create <name>');
      return 2;
    }
    const created = CreatedProjectSchema.parse(
      await api('POST', `${url}/v1/projects`, token, { name }),
    );
    emit(created);
    hint(`next: \`reticle link --project ${created.projectId}\` to bind this repo`);
    return 0;
  }
  if ('rename' === sub) {
    const id = argv[1];
    const name = argv.slice(2).join(' ').trim();
    if (id === undefined || 0 === name.length) {
      err('usage: reticle project rename <projectId> <new name>');
      return 2;
    }
    emit(await api('PATCH', `${url}/v1/projects/${encodeURIComponent(id)}`, token, { name }));
    return 0;
  }
  if ('rm' === sub || 'delete' === sub) {
    const id = argv[1];
    if (id === undefined) {
      err('usage: reticle project rm <projectId>');
      return 2;
    }
    emit(await api('DELETE', `${url}/v1/projects/${encodeURIComponent(id)}`, token));
    return 0;
  }
  err('usage: reticle project <ls|create <name>|rename <id> <name>|rm <id>>');
  return 2;
};

/**
 * `reticle link [--project <id>]` — bind THIS repo to a cloud project. With a login token it MINTS a
 * project-scoped key (no pasting); with a pre-set RETICLE_CLOUD_KEY it resolves the key's project via
 * whoami. Writes the non-secret binding to <repo>/.reticle/cloud.json and the secret key to
 * ~/.reticle/credentials.json (keyed by projectId).
 */
const cmdLink = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const url = baseUrl(await readSession(), f['url']);
  // Same rule as every other authed verb: the token is looked up by the host it will be sent to.
  const session = await readSessionFor(url);
  const envKey = process.env['RETICLE_CLOUD_KEY'];
  /*
   * Read the existing binding FIRST, because it decides which project a bare `link` targets.
   * Re-running `link` is ordinary — rotating a key, repointing an environment — and it must land in
   * the project this repo already reports to, or its history splits in two without saying so.
   */
  const priorLink = await readJson(join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE));
  const priorProjectId =
    'object' === typeof priorLink && priorLink !== null
      ? (priorLink as Record<string, unknown>)['projectId']
      : undefined;

  let projectId: string;
  let projectName: string;
  let key: string;
  /**
   * The tenant this binding belongs to, recorded so the credential can be filed and found per-org.
   * Undefined against an older cloud, where the slot stays cloud+project as it always was.
   */
  let orgId: string | undefined;
  /** The key this machine already had for the slot, and whether it provably belongs to another tenant. */
  let priorKey: string | undefined;
  let priorIsForeign = false;
  /*
   * Where this project's dashboard lives. Asked of the cloud rather than derived from `url`: the API
   * origin and the console origin are different hosts in every deployment that is not a laptop, so a
   * link the CLI guessed would be wrong exactly where it matters.
   */
  let dashboardUrl: string | undefined;
  /** Whether the key was already on this machine — so the report can say so instead of "minted". */
  let reusedKey = false;
  // Tracked separately from the value: an OLDER cloud answers whoami without a dashboardUrl, and
  // keying the fallback off the value would ask the same question twice every time.
  let askedWhoami = false;
  if (envKey !== undefined && envKey.length > 0) {
    const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, envKey));
    projectId = who.projectId;
    projectName = who.projectName;
    dashboardUrl = who.dashboardUrl;
    orgId = who.orgId;
    askedWhoami = true;
    key = envKey;
  } else if (session !== null) {
    // --project accepts a slug id OR a display name; default when omitted. Resolve to the canonical id.
    const wanted = f['project'];
    /*
     * A repo is named after itself, not "Default".
     *
     * Every repo used to bind to one project called "Default" — measured, two unrelated checkouts on
     * one account merged their runs, issues and impact into a single bucket, and the dashboard's
     * per-project view described nothing. It is also what let two TENANTS collide, since a
     * credential slot built from a project id is only as distinct as the ids are.
     */
    const fallback = defaultProjectFor(
      basename(process.cwd()),
      'string' === typeof priorProjectId ? priorProjectId : undefined,
    );
    const targetId =
      wanted === undefined
        ? await resolveProjectId(url, session.token, fallback)
        : await resolveProjectId(url, session.token, wanted);
    /*
     * Reuse the key this machine already holds for the project, rather than minting another.
     *
     * `link` was idempotent about the BINDING and not about the KEY: two runs against one project
     * left two live `reticle-cli` keys on the account, each valid, neither identifiable to a repo.
     * Agents retry — that is what agents do — so it accumulates silently until somebody has a key
     * list they cannot reason about and revokes the wrong one. Measured: proving an unrelated fix
     * with two `link` runs created exactly that.
     *
     * Validated before trusting, because a stored key can have been revoked or rotated from the
     * dashboard and a stale credential must not strand the repo. The check is the whoami call the
     * mint path already makes for `dashboardUrl`, so the common path costs no extra round trip —
     * and a key that fails it is replaced rather than reported.
     */
    const existing = await storedCredential(targetId, url, session.orgId);
    const validated = existing === undefined ? undefined : await validateKey(url, existing);
    /*
     * A valid key is not the same as OUR key.
     *
     * `validateKey` only asks whether the cloud still accepts it, and a key belonging to another
     * organisation on the same cloud passes that question perfectly. With every project named
     * "default", the slot `<url>::default` was shared across tenants — so a brand-new workspace
     * signing in on a machine that had linked a different account reused that account's key and
     * would have pushed its runs into a stranger's dashboard. Measured, not hypothesised.
     *
     * So reuse now requires PROOF of a tenant match, and treats anything less as no match: an older
     * cloud that omits `orgId`, or a session file written before we recorded one, both fall through
     * to minting. Minting a second key is a tidiness problem; pushing to the wrong tenant is a
     * disclosure, and only one of those is worth defaulting to.
     */
    const sameTenant =
      validated !== undefined &&
      session.orgId !== undefined &&
      validated.orgId !== undefined &&
      validated.orgId === session.orgId;
    const reusable = sameTenant ? validated : undefined;
    priorKey = existing;
    // Provably somebody else's: it still works on this cloud AND whoami names a different org. A key
    // that merely FAILED validation is our own revoked one, and overwriting that is the point.
    priorIsForeign =
      validated !== undefined &&
      validated.orgId !== undefined &&
      session.orgId !== undefined &&
      validated.orgId !== session.orgId;
    if (existing !== undefined && reusable !== undefined) {
      projectId = reusable.projectId;
      projectName = reusable.projectName;
      dashboardUrl = reusable.dashboardUrl;
      orgId = reusable.orgId;
      askedWhoami = true;
      key = existing;
      reusedKey = true;
    } else {
      const minted = KeySchema.parse(
        await api('POST', `${url}/v1/keys`, session.token, {
          name: 'reticle-cli',
          projectId: targetId,
        }),
      );
      projectId = minted.projectId;
      projectName = minted.projectName;
      key = minted.key;
      // The key was minted WITH this session, so its tenant is this session's by construction.
      orgId = session.orgId;
    }
  } else {
    err('run `reticle login` first, or set RETICLE_CLOUD_KEY to link with an existing key');
    return 2;
  }

  const reticleDir = join(process.cwd(), RETICLE_DIR);
  await mkdir(reticleDir, { recursive: true });
  const linkPath = join(reticleDir, CLOUD_LINK_FILE);
  const prev = await readJson(linkPath);
  const prevObj =
    'object' === typeof prev && prev !== null ? (prev as Record<string, unknown>) : {};
  // The minted-key path has not asked yet. Best-effort: a link that works is worth more than a link
  // that also has a link in it, and an older cloud simply does not send one.
  if (!askedWhoami) {
    try {
      const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, key));
      dashboardUrl = who.dashboardUrl;
      // Only FILL IN a tenant we do not have. The session we minted with is the authority on which
      // org this key belongs to; letting a later lookup overwrite it is how the answer drifts.
      orgId = orgId ?? who.orgId;
    } catch {
      // Older cloud, or a transient failure. The HUD shows its list without a link.
    }
  }

  const cloudJson = {
    projectId,
    projectName,
    // Recorded so the daemon resolves the credential in the ORG slot rather than the ambiguous
    // cloud+project one, which two tenants on one cloud both answer to.
    ...(orgId === undefined ? {} : { orgId }),
    url,
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    sync: prevObj['sync'] ?? { runs: true, memory: true, flows: true },
    verify: prevObj['verify'] ?? 'local',
  };
  await writeFile(linkPath, `${JSON.stringify(cloudJson, null, 2)}\n`);

  await mkdir(home(), { recursive: true });
  const credPath = join(home(), CREDENTIALS_FILE);
  const creds = (await readJson(credPath)) ?? {};
  const credObj = applyCredential(
    'object' === typeof creds && creds !== null ? (creds as Record<string, unknown>) : {},
    { projectId, url, key, orgId, priorKey, priorIsForeign },
  );
  await writeFile(credPath, `${JSON.stringify(credObj, null, 2)}\n`);

  emit({ linked: projectName, projectId, cloudJson: linkPath, credentials: credPath });
  /*
   * Say what just happened, in the vocabulary of somebody who has used other tools.
   *
   * `link` mints the key and stores it for you, which is the product's whole edge — and it is
   * invisible, which is its whole cost. A real report: somebody pasted a masked placeholder key
   * into a `.env` because their mental model said "I must make a key and put it somewhere". One had
   * already been minted and filed outside the repo. They did not need another step; they needed to
   * be told the step had happened.
   *
   * The key is identified the way the dashboard identifies it — a prefix, never the secret — so
   * this can be read aloud, pasted into an issue, or left in a terminal without leaking anything.
   */
  hint(`bound this repo to project "${projectName}"`);
  hint(
    reusedKey
      ? `reusing key ${keyHint(key)} — already stored in ${credPath}, not in your repo`
      : `minted key ${keyHint(key)} — stored in ${credPath}, not in your repo`,
  );
  hint('to change it: `reticle link --project <other>`; to inspect: `reticle whoami`');
  hint(
    'linked ✓ runs auto-push on `reticle verify`; `reticle push` sends existing local runs; `reticle whoami` shows state',
  );
  /*
   * A binding is not a connection.
   *
   * Without `.reticle.json` the app's bundle carries no projectId, so the daemon cannot attribute a
   * session to this repo: its runs pool into whichever root the daemon itself was started in, and
   * `sync` here reports "nothing to send" however much was actually recorded. Measured on this
   * repo's bench app — two verdicts driven, then a sync that claimed there was nothing.
   *
   * Said AFTER the success line rather than refusing: the binding really was written and really is
   * correct, and the missing half is one command away. Refusing would strand somebody who links
   * before they install, which is a legitimate order to work in.
   */
  if (!(await createNodeFileSystem().exists(join(process.cwd(), RETICLE_CONFIG_BASENAME)))) {
    hint(
      `no ${RETICLE_CONFIG_BASENAME} here, so this app announces no project — its runs will not be ` +
        'attributed to this binding. Run `reticle init` in the app, then restart the dev server.',
    );
  }
  return 0;
};

/** `reticle config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]`. */
const cmdConfig = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const linkPath = join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE);
  const raw = await readJson(linkPath);
  if (null === raw || typeof raw !== 'object') {
    err('no .reticle/cloud.json here — run `reticle link` first');
    return 2;
  }
  const cfg = raw as Record<string, unknown>;
  const sync =
    'object' === typeof cfg['sync'] && cfg['sync'] !== null
      ? (cfg['sync'] as Record<string, boolean>)
      : { runs: true, memory: true, flows: true };
  const onoff = (v: string | undefined): boolean | undefined =>
    'on' === v ? true : 'off' === v ? false : undefined;
  for (const k of ['runs', 'memory', 'flows'] as const) {
    if (f[k] === undefined) continue;
    const b = onoff(f[k]);
    if (b === undefined) {
      err(`--${k} must be on|off`);
      return 2;
    }
    sync[k] = b;
  }
  cfg['sync'] = sync;
  if (f['verify'] !== undefined) {
    if (f['verify'] !== 'local' && f['verify'] !== 'server') {
      err('--verify must be local|server');
      return 2;
    }
    cfg['verify'] = f['verify'];
  }
  await writeFile(linkPath, `${JSON.stringify(cfg, null, 2)}\n`);
  emit({ updated: linkPath, sync: cfg['sync'], verify: cfg['verify'] });
  return 0;
};

/**
 * `reticle sync [--watch]` — one full cycle: send the difference, collect what came back.
 *
 * This replaced a `push` that re-uploaded every run artifact on every invocation. That was fine with
 * three runs and absurd with three hundred, and it only ever went one way — so a bug somebody
 * resolved on the dashboard stayed open on the laptop forever.
 *
 * The sync POLICY is applied here rather than inside the protocol: a project that has turned runs or
 * flows off simply presents a source with nothing in it, and the cycle does not need to know why.
 */
const cmdSync = async (argv: readonly string[]): Promise<number> => {
  const fs = createNodeFileSystem();
  const reticleRoot = join(process.cwd(), RETICLE_DIR);
  const cloud = await resolveProjectCloud(fs, reticleRoot, homedir(), process.env);
  if (null === cloud.config) {
    err('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
    return 1;
  }
  const config = cloud.config;
  const full = diskSource(reticleRoot);
  const source = {
    runs: (): ReturnType<typeof full.runs> => (cloud.policy.runs ? full.runs() : []),
    flows: (): readonly unknown[] => (cloud.policy.flows ? full.flows() : []),
    // `memory` is the project's cross-run history and the derived records that summarise it.
    derived: (kind: Parameters<typeof full.derived>[0]): unknown =>
      cloud.policy.memory ? full.derived(kind) : undefined,
  };

  const once = async (): Promise<number> => {
    const report = await runSyncCycle({
      config,
      source,
      sink: diskSink(reticleRoot),
      state: readCloudState(reticleRoot),
      now: () => Date.now(),
      request: async (url, init) => {
        const res = await fetch(url, init);
        return { status: res.status, text: await res.text() };
      },
    });
    emit({
      ok: report.ok,
      project: cloud.projectId,
      sent: {
        runs: report.runsSent,
        flows: report.flowsSent,
        records: report.derivedSent,
        ...(report.runsRejected.length > 0 ? { rejected: report.runsRejected } : {}),
      },
      pulled: report.pulled,
      ...(report.morePending ? { morePending: true } : {}),
      ...(report.error === undefined ? {} : { error: report.error }),
    });
    hint(describeSync(report));
    return report.ok ? 0 : 1;
  };

  const watch = argv.includes(WATCH_FLAG);
  if (!watch) return once();

  const everyMs = Number(process.env['RETICLE_SYNC_INTERVAL_MS'] ?? DEFAULT_SYNC_INTERVAL_MS);
  hint(`watching ${reticleRoot} — syncing every ${String(Math.round(everyMs / 1000))}s`);
  for (;;) {
    await once();
    await sleep(everyMs);
  }
};

/** `reticle push` — the name people already type. One cycle, same as `reticle sync`. */
const cmdPush = async (): Promise<number> => cmdSync([]);

/** Resolve THIS repo's linked cloud (url + project-scoped key). Throws a friendly error if not attached. */
const repoCloud = async (): Promise<{ url: string; apiKey: string }> => {
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(
    fs,
    join(process.cwd(), RETICLE_DIR),
    homedir(),
    process.env,
  );
  if (null === cloud.config)
    throw new Error('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
  return cloud.config;
};

/** `reticle runs` — the linked project's recent run artifacts (the key scopes it server-side). */
const cmdRuns = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  emit(await api('GET', `${url}/v1/runs`, apiKey));
  return 0;
};

/**
 * `reticle issues [--fix <fingerprint>]` — the triage queue, where the agent can reach it.
 *
 * The dashboard is a place a PERSON looks. The defects it lists were found by an agent, are usually
 * fixed by an agent, and every one of them carries the prompt that would fix it — so requiring a
 * browser to read them puts a human copy-paste in the middle of a loop that has no other human step
 * in it.
 *
 * `--fix <fingerprint>` prints that one issue's fix prompt as BARE TEXT on stdout, nothing else: no
 * JSON envelope, no label, no trailing commentary. That is what makes it pipeable — `reticle issues
 * --fix <fp> | pbcopy`, or straight into an agent's stdin. Anything wrapped around it would have to
 * be stripped by every caller, and the ones that forgot would paste our prose into their codebase.
 */
const cmdIssues = async (argv: readonly string[]): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const fixAt = argv.indexOf('--fix');
  const wanted = -1 === fixAt ? undefined : argv[fixAt + 1];
  if (fixAt !== -1 && wanted === undefined) {
    err('usage: reticle issues --fix <fingerprint>');
    return 2;
  }
  const body = await api('GET', `${url}/v1/issues`, apiKey);
  if (wanted === undefined) {
    emit(body);
    return 0;
  }
  const parsed = z
    .object({
      issues: z.array(
        z.object({ fingerprint: z.string(), title: z.string(), fixPrompt: z.string().nullish() }),
      ),
    })
    .safeParse(body);
  if (!parsed.success) {
    err('the server did not return an issue list this build understands');
    return 1;
  }
  const found = parsed.data.issues.find((i) => i.fingerprint === wanted);
  if (found === undefined) {
    err(`no issue with fingerprint '${wanted}' — run \`reticle issues\` to list them`);
    return 2;
  }
  const prompt = found.fixPrompt;
  if (prompt === undefined || null === prompt || 0 === prompt.length) {
    // Silent on stdout, explicit on stderr: a caller piping this into an agent must get NOTHING
    // rather than an apology, or the apology becomes the prompt.
    err(`issue '${found.title}' carries no suggested fix — not every origin produces one`);
    return 4;
  }
  process.stdout.write(`${prompt}\n`);
  return 0;
};

/**
 * `reticle memory [--subject <name>]` — what this project knows, where an agent can reach it.
 *
 * Shared memory only pays for itself if something READS it. An agent about to verify checkout should
 * be able to ask what the team already knows about checkout before it starts, and it cannot open a
 * browser to find out — so the knowledge has to arrive on stdout like everything else it consumes.
 *
 * Every call is recorded server-side as a consultation. That is the number which separates memory
 * that is worth keeping from a wiki nobody opens, and it cannot be measured from the writing side.
 *
 * `--subject` narrows to one area, which is the call an agent should actually make: pulling the
 * whole corpus to answer one question is the cost the sharded store was built to avoid.
 */
const cmdMemory = async (argv: readonly string[]): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const at = argv.indexOf('--subject');
  const subject = -1 === at ? undefined : argv[at + 1];
  if (-1 !== at && subject === undefined) {
    err('usage: reticle memory [--subject <name>]');
    return 2;
  }
  const query = subject === undefined ? '' : `?subject=${encodeURIComponent(subject)}`;
  emit(await api('GET', `${url}/v1/memory${query}`, apiKey));
  return 0;
};

/** `reticle regression` — the CI gate: broken flows vs before. Exit 3 if any regressed (pipeline-friendly). */
const cmdRegression = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const report = await api('GET', `${url}/v1/project/regression`, apiKey);
  emit(report);
  const parsed = z.object({ broken: z.array(z.unknown()) }).safeParse(report);
  return parsed.success && parsed.data.broken.length > 0 ? 3 : 0;
};

/** `reticle share <runId>` — mint a public proof link for one run. */
const cmdShare = async (argv: readonly string[]): Promise<number> => {
  const runId = argv[0];
  if (runId === undefined) {
    err('usage: reticle share <runId>');
    return 2;
  }
  const { url, apiKey } = await repoCloud();
  emit(await api('POST', `${url}/v1/runs/${encodeURIComponent(runId)}/share`, apiKey));
  return 0;
};

/** Dispatch a cloud subcommand. Returns the process exit code. */
export const runCloudCommand = async (argv: readonly string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'login':
        // The linker is passed in rather than imported by cloud-login: login ends by linking and
        // link needs a session, so the cycle is broken at this one call site.
        return await cmdLogin(rest, cmdLink);
      case 'logout':
        return await cmdLogout(rest);
      case 'whoami':
        return await cmdWhoami();
      case 'project':
        return await cmdProject(rest);
      case 'link':
        return await cmdLink(rest);
      case 'config':
        return await cmdConfig(rest);
      case 'push':
        return await cmdPush();
      case 'sync':
        return await cmdSync(rest);
      case 'runs':
        return await cmdRuns();
      case 'issues':
        return await cmdIssues(rest);
      case 'memory':
        return await cmdMemory(rest);
      case 'regression':
        return await cmdRegression();
      case 'share':
        return await cmdShare(rest);
      default:
        err(`unknown cloud command '${cmd ?? ''}'`);
        return 2;
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
};
