import { describe, expect, it } from 'vitest';
import { describePage, PageFinding, readPage } from './page-probe.js';

const URL = 'http://localhost:5173/';

describe('what the page adds to the daemon account', () => {
  it('separates a page with the SDK from one without', () => {
    expect(readPage({ served: true, sdkInPage: false })).toBe(PageFinding.SDK_MISSING);
    expect(readPage({ served: true, sdkInPage: true })).toBe(PageFinding.SDK_PRESENT);
  });

  it('reports nothing answering as its own finding', () => {
    expect(readPage({ served: false, sdkInPage: false })).toBe(PageFinding.NOT_SERVED);
  });

  // A refused certificate means the server DID answer. Calling that "not served" sends someone to
  // start a dev server that is already running.
  it('ranks a refused certificate above "not served", because the server answered', () => {
    expect(readPage({ served: false, sdkInPage: false, tlsRefused: true })).toBe(
      PageFinding.TLS_REFUSED,
    );
  });
});

describe('the sentence each finding contributes', () => {
  // The most common failure in the product, so it must be the first thing said.
  it('leads with the stale bundle when the SDK is absent', () => {
    expect(describePage(PageFinding.SDK_MISSING, URL)).toContain(
      'before the build config was edited',
    );
  });

  it('says the app may be fine when only the certificate stopped us', () => {
    expect(describePage(PageFinding.TLS_REFUSED, URL)).toContain('may be perfectly fine');
  });

  it('names the early-return causes when the SDK is present and silent', () => {
    expect(describePage(PageFinding.SDK_PRESENT, URL)).toContain('localhost guard');
  });

  it('gives a different sentence for every finding', () => {
    const all = Object.values(PageFinding).map((f) => describePage(f, URL));
    expect(new Set(all).size).toBe(all.length);
  });

  it('always names the url, so the sentence stands alone in a log', () => {
    for (const f of Object.values(PageFinding)) expect(describePage(f, URL)).toContain(URL);
  });
});

/**
 * The wording is a contract, not prose.
 *
 * These sentences were written in setup/reticle.mjs and the break-matrix asserts them verbatim —
 * it is a negative control, and it judges a setup script by whether its failures NAME the cause.
 * Porting the runtime phase into `init` carried the behaviour across but not the words, so eight
 * scenarios reported "never said 'nothing is serving'" against a run that had diagnosed the problem
 * correctly and described it differently.
 *
 * Two rules follow. The sentence leads with what is wrong rather than with the observation, and it
 * names the url — an agent greps this, and a human reads it after waiting out a timeout.
 */
describe('the diagnosis says what the break-matrix asserts', () => {
  it('leads with "nothing is serving" and names the url', () => {
    const line = describePage(PageFinding.NOT_SERVED, 'http://127.0.0.1:59985/');
    expect(line).toContain('nothing is serving');
    expect(line).toContain('http://127.0.0.1:59985/');
  });

  // "would not accept" vs "will not accept" — one word, and the scenario that pins it is the one
  // where the server is UP and healthy, so a wrong reading sends someone to start it again.
  it('says the certificate is one this process WILL not accept', () => {
    const line = describePage(PageFinding.TLS_REFUSED, 'https://127.0.0.1:59993/');
    expect(line).toContain('certificate this process will not accept');
  });

  it('still names the two readable outcomes distinctly', () => {
    expect(describePage(PageFinding.SDK_MISSING, 'http://x/')).toContain('SDK is NOT in the page');
    expect(describePage(PageFinding.SDK_PRESENT, 'http://x/')).toContain('SDK IS in the page');
  });
});
