/**
 * The message that ends most sessions.
 *
 * The field data behind this is unambiguous in shape: most sessions that call any tool make exactly
 * one call and stop, the single commonest of those calls is `reticle_sessions`, and most of them
 * never touch a browser afterwards. Nearly every recorded session error was the same message:
 *
 *   "no browser session connected. Two things to check: (1) your app is running with
 *    @reticlehq/browser enabled, and (2) it points at THIS daemon's port"
 *
 * It is accurate and it is fatal. It names two things the agent cannot check from where it stands
 * and gives it nothing to DO, so the agent abandons the tool for the rest of the session, and this
 * is what greets most of the ones that try.
 *
 * (The counts themselves are deliberately not written here. Field and user numbers live only in the
 * gitignored analysis directory, never in code, docs, changelog or commit messages.)
 *
 * The daemon can tell these three cases apart, and they have completely different next actions:
 *   - nothing is listening anywhere       -> the dev server is not running; start it
 *   - something is listening, never dialled -> the SDK is not wired into that app; run `reticle init`
 *   - a session was connected and went away -> the tab closed or reloaded; reopen/reload it
 *
 * Today all three produce the same dead end.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseNoSession, type NoSessionFacts } from './no-session-diagnosis.js';
import { STALL_AFTER_MS } from './stall-clock.js';

describe('diagnoseNoSession', () => {
  it('a session was here and left — say so, and say what to do', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg).toMatch(/was connected|disconnected|reload/i);
    // Never send someone to check the install when the install demonstrably worked.
    expect(msg).not.toMatch(/reticle init/);
  });

  it('a session was here and a port is bound — name the port, so nobody starts a second stack', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('5173');
    expect(msg).toMatch(/already listening/i);
    expect(msg).toContain('http://localhost:5173');
    expect(msg).toMatch(/do not start a second/i);
  });

  it('a dev server is up but never dialled — name the port, and point at the wiring', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('5173');
    expect(msg).toContain('npx @reticlehq/server init');
    // The actionable half: the app is RUNNING, so "is your app running?" is the wrong question.
    expect(msg).toMatch(/not wired|never connected|no Reticle SDK/i);
  });

  it('a dev server is up and the project IS wired — then it is the port or a stale build', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(msg).toContain('3000');
    expect(msg).toContain('4400');
    expect(msg).toMatch(/restart|reload|port/i);
    expect(msg).not.toMatch(/reticle init/);
  });

  it('nothing is listening at all — the app is simply not running', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg).toMatch(/no dev server|not running/i);
    // Do not ask the agent to check the SDK when there is no app to have an SDK in.
    expect(msg).not.toMatch(/reticle init/);
  });

  it('names every listening candidate, not just the first', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000, 5173],
      port: 4400,
    });
    expect(msg).toContain('3000');
    expect(msg).toContain('5173');
  });

  /**
   * The branch where the agent does not need the human at all.
   *
   * `reticle_lease` opens a browser Reticle controls instead of waiting for the human's tab to dial
   * in. Measured over a day: the 5 sessions that used it had a MEDIAN of 30 tool calls and produced
   * 46% of every bug found, against a median of 1 call for the 20 active sessions that did not — and
   * not one single-call bounce used a lease. It is the difference between working and bouncing.
   *
   * It is also advertised on NO profile but `full`, so an agent finds it only if it already knew.
   * The moment it matters is exactly here, so this is where it gets named — at no per-turn cost.
   */
  it('offers self-service driving when the app is wired but no tab is open', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('reticle_lease');
    // Advertised only under `full`; everywhere else it is reached through the meta-tool.
    expect(msg).toContain('reticle_run');
  });

  it('offers it again when a tab was connected and went away', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('reticle_lease');
  });

  it('does NOT offer it when the app has no SDK — a leased tab would never dial in either', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
    });
    expect(msg).not.toContain('reticle_lease');
  });

  /**
   * Refined rather than dropped: a BLIND lease is still wrong here, because a lease opens a URL and
   * nothing is listening at any of them. What changed is that withholding it entirely left an agent
   * with no CLI holding no path at all (reported from Windows, where every tool was advertised and
   * no `reticle` binary existed). So the offer is now ordered behind getting the URL, which this
   * branch already instructs, and never presented as something to try immediately.
   */
  it('does not offer a BLIND lease when nothing is running, but names it after the URL', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg, 'the lease must be conditioned on having a URL').toContain(
      'Once you have that URL',
    );
    expect(msg.indexOf('ask the human for its URL')).toBeLessThan(msg.indexOf('reticle_lease'));
  });

  it('always ends with something the agent can DO', () => {
    for (const input of [
      { everConnected: true, initialized: true, listening: [], port: 4400 },
      { everConnected: false, initialized: false, listening: [5173], port: 4400 },
      { everConnected: false, initialized: true, listening: [], port: 4400 },
    ]) {
      const msg = diagnoseNoSession(input);
      expect(msg.length, JSON.stringify(input)).toBeGreaterThan(40);
      // An imperative, not a description of the world.
      expect(msg, JSON.stringify(input)).toMatch(/start |run |reload|reopen|restart|check /i);
    }
  });
});

