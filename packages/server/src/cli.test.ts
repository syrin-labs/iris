import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli.js';
import { summarizeStatus } from './cli/cli-launch.js';

const PORT = 7333;
const URL = 'http://localhost:3000';

describe('summarizeStatus', () => {
  it('reduces the /status payload to a compact per-session health view', () => {
    const out = summarizeStatus({
      running: true,
      sessionCount: 2,
      sessions: [
        { sessionId: 'a', url: 'http://localhost:5173/app', throttled: false, pendingMarks: 2 },
        { sessionId: 'b', url: 'http://localhost:5173/x', throttled: true, stale: true },
      ],
    });
    expect(out.sessionCount).toBe(2);
    expect(out.sessions).toEqual([
      {
        sessionId: 'a',
        url: 'http://localhost:5173/app',
        throttled: false,
        stale: false,
        pendingMarks: 2,
      },
      {
        sessionId: 'b',
        url: 'http://localhost:5173/x',
        throttled: true,
        stale: true,
        pendingMarks: 0,
      },
    ]);
  });

  it('degrades a missing/partial body to running with zero sessions (never throws)', () => {
    expect(summarizeStatus(undefined)).toEqual({ sessionCount: 0, sessions: [] });
    expect(summarizeStatus({ running: true })).toEqual({ sessionCount: 0, sessions: [] });
    expect(summarizeStatus({ sessions: 'nope' })).toEqual({ sessionCount: 0, sessions: [] });
  });

  it('drops malformed session entries but keeps the well-formed ones', () => {
    const out = summarizeStatus({
      sessions: [null, 42, { url: 'no id' }, { sessionId: 'ok', url: 'u' }],
    });
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.sessionId).toBe('ok');
    expect(out.sessionCount).toBe(1);
  });
});

/**
 * The parsed shape of `init` with nothing passed.
 *
 * Spelled out rather than loosened: these assertions exist so a field added to the init arm cannot
 * appear without somebody noticing, and they have caught exactly that twice.
 */
const INIT_DEFAULTS = {
  kind: 'init' as const,
  port: undefined,
  mcp: true,
  dryRun: false,
  install: true,
  app: undefined,
  flow: undefined,
  env: [] as string[],
  filesOnly: false,
  captureBodies: false,
  json: false,
  drive: true,
  open: true,
  relaunch: false,
  agents: true,
  url: undefined,
  timeoutSeconds: undefined,
  driveModel: undefined,
  licenseKey: undefined,
};

