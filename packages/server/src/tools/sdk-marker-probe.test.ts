import { describe, expect, it } from 'vitest';
import { RETICLE_RENDER_PREHOOK } from '@reticlehq/core';
import { readSdkMarker, probeSdkMarker } from './sdk-marker-probe.js';

/**
 * The asymmetry is the whole design. A false `true` suppresses the one instruction an uninstrumented
 * user needs; a false `false` accuses a working install of shipping no SDK. Both are worse than
 * saying nothing, so anything short of certainty returns undefined.
 */
describe('reading a served document for a Reticle marker', () => {
  it('says yes only on the exact marker the plugin injects', () => {
    expect(readSdkMarker(`<head><script>${RETICLE_RENDER_PREHOOK}</script></head>`)).toBe(true);
  });

  it('says no only when the document mentions Reticle nowhere at all', () => {
    expect(readSdkMarker('<html><body><div id="app"></div></body></html>')).toBe(false);
  });

  /**
   * A Next or Babel install brings the SDK in through a module and never touches the HTML, so a
   * document that mentions Reticle without the marker proves nothing in either direction.
   */
  it('stays silent when Reticle is mentioned but the marker is absent', () => {
    expect(readSdkMarker('<script src="/_next/static/reticle-chunk.js"></script>')).toBeUndefined();
    expect(readSdkMarker('<!-- reticle: disabled in prod -->')).toBeUndefined();
  });

  it('is case-insensitive about the mention, so casing cannot produce an accusation', () => {
    expect(readSdkMarker('<meta name="x" content="Reticle">')).toBeUndefined();
    expect(readSdkMarker('<meta name="x" content="RETICLE">')).toBeUndefined();
  });
});

describe('a probe that cannot answer says nothing', () => {
  it('returns undefined rather than throwing when nothing is listening', async () => {
    // Port 1 needs no fixture and is never a dev server.
    await expect(probeSdkMarker('http://127.0.0.1:1/')).resolves.toBeUndefined();
  });

  it('returns undefined on a malformed URL instead of breaking the diagnosis', async () => {
    await expect(probeSdkMarker('not a url')).resolves.toBeUndefined();
  });
});