/**
 * An empty result from an eleven-port scan is not evidence of absence.
 *
 * Reported from a scripted drive of published 2.5.0: the diagnosis asserted the app was not running
 * while it was serving 200 on `:7699`. `DEV_SERVER_PORTS` is a fixed set of eleven, and it does not
 * contain 7699 — nor 4310 (our own bench-app), 3100 (next-smoke), 5175 (a second Vite on a machine
 * already running one), 1420 (Tauri), 4173 (`vite preview`), or anything a user passed to --port.
 *
 * The narrow claim was true. The two sentences built on top of it — "the app is almost certainly not
 * running" and "this is not a Reticle wiring problem" — are neither, and the message is DIRECTIVE:
 * the agent is the audience and it is being told to stop looking. That is the expensive part. A
 * caveat costs a sentence; sending an agent away from a working app costs the session.
 */
describe('the no-listener branch does not overclaim what an eleven-port scan proved', () => {
  const scanned = diagnoseNoSession({
    everConnected: false,
    initialized: true,
    listening: [],
    port: 4400,
  });

  it('does not assert the app is not running', () => {
    expect(scanned).not.toMatch(/almost certainly not running/i);
  });

  it('does not tell the agent this cannot be a Reticle problem', () => {
    // The directive half. Reticle cannot know this, and saying it ends the investigation.
    expect(scanned).not.toMatch(/not a Reticle wiring problem/i);
  });

  it('says what it actually checked, so the reader can judge the gap', () => {
    expect(scanned).toMatch(/\b5173\b/);
    expect(scanned).toMatch(/scan|checked|only|these ports/i);
  });

  it('gives the agent a way to proceed when the app IS running elsewhere', () => {
    expect(scanned).toMatch(/reticle_lease|url/i);
  });

  it('still leads with the likeliest cause — a caveat must not bury the common case', () => {
    // The scan is usually right. This must stay useful for the user whose server really is down,
    // not become a hedge that says nothing.
    expect(scanned).toMatch(/dev server|npm run dev/i);
  });

  it('does not claim the scan settles it', () => {
    // Reported from the field: an agent was told "the likeliest cause BY FAR is that the dev server
    // is not running" while a dev server answered on :5000, and spent six calls disproving it with
    // `netstat` before it could get back to its job. Leading with the common case is right; ranking
    // it "by far" off an eleven-port scan is a confidence the evidence does not carry, and it is the
    // strength of the phrasing, not the ordering, that made the reader stop investigating.
    expect(scanned).not.toMatch(/by far/i);
  });
});

/**
 * A machine-wide port scan is not evidence about THIS project.
 *
 * Reported from the field (#320): the message said "something IS listening on port 5173, 8000, 8080,
 * so a server is up and has never dialled this daemon. This project has not been through `reticle
 * init` … the app carries no Reticle SDK". `init` had run minutes earlier, the SDK was wired and
 * serving, all three ports belonged to OTHER repositories on the same machine, and the app under
 * test was on a port the scan does not cover. The real cause was that no browser had opened the app
 * yet, and `reticle open` fixed it in one call — a command the message named nowhere.
 *
 * The scan finds listeners anywhere on localhost and cannot say whose they are, so a "so" that draws
 * a conclusion from them is unsound on any machine running more than one instrumented repo, which is
 * the normal case for the people using us. The reporter re-verified their init output, diffed their
 * Vite config and curled their own page to disprove it, and now ignores the field entirely.
 */