describe('parseCliArgs', () => {
  it('no args defaults to serve on the default port', () => {
    expect(parseCliArgs([], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: false,
    });
  });

  // The agent half of the feedback channel: usable when `reticle_feedback` does not exist yet, which
  // is exactly the window in which installation and wiring go wrong.
  it('parses `feedback --agent --kind` without eating the kind value as message text', () => {
    expect(
      parseCliArgs(['feedback', '--agent', '--kind', 'gap', 'init', 'never', 'wired', 'it'], PORT),
    ).toEqual({
      kind: 'feedback',
      text: 'init never wired it',
      feedbackKind: 'gap',
      bug: false,
      agent: true,
    });
  });

  it('rejects a `--kind` that is not a real feedback kind', () => {
    const parsed = parseCliArgs(['feedback', '--kind', 'annoyance', 'x'], PORT);
    expect(parsed.kind).toBe('error');
  });

  it('keeps the plain human form working, source and all', () => {
    expect(parseCliArgs(['feedback', '--rating', '4', 'good', 'stuff'], PORT)).toEqual({
      kind: 'feedback',
      text: 'good stuff',
      rating: 4,
      bug: false,
      agent: false,
    });
  });

  it('parses `affected <file...>` into the changed-file list', () => {
    expect(parseCliArgs(['affected', 'src/a.ts', 'src/b.tsx'], PORT)).toEqual({
      kind: 'affected',
      files: ['src/a.ts', 'src/b.tsx'],
    });
  });

  /**
   * The rule `reticle init` writes into CLAUDE.md tells the agent to run `reticle gate` — bare, no
   * arguments — and the parser answered with a usage error. An instruction an agent cannot follow is
   * worse than none: it spends a turn on it and learns the tool is broken.
   *
   * Bare means "what I just changed", which is the working tree against HEAD — the same question the
   * agent is asking when it reaches for the command at all.
   */
  it('bare `gate` and `affected` mean the working tree, not a usage error', () => {
    expect(parseCliArgs(['gate'], PORT)).toEqual({ kind: 'gate', files: [], since: 'HEAD' });
    expect(parseCliArgs(['affected'], PORT)).toEqual({
      kind: 'affected',
      files: [],
      since: 'HEAD',
    });
  });

  it('parses `gate <file...>` into the changed-file list', () => {
    expect(parseCliArgs(['gate', 'src/a.ts'], PORT)).toEqual({ kind: 'gate', files: ['src/a.ts'] });
  });

  it('parses `--since <ref>` on affected/gate (with or without explicit files)', () => {
    expect(parseCliArgs(['gate', '--since', 'main'], PORT)).toEqual({
      kind: 'gate',
      files: [],
      since: 'main',
    });
    expect(parseCliArgs(['affected', '--since', 'HEAD~1', 'src/a.ts'], PORT)).toEqual({
      kind: 'affected',
      files: ['src/a.ts'],
      since: 'HEAD~1',
    });
  });

  it('parses the lifecycle commands moved to the CLI', () => {
    expect(parseCliArgs(['update'], PORT)).toEqual({ kind: 'update' });
    expect(parseCliArgs(['rollback'], PORT)).toEqual({ kind: 'rollback' });
  });

  it('parses `watch [url]` with and without a url', () => {
    expect(parseCliArgs(['watch', 'http://localhost:3000'], PORT)).toEqual({
      kind: 'watch',
      url: 'http://localhost:3000',
    });
    expect(parseCliArgs(['watch'], PORT)).toEqual({ kind: 'watch' });
  });

  it('serve with no flags uses the default port', () => {
    expect(parseCliArgs(['serve'], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: false,
    });
  });

  it('serve --port overrides the port', () => {
    expect(parseCliArgs(['serve', '--port', '5000'], PORT)).toEqual({
      kind: 'serve',
      port: 5000,
      headless: true,
      http: false,
    });
  });

  it('serve --drive sets driveUrl', () => {
    expect(parseCliArgs(['serve', '--drive', URL], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: true,
      http: false,
    });
  });

  it('serve --drive --headed sets headless false', () => {
    expect(parseCliArgs(['serve', '--drive', URL, '--headed'], PORT)).toEqual({
      kind: 'serve',
      port: PORT,
      driveUrl: URL,
      headless: false,
      http: false,
    });
  });

  it('verify <url> defaults to headless, no timeout', () => {
    expect(parseCliArgs(['verify', URL], PORT)).toEqual({
      kind: 'verify',
      url: URL,
      headless: true,
      port: PORT,
    });
  });

  it('verify <url> --headed --timeout sets both', () => {
    expect(parseCliArgs(['verify', URL, '--headed', '--timeout', '5000'], PORT)).toEqual({
      kind: 'verify',
      url: URL,
      headless: false,
      timeoutMs: 5000,
      port: PORT,
    });
  });

  it('verify keeps the resolved default port (RETICLE_PORT / .reticle.json)', () => {
    // cli.ts already folds env + .reticle.json into parseCliArgs's defaultPort. Dropping port
    // from the verify result made handleVerify fall back to 4400 anyway, so a project on any
    // other port got MSG_NO_SESSION and a docstring that claimed the opposite.
    expect(parseCliArgs(['verify', URL], 4410)).toEqual({
      kind: 'verify',
      url: URL,
      headless: true,
      port: 4410,
    });
  });

  it('verify --port overrides the resolved default', () => {
    expect(parseCliArgs(['verify', URL, '--port', '4411'], 4400)).toEqual({
      kind: 'verify',
      url: URL,
      headless: true,
      port: 4411,
    });
  });

  it('verify with no url says it needs a url', () => {
    expect(parseCliArgs(['verify'], PORT)).toEqual({
      kind: 'error',
      message: 'verify needs a url',
    });
  });

  it('verify <url> --storage-state captures the auth file path', () => {
    expect(parseCliArgs(['verify', URL, '--storage-state', 'auth.json'], PORT)).toEqual({
      kind: 'verify',
      url: URL,
      headless: true,
      storageState: 'auth.json',
      port: PORT,
    });
  });

  it('verify --storage-state with no path names the flag', () => {
    expect(parseCliArgs(['verify', URL, '--storage-state'], PORT)).toEqual({
      kind: 'error',
      message: '--storage-state needs a value',
    });
  });

  // The ambiguity error `sessions.resolve` throws when several tabs are connected reads "pass
  // sessionId to target one" — and the verify parser used to reject every flag that could carry
  // one, so the only action the message prescribed was one the CLI could not perform. The
  // workaround was closing tabs until the ambiguity went away.
  it('verify <url> --session-id targets one of several connected tabs', () => {
    expect(parseCliArgs(['verify', URL, '--session-id', 's-42'], PORT)).toEqual({
      kind: 'verify',
      url: URL,
      headless: true,
      sessionId: 's-42',
      port: PORT,
    });
  });

  it('verify --session-id with no id names the flag', () => {
    expect(parseCliArgs(['verify', URL, '--session-id'], PORT)).toEqual({
      kind: 'error',
      message: '--session-id needs a value',
    });
  });

  it('verify carries --session-id alongside the other flags', () => {
    expect(
      parseCliArgs(
        ['verify', URL, '--session-id', 's-42', '--headed', '--port', '4411', '--timeout', '9000'],
        PORT,
      ),
    ).toEqual({
      kind: 'verify',
      url: URL,
      headless: false,
      sessionId: 's-42',
      timeoutMs: 9000,
      port: 4411,
    });
  });

  it('init with no flags defaults to mcp + install on, no dry run, no port', () => {
    expect(parseCliArgs(['init'], PORT)).toEqual(INIT_DEFAULTS);
  });

  it('init --dry-run --no-mcp --no-install --port sets each flag', () => {
    expect(
      parseCliArgs(['init', '--dry-run', '--no-mcp', '--no-install', '--port', '4500'], PORT),
    ).toEqual({ ...INIT_DEFAULTS, port: 4500, mcp: false, dryRun: true, install: false });
  });

  it('init --yes is accepted', () => {
    expect(parseCliArgs(['init', '--yes'], PORT)).toEqual(INIT_DEFAULTS);
  });

  /**
   * What only the caller can know arrives as arguments, not as steps somebody walks through.
   *
   * `--env` is repeatable rather than comma-separated because a value can contain commas, spaces
   * and equals signs — a connection string, a base64 token — and inventing a quoting rule for them
   * is how a variable arrives truncated and the app fails for a reason nobody can see.
   */
  it('takes the answers only an agent has: the flow, the app env, and files-only', () => {
    expect(
      parseCliArgs(
        [
          'init',
          '--flow',
          'add to cart and check the badge',
          '--env',
          'API=http://x',
          '--env',
          'TOKEN=a=b',
          '--files-only',
        ],
        PORT,
      ),
    ).toEqual({
      ...INIT_DEFAULTS,
      flow: 'add to cart and check the badge',
      env: ['API=http://x', 'TOKEN=a=b'],
      filesOnly: true,
      captureBodies: false,
    });
  });

  it('refuses a flag that names no value, rather than swallowing the next one', () => {
    expect(parseCliArgs(['init', '--flow'], PORT)).toMatchObject({ kind: 'error' });
    expect(parseCliArgs(['init', '--env'], PORT)).toMatchObject({ kind: 'error' });
  });

  /**
   * A usage error has to name the argument it rejected.
   *
   * The install gate reported `init crashed:` followed by 600 characters of unrelated help text —
   * the whole CLI_USAGE block, JSON-escaped onto one stderr line by `log()`, with no mention of
   * which flag was wrong. That is the same experience a human gets after one typo, and it made a
   * one-word mistake unreadable in a report and undiagnosable from a CI log.
   */
  it('init rejects unknown flags, and says which one', () => {
    const parsed = parseCliArgs(['init', '--bogus'], PORT);
    expect(parsed.kind).toBe('error');
    expect('error' === parsed.kind && parsed.message).toMatch(/--bogus/);
  });

  it('a flag that needs a value says so by name', () => {
    const parsed = parseCliArgs(['init', '--app'], PORT);
    expect(parsed.kind).toBe('error');
    expect('error' === parsed.kind && parsed.message).toMatch(/--app/);
  });

  it('a usage error stays short — the help text is not the message', () => {
    // It is rendered separately, as readable text. Carrying it in `message` is what put an escaped
    // 600-character wall into a log line and a fixtures report.
    const parsed = parseCliArgs(['init', '--bogus'], PORT);
    expect('error' === parsed.kind && parsed.message.length).toBeLessThan(120);
  });

  it('stop returns stop result with quiet false', () => {
    expect(parseCliArgs(['stop'], PORT)).toEqual({ kind: 'stop', port: PORT, quiet: false });
  });

  it('stop --port overrides the port', () => {
    expect(parseCliArgs(['stop', '--port', '5000'], PORT)).toEqual({
      kind: 'stop',
      port: 5000,
      quiet: false,
    });
  });

  it('stop --quiet sets quiet true', () => {
    expect(parseCliArgs(['stop', '--quiet'], PORT)).toEqual({
      kind: 'stop',
      port: PORT,
      quiet: true,
    });
  });

  it('status returns status result', () => {
    expect(parseCliArgs(['status'], PORT)).toEqual({ kind: 'status', port: PORT });
  });

  it('license returns license result', () => {
    expect(parseCliArgs(['license'], PORT)).toEqual({ kind: 'license' });
  });

  it('telemetry parses its actions and defaults to status', () => {
    expect(parseCliArgs(['telemetry'], PORT)).toEqual({ kind: 'telemetry', action: 'status' });
    expect(parseCliArgs(['telemetry', 'disable'], PORT)).toEqual({
      kind: 'telemetry',
      action: 'disable',
    });
    expect(parseCliArgs(['telemetry', 'enable'], PORT)).toEqual({
      kind: 'telemetry',
      action: 'enable',
    });
    expect(parseCliArgs(['telemetry', 'nuke'], PORT).kind).toBe('error');
  });

  it('version (and the -v/--version flags) returns a version result', () => {
    expect(parseCliArgs(['version'], PORT)).toEqual({ kind: 'version' });
    expect(parseCliArgs(['--version'], PORT)).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'], PORT)).toEqual({ kind: 'version' });
  });

  it('status --port overrides the port', () => {
    expect(parseCliArgs(['status', '--port', '5000'], PORT)).toEqual({
      kind: 'status',
      port: 5000,
    });
  });

  it('open with no url → reuse-a-connected-tab intent (no url field)', () => {
    expect(parseCliArgs(['open'], PORT)).toEqual({ kind: 'open', port: PORT });
  });

  it('open <url> carries the url', () => {
    expect(parseCliArgs(['open', URL], PORT)).toEqual({ kind: 'open', port: PORT, url: URL });
  });

  it('open <url> --port overrides the port', () => {
    expect(parseCliArgs(['open', URL, '--port', '5000'], PORT)).toEqual({
      kind: 'open',
      port: 5000,
      url: URL,
    });
  });

  it('drive <url> returns legacy drive result (visible by default)', () => {
    expect(parseCliArgs(['drive', URL], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('drive <url> --headed sets headless false', () => {
    expect(parseCliArgs(['drive', URL, '--headed'], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('drive --headed <url> (flag before url) sets headless false', () => {
    expect(parseCliArgs(['drive', '--headed', URL], PORT)).toEqual({
      kind: 'drive',
      port: PORT,
      driveUrl: URL,
      headless: false,
    });
  });

  it('drive without a url says it needs a url', () => {
    expect(parseCliArgs(['drive'], PORT)).toEqual({ kind: 'error', message: 'drive needs a url' });
  });

  it('drive with an unknown flag names the flag', () => {
    const parsed = parseCliArgs(['drive', URL, '--nope'], PORT);
    expect(parsed.kind).toBe('error');
    expect('error' === parsed.kind && parsed.message).toMatch(/--nope/);
  });

  it('_daemon returns _daemon result', () => {
    expect(parseCliArgs(['_daemon', '--port', '5000'], PORT)).toEqual({
      kind: '_daemon',
      port: 5000,
      headless: true,
      http: false,
    });
  });

  it('_daemon --drive sets driveUrl', () => {
    expect(parseCliArgs(['_daemon', '--drive', URL], PORT)).toEqual({
      kind: '_daemon',
      port: PORT,
      driveUrl: URL,
      headless: true,
      http: false,
    });
  });

  it('serve --http with port + token parses the verify-endpoint flags', () => {
    expect(
      parseCliArgs(['serve', '--http', '--http-port', '7331', '--http-token', 'sek'], PORT),
    ).toEqual({
      kind: 'serve',
      port: PORT,
      headless: true,
      http: true,
      httpPort: 7331,
      httpToken: 'sek',
    });
  });

  it('mcp returns mcp result on default port', () => {
    expect(parseCliArgs(['mcp'], PORT)).toEqual({
      kind: 'mcp',
      port: PORT,
      headless: true,
      http: false,
    });
  });

  it('mcp --port overrides the port', () => {
    expect(parseCliArgs(['mcp', '--port', '5000'], PORT)).toEqual({
      kind: 'mcp',
      port: 5000,
      headless: true,
      http: false,
    });
  });

  it('mcp --drive passes the drive url', () => {
    expect(parseCliArgs(['mcp', '--drive', 'http://localhost:3000'], PORT)).toEqual({
      kind: 'mcp',
      port: PORT,
      driveUrl: 'http://localhost:3000',
      headless: true,
      http: false,
    });
  });

  it('mcp --drive --headed passes both flags', () => {
    expect(parseCliArgs(['mcp', '--drive', 'http://localhost:3000', '--headed'], PORT)).toEqual({
      kind: 'mcp',
      port: PORT,
      driveUrl: 'http://localhost:3000',
      headless: false,
      http: false,
    });
  });

  it('serve --http-port without --http is rejected, not silently ignored', () => {
    expect(parseCliArgs(['serve', '--http-port', '4401'], PORT)).toEqual({
      kind: 'error',
      message: '--http-port requires --http — it configures the verify endpoint --http starts',
    });
  });

  it('serve --http-token without --http is rejected the same way', () => {
    expect(parseCliArgs(['serve', '--http-token', 'sek'], PORT)).toEqual({
      kind: 'error',
      message: '--http-token requires --http — it configures the verify endpoint --http starts',
    });
  });

  it('mcp --http-port without --http is rejected too — same parser, same contract', () => {
    expect(parseCliArgs(['mcp', '--http-port', '9100'], PORT).kind).toBe('error');
  });

  it('mcp --http forwards the HTTP-verify flags (previously dropped)', () => {
    expect(
      parseCliArgs(['mcp', '--http', '--http-port', '9100', '--http-token', 't'], PORT),
    ).toEqual({
      kind: 'mcp',
      port: PORT,
      headless: true,
      http: true,
      httpPort: 9100,
      httpToken: 't',
    });
  });

  it('an unknown command names the command', () => {
    expect(parseCliArgs(['nope'], PORT)).toEqual({
      kind: 'error',
      message: "unknown command 'nope'",
    });
  });
});

/**
 * A run nobody can see is a run nobody trusts. Reticle used to hide the browser unless you passed
 * --headed, so every "did it actually do anything?" cost a human round-trip — and the people this is
 * built for never knew the flag existed. Visible is now the default; CI, which has no display to be
 * headed on, flips it back through the injected parameter (cli.ts reads the CI env var).
 */
describe('parseCliArgs — the browser is visible unless something says otherwise', () => {
  const headlessOf = (r: unknown): unknown => (r as { headless?: unknown }).headless;

  it('makes the INTERACTIVE command visible — that is where a human is watching', () => {
    expect(headlessOf(parseCliArgs(['drive', URL], PORT))).toBe(false);
  });

  it('leaves the pool-owning commands headless — they back batch work nobody watches', () => {
    // serve/mcp/_daemon own the browser pool: leased contexts for parallel agents, flow replay, the
    // spec runner. Launching those headed broke four e2e specs and helps no one.
    for (const argv of [[], ['serve'], ['mcp'], ['_daemon']]) {
      expect(headlessOf(parseCliArgs(argv, PORT)), argv.join(' ')).toBe(true);
    }
  });

  it('--headless forces drive hidden; --headed opts the pool commands in', () => {
    expect(headlessOf(parseCliArgs(['drive', URL, '--headless'], PORT))).toBe(true);
    expect(headlessOf(parseCliArgs(['serve', '--headed'], PORT))).toBe(false);
    expect(headlessOf(parseCliArgs(['mcp', '--headed'], PORT))).toBe(false);
  });

  it('an injected headless default (what CI passes) hides the interactive command too', () => {
    expect(headlessOf(parseCliArgs(['drive', URL], PORT, true))).toBe(true);
    // ...and an explicit --headed still wins over it, so CI can opt a single run back in.
    expect(headlessOf(parseCliArgs(['drive', URL, '--headed'], PORT, true))).toBe(false);
  });

  it('verify stays hidden by default — it is the CI one-shot, not an interactive run', () => {
    expect(headlessOf(parseCliArgs(['verify', URL], PORT))).toBe(true);
    expect(headlessOf(parseCliArgs(['verify', URL, '--headed'], PORT))).toBe(false);
  });
});
