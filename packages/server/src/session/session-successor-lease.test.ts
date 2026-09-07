/**
 * A lease must not be inherited by somebody's real browser tab.
 *
 * Succession exists for the ordinary case: a click loads a new document, the SDK is torn down and
 * HELLOs back under a new id, and the agent should keep working. Matching on origin alone made that
 * true of ANY tab at that origin — so an expired lease silently redirected the next call into the
 * developer's own window, and reported success. Observed twice in one session.
 *
 * A leased tab is an isolated context an AGENT owns and no human can see. The developer's tab is a
 * different trust and visibility domain. Origin is not evidence they are the same document.
 */
import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { pickDocumentSuccessor } from './session-successor.js';

const leased = (id: string, url = 'http://localhost:4321/issues') => ({
  id,
  url: `${url}?${RETICLE_URL_PARAM.SESSION}=${id}`,
});
const plain = (id: string, url = 'http://localhost:4321/issues') => ({ id, url });

describe('a session that claims an identity only succeeds to the same claim', () => {
  it('does NOT hand a lease to an ordinary tab at the same origin', () => {
    const departed = leased('lease-a');
    expect(pickDocumentSuccessor([plain('s-human')], departed)).toBeUndefined();
  });

  it('does not hand a lease to a DIFFERENT lease at the same origin', () => {
    // Two concurrent leases are two isolated contexts; neither may adopt the other's work.
    expect(pickDocumentSuccessor([leased('lease-b')], leased('lease-a'))).toBeUndefined();
  });

  it('DOES follow the same lease across a document navigation', () => {
    // The case succession exists for: same lease, new document, new session id.
    const departed = leased('lease-a');
    const reborn = { id: 's-new', url: departed.url };
    expect(pickDocumentSuccessor([reborn], departed)?.id).toBe('s-new');
  });

  it('still follows an ordinary tab that claims nothing — the common reload', () => {
    expect(pickDocumentSuccessor([plain('s-new')], plain('s-old'))?.id).toBe('s-new');
  });

  it('still prefers an exact id match over any successor logic', () => {
    const departed = leased('lease-a');
    expect(pickDocumentSuccessor([departed, plain('s-other')], departed)?.id).toBe('lease-a');
  });

  it('refuses when two ordinary tabs could both be it — a guess would drive the wrong app', () => {
    expect(pickDocumentSuccessor([plain('s-1'), plain('s-2')], plain('s-old'))).toBeUndefined();
  });

  it('does not follow across origins, claimed or not', () => {
    const departed = leased('lease-a', 'http://localhost:4321/x');
    const elsewhere = {
      id: 's-new',
      url: `http://localhost:9999/x?${RETICLE_URL_PARAM.SESSION}=lease-a`,
    };
    expect(pickDocumentSuccessor([elsewhere], departed)).toBeUndefined();
  });

  it('tolerates a malformed url on either side rather than throwing', () => {
    expect(() => pickDocumentSuccessor([plain('s', 'not a url')], leased('lease-a'))).not.toThrow();
    expect(pickDocumentSuccessor([plain('s')], { id: 'x', url: 'not a url' })).toBeUndefined();
  });
});