describe('the scan is reported as unattributed, and the browser comes first', () => {
  const wiredAndListening = diagnoseNoSession({
    everConnected: false,
    initialized: true,
    listening: [5173, 8000, 8080],
    port: 4400,
  });

  it('leads with the browser nobody opened, and names the command that fixes it', () => {
    expect(wiredAndListening).toMatch(/npx @reticlehq\/server open/);
    // Before the port sentence: this is the commonest first-run state by a distance.
    const open = wiredAndListening.indexOf('npx @reticlehq/server open');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(open).toBeLessThan(wiredAndListening.indexOf('5173'));
  });

  it('never draws a conclusion from a port it cannot attribute', () => {
    expect(wiredAndListening).not.toMatch(/so a server is up/i);
    expect(wiredAndListening).toMatch(/attribute/i);
  });

  it('says the same thing when the project is not known to be wired', () => {
    const unwired = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173, 8000, 8080],
      port: 4400,
    });
    expect(unwired).not.toMatch(/so a server is up/i);
    expect(unwired).toMatch(/attribute/i);
    // and never the claim the file cannot support
    expect(unwired).not.toMatch(/has not been through `reticle init`/);
  });

  it('names the directory it looked in, when it was given one', () => {
    const unwired = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
      directory: '/repo/root',
    });
    expect(unwired).toContain('/repo/root');
  });

  it('names the open command for a wired project with nothing listening either', () => {
    // The app may be on a port the scan never covers, which is exactly the reported case.
    const quiet = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(quiet).toMatch(/npx @reticlehq\/server open/);
  });
});

/**
 * A lease that aged out must not be reported as a human closing a tab.
 *
 * Reported from the field (#157): when a pooled lease expires, the agent gets the `everConnected`
 * message — "The tab was closed, navigated away, or hard-reloaded. Ask the human to reopen the app"
 * — and none of it is true. There is no human tab; the lease simply aged out, and the fix is a
 * re-acquire the agent can do itself. The reporter said it "sent me looking for a port mismatch".
 *
 * That is the same defect as the eleven-port scan: a message asserting one specific cause and one
 * specific fix, both wrong, to an audience that will act on it. Here it is worse than a dead end,
 * because the recovery it names (ask a human) is unavailable to the caller and the one that would
 * work (`reticle_lease { action: "acquire" }`) is not mentioned.
 *
 * `leaseExpired` is "this daemon has reaped at least one expired lease", NOT "the session that just
 * vanished was that lease" — nothing knows that. So the message leads with the lease because a reap
 * is a fact, and still admits the tab case rather than swapping one false certainty for another.
 */
describe('a reaped lease is not reported as a closed tab', () => {
  const afterReap = diagnoseNoSession({
    everConnected: true,
    initialized: true,
    listening: [5173],
    port: 4400,
    leaseExpired: true,
  });

  it('does not assert that a human closed the tab', () => {
    expect(afterReap).not.toMatch(/tab was closed, navigated away, or hard-reloaded/i);
  });

  it('names the lease AGEING OUT as the likely cause', () => {
    // Deliberately not just /lease/: the existing message already mentions `reticle_lease` in its
    // self-serve hint, so a looser assertion here would pass without the fix and prove nothing.
    expect(afterReap).toMatch(/expired|aged out/i);
  });

  it('tells the agent to re-acquire rather than to fetch a human', () => {
    expect(afterReap).toMatch(/acquire/i);
    expect(afterReap).not.toMatch(/Ask the human to reopen/i);
  });

  it('still keeps the old message when no lease was ever reaped', () => {
    // The control. Most sessions are human tabs, and that message is right for them.
    const plain = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(plain).toMatch(/tab was closed, navigated away, or hard-reloaded/i);
  });
});

