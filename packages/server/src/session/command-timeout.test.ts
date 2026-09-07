import { describe, expect, it } from 'vitest';
import { commandTimeoutMessage } from './command-timeout.js';

const TAURI = 'http://localhost:5175/';
const ELECTRON = 'file:///Users/me/app/dist/index.html';
const WEB = 'http://localhost:3000/dashboard';

describe('commandTimeoutMessage — an 8s timeout should say what to DO', () => {
  it('keeps the bare fact for an ordinary web page', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: WEB,
      hidden: false,
      runtime: 'web',
    });
    expect(message).toContain("command 'snapshot' timed out after 8000ms");
    // No desktop advice on a web page — a wrong explanation is worse than none.
    expect(message).not.toMatch(/Space|WKWebView/);
  });

  /**
   * The case this exists for: a Tauri window hidden BEFORE its webview was first presented never
   * loads its page, so every command times out with nothing saying why. Eight seconds of silence
   * followed by "timed out" sends someone hunting through their own app code for a bug that is not
   * there.
   */
  it('explains the hidden-before-load trap for a Tauri session that has gone quiet', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
    });
    expect(message).toContain('WKWebView');
    expect(message).toMatch(/on_page_load/);
    // It must still carry the original fact — the advice is added, never substituted.
    expect(message).toContain("command 'snapshot' timed out after 8000ms");
  });

  /**
   * A page that was heard from moments ago is executing JavaScript, so "hung/hidden/suspended" cannot
   * be the explanation whatever `hidden` reports — the two facts contradict, and the fresher one wins.
   *
   * This is an invariant, not a war story: the Tauri investigation that prompted it went fully silent
   * instead (`lastSeenMs` 15s at timeout), so the hidden-window diagnosis was right THERE. The branch
   * exists for the genuinely different state where the SDK is still talking.
   */
  it('says the page is alive when events are still arriving, overriding the hidden story', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
      lastSeenMs: 120,
    });
    expect(message).toContain('ALIVE');
    expect(message).toMatch(/OUT and not back IN/);
    // The hidden-window diagnosis must NOT also appear — two contradictory causes is worse than one.
    expect(message).not.toMatch(/never presents|on_page_load/);
  });

  it('keeps the hidden-window diagnosis when the page has genuinely gone quiet', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
      lastSeenMs: 30_000,
    });
    expect(message).toMatch(/on_page_load/);
    expect(message).not.toContain('ALIVE');
  });

  /**
   * The ordering is INFERRED, never observed — the only evidence here is `hidden === true`. Measured
   * on a Tauri shell pointed at an external http origin whose window nothing ever hid: the message
   * prescribed a fix for a mistake that had not been made, and two rounds of debugging went into the
   * wrong place. A confidently wrong cause is worse than a bare timeout, which at least sends the
   * reader looking. So the message must rank causes rather than assert one.
   */
  it('offers more than one cause instead of asserting the ordering as fact', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
    });
    expect(message).toMatch(/likely|most likely/i);
    expect(message).toMatch(/\(2\)/);
    expect(message).not.toMatch(/never presents, so it never runs/);
  });

  /**
   * The advice used to blame occlusion, which is measurably false: a LOADED Tauri webview answers
   * while minimized, app-hidden, occluded and on another Space. Telling someone to go move a window
   * costs them the hour this message exists to save, so the wrong cause must not come back.
   */
  it('does not blame occlusion or Spaces, which do not suspend a loaded webview', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
    });
    expect(message).not.toMatch(/Space|occlud|suspend/i);
  });

  /**
   * Hiding AFTER load used to be documented as safe. A hidden macOS WKWebView has been observed
   * to go quiet after a pause, even though capture still works — and the timeout must not send
   * someone back to hide() as the fix, even on a machine that never hits that pause.
   */
  it('does not claim that hiding after load is safe', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: true,
      runtime: 'tauri',
    });
    expect(message).not.toMatch(/hiding it is safe/i);
    expect(message).toMatch(/off-screen/);
    // Rank the pause as observed, never as a fact every Mac will hit.
    expect(message).toMatch(/observed/);
    expect(message).not.toMatch(/stops answering/);
  });

  /**
   * Electron shows its window before hiding it, so it never hits this. Diagnosing it there would
   * send the user to change code that was never the problem.
   */
  it('does not offer the Tauri diagnosis on Electron', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: ELECTRON,
      hidden: true,
      runtime: 'electron',
    });
    expect(message).not.toContain('WKWebView');
  });

  it('says nothing when the page reports itself visible', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: TAURI,
      hidden: false,
      runtime: 'tauri',
    });
    expect(message).not.toContain('WKWebView');
  });

  /**
   * A Tauri dev server and a plain web app both live on http://localhost — the URL cannot tell them
   * apart, so a hidden localhost page must NOT be diagnosed as Tauri. The runtime is only knowable
   * when the app said so.
   */
  it('does not guess Tauri from a localhost URL alone', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: 'http://localhost:3000/',
      hidden: true,
      runtime: 'web',
    });
    expect(message).not.toContain('WKWebView');
  });

  it('diagnoses a tauri:// origin without needing any hint', () => {
    const message = commandTimeoutMessage('snapshot', 8000, {
      url: 'tauri://localhost/',
      hidden: true,
    });
    expect(message).toContain('WKWebView');
  });
});