/**
 * Nothing listening AND never instrumented is a TWO-step problem, and saying only one step is a
 * dead end that costs the reader a whole round trip.
 *
 * This is the largest cohort in the funnel (#171): 77 users attached an agent and never
 * instrumented an app. They registered the MCP server — so a daemon is up and the agent can call
 * tools — but `reticle init` never ran, so no app carries the SDK.
 *
 * The no-listener branch runs BEFORE the `initialized` check and only ever said "start your dev
 * server". Someone in that cohort follows it, starts the server, calls again — and lands in the
 * `!initialized` branch to be told, only now, that the project was never wired. Two round trips to
 * learn two facts the daemon knew at the first call.
 *
 * The instrumented case must NOT gain the extra sentence: for a project that HAS been through
 * `init`, "run reticle init" is noise at best and a wrong instruction at worst.
 */
describe('an uninstrumented project with no server is told BOTH things at once', () => {
  const uninstrumented = diagnoseNoSession({
    everConnected: false,
    initialized: false,
    listening: [],
    port: 4400,
  });

  it('still leads with the dev server, which is the first thing to do', () => {
    expect(uninstrumented).toMatch(/dev server|npm run dev/i);
  });

  it('also names the init command, so the second step is not a second round trip', () => {
    expect(uninstrumented).toContain('npx @reticlehq/server init');
  });

  it('says the app carries no SDK — the reason starting a server alone will not help', () => {
    expect(uninstrumented).toMatch(/SDK|instrument/i);
  });

  it('does NOT tell an already-initialised project to run init', () => {
    // The control. This branch fires for both, and "run reticle init" on a wired project sends the
    // reader to re-run a step that already succeeded.
    const wired = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(wired).not.toContain('npx @reticlehq/server init');
    expect(wired).toMatch(/dev server|npm run dev/i);
  });
});

/**
 * When the two halves disagree about where to meet, say the number.
 *
 * The wired-and-listening branch ended with "check that the app's reticle port matches N", which is
 * the right suspicion and leaves the reader to go and compare two numbers by hand. The daemon can do
 * that comparison itself: it knows the port it bound, and `.reticle.json` is the same file `doctor`
 * already reads to produce a precise line about exactly this.
 *
 * This is the `why` field an AGENT reads, and doctor's version is one a human runs. The agent was
 * getting the vaguer of the two.
 *
 * A configured port that disagrees with the bound port IS observed, exactly, from a file we read.
 * A listener on a neighbouring Reticle port is a separate observation, rendered without a conclusion
 * — that half of #261 lives in the describe below this one.
 */
describe('a configured port that disagrees with the bound port is named, not hinted at', () => {
  const wiredAndListening = {
    everConnected: false,
    initialized: true,
    listening: [5173],
    port: 4400,
  };

  it('names both numbers when .reticle.json disagrees with the daemon', () => {
    const why = diagnoseNoSession({ ...wiredAndListening, projectPort: 4460 });
    expect(why).toContain('4460');
    expect(why).toContain('4400');
    // The actionable half: a reader who knows the numbers still has to be told which to change.
    expect(why.toLowerCase()).toMatch(/--port|update|\.reticle\.json/);
  });

  it('says nothing when they agree, so the message does not gain a paragraph about a non-problem', () => {
    const why = diagnoseNoSession({ ...wiredAndListening, projectPort: 4400 });
    expect(why).not.toContain('disagree');
  });

  it('says nothing when there is no configured port to compare against', () => {
    // No `.reticle.json`, or one without a port. Absence is not a mismatch, and inventing one here
    // would fire on every plugin-wired app in existence.
    const why = diagnoseNoSession(wiredAndListening);
    expect(why).not.toContain('disagree');
  });
});

/**
 * A listener on a well-known Reticle port we are not bound to is observable. It is not a diagnosis.
 *
 * This is the remaining half of #261. The SDK dialling 4460 while we listen on 4400 is invisible
 * to us as a refused inbound, but a listener on 4460 is visible, and saying nothing about it is how
 * the original silent no-connect survived. Saying it IS the daemon this app wants would be the same
 * unobserved claim #310 exists to remove — somebody else's daemon, another project, and an unrelated
 * process all look identical from here.
 *
 * So: name the ports, refuse the conclusion. The probe lives at the call site; this only renders
 * facts it was given, like every other clause in this file.
 */
describe('a listener on a sibling Reticle port is named without being blamed', () => {
  const wiredAndListening = {
    everConnected: false,
    initialized: true,
    listening: [5173],
    port: 4400,
  };

  it('names the occupied sibling and this daemon, and hedges the link', () => {
    const why = diagnoseNoSession({ ...wiredAndListening, siblingListeners: [4460] });
    expect(why).toContain(':4460');
    expect(why).toContain(':4400');
    expect(why).toMatch(/may or may not be related/);
    expect(why).not.toMatch(/SDK will dial|SDK is dialling/i);
    expect(why).not.toMatch(/the daemon this app wants/i);
  });

  it('says nothing when no sibling is occupied, so a healthy box does not gain a scare', () => {
    const why = diagnoseNoSession(wiredAndListening);
    expect(why).not.toMatch(/may or may not be related/);
  });

  it('does not repeat a sibling that the configured-port mismatch already named', () => {
    // Both numbers are already in the mismatch sentence. Saying 4460 is occupied on top of that
    // reads as a second, independent cause, which it is not — it is the same disagreement.
    const why = diagnoseNoSession({
      ...wiredAndListening,
      projectPort: 4460,
      siblingListeners: [4460],
    });
    const related = why.match(/may or may not be related/g) ?? [];
    expect(related).toHaveLength(0);
    expect(why).toContain('4460');
  });

  it('still reports a sibling that is not the configured-port mismatch', () => {
    const why = diagnoseNoSession({
      ...wiredAndListening,
      projectPort: 4401,
      siblingListeners: [4460],
    });
    expect(why).toMatch(/may or may not be related/);
    expect(why).toContain(':4460');
  });
});

/**
 * The scan must not call a running server absent.
 *
 * Reported from Nuxt 4 on port 5000: the dev server was serving 57KB of HTML, the reporter proved it
 * answered on 127.0.0.1, ::1 and localhost, and every diagnostic said "nothing is listening on the
 * ports Reticle scans" and told them to start it. A second `nuxt dev` would have hit the dev lock.
 * The probe had accepted a connection and then given up waiting for the document, and that timeout
 * was reported as an absence.
 *
 * Ordered on purpose: the reader acts on the first claim in the paragraph, so the evidence that the
 * app IS up has to come before the sentence about nothing listening.
 */
describe('a port that answered nothing is not a port with nothing on it', () => {
  const base = { everConnected: false, initialized: false, listening: [], port: 4400 };

  it('says the port accepted a connection, and says it BEFORE "nothing is listening"', () => {
    const text = diagnoseNoSession({ ...base, slowListeners: [5000] });
    expect(text).toContain('5000');
    expect(text.toLowerCase()).toContain('accepted');
    expect(
      text.indexOf('ACCEPTED'),
      'the evidence the app is up must precede the claim that nothing is there',
    ).toBeLessThan(text.indexOf('Nothing is listening'));
  });

  it('tells the reader to OPEN it rather than start it', () => {
    const text = diagnoseNoSession({ ...base, slowListeners: [5000] });
    expect(text.toLowerCase()).toMatch(/open it rather than start it/);
  });

  it('says nothing extra when no port answered at all', () => {
    const text = diagnoseNoSession({ ...base, slowListeners: [] });
    expect(text).not.toContain('ACCEPTED');
  });
});

/**
 * Never tell a blocked agent to run a binary that is probably not installed.
 *
 * Reticle registers its MCP server as `npx @reticlehq/server mcp`, so the ordinary install puts
 * NOTHING named `reticle` on PATH. These messages are read by an agent that is already stuck, and
 * they used to name a bare `reticle open <url>`.
 *
 * Reported from Windows, where a half-failed plugin install left the server registered and all the
 * tools advertised while no CLI existed on disk: the agent followed the remediation, found no
 * `reticle`, then tried `npx @reticlehq/reticle` — a package that does not exist and 404s — and was
 * left with no path forward at all.
 *
 * Asserted over every branch rather than the one that was reported, because the next branch to grow
 * a remedy is the one nobody will check.
 */
describe('remediation names a command that actually runs', () => {
  const branches: NoSessionFacts[] = [
    { everConnected: false, initialized: false, listening: [], port: 4400 },
    { everConnected: false, initialized: true, listening: [], port: 4400 },
    { everConnected: false, initialized: true, listening: [5173], port: 4400 },
    { everConnected: true, initialized: true, listening: [5173], port: 4400 },
    { everConnected: false, initialized: false, listening: [], port: 4400, slowListeners: [5000] },
    { everConnected: true, initialized: true, listening: [], port: 4400, leaseExpired: true },
  ];

  it.each(branches.map((f, i) => [i, f] as const))(
    'branch %i never tells the agent to run a bare `reticle` binary',
    (_i, facts) => {
      const text = diagnoseNoSession(facts);
      expect(
        text,
        'a bare `reticle ...` assumes a global install that the npx-registered MCP never creates',
      ).not.toMatch(/`reticle (open|init|serve|drive|doctor|status)\b/);
    },
  );

  it('offers the npx form somewhere in the never-connected branch', () => {
    const text = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(text).toContain('npx @reticlehq/server');
  });
});

/**
 * Every stuck branch must name the escape hatch that needs no shell.
 *
 * `reticle_lease {action:"acquire", url}` opens a browser Reticle drives itself and hands back a
 * sessionId — the one recovery that works with no CLI, no human, and no dev server the agent can
 * reach. It was named in three branches and missing from the two an agent that has NEVER connected
 * actually lands on, which are precisely the branches where it is the only way out.
 *
 * Reported from Windows, where the MCP server was registered and all its tools advertised while no
 * CLI existed on disk: every remedy offered was a shell command the agent could not run. Also from
 * two reporters whose daemon was pinned to a different repo, who were told to restart it and had no
 * in-session alternative.
 *
 * Asserted over every branch, because the value of an escape hatch is that it is there on the path
 * you are actually on.
 */
describe('every branch offers the no-shell escape hatch', () => {
  const branches: NoSessionFacts[] = [
    { everConnected: false, initialized: false, listening: [], port: 4400 },
    { everConnected: false, initialized: true, listening: [], port: 4400 },
    { everConnected: false, initialized: true, listening: [5173], port: 4400 },
    { everConnected: true, initialized: true, listening: [5173], port: 4400 },
    { everConnected: true, initialized: true, listening: [], port: 4400, leaseExpired: true },
    { everConnected: false, initialized: false, listening: [], port: 4400, slowListeners: [5000] },
    {
      everConnected: false,
      initialized: false,
      listening: [],
      port: 4400,
      configsElsewhere: [{ directory: '/other/repo', projectId: 'other' }],
    },
  ];

  it.each(branches.map((f, i) => [i, f] as const))('branch %i names reticle_lease', (_i, facts) => {
    expect(
      diagnoseNoSession(facts),
      'an agent with no shell and no session has no other way out of this branch',
    ).toContain('reticle_lease');
  });
});

/**
 * A daemon past the stall threshold with no app connected — the install never finished.
 *
 * This is the funnel's biggest silence: the daemon is up, the agent has the tools, and the app
 * never arrived. The telemetry has known about it since day one; the user-facing diagnosis was
 * silent about it, and a reader in that state was sent down an investigation that never mentioned
 * the simplest explanation.
 */
describe('a stalled install is surfaced in the diagnosis', () => {
  it('mentions the stall when daemon is past threshold and no app connected', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
      daemonUpMs: STALL_AFTER_MS + 1,
    });
    expect(msg).toMatch(/\d+ minutes/);
    expect(msg).toMatch(/no.+app.+(connected|arrived)/i);
  });

  it('does NOT mention the stall when an app has connected', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
      daemonUpMs: STALL_AFTER_MS + 1,
    });
    expect(msg).not.toMatch(/\d+ minutes.*no.+app/i);
  });

  it('does NOT mention the stall below the threshold', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
      daemonUpMs: STALL_AFTER_MS - 1,
    });
    expect(msg).not.toMatch(/\d+ minutes.*no.+app/i);
  });

  it('still mentions it on the no-listener branch when initialized', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
      daemonUpMs: STALL_AFTER_MS + 1,
    });
    expect(msg).toMatch(/\d+ minutes/);
  });

  it('does NOT mention it when the project is not initialized', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
      daemonUpMs: STALL_AFTER_MS + 1,
    });
    expect(msg).not.toMatch(/\d+ minutes.*no.+app/i);
  });
});
