/**
 * Did the document this app served carry any Reticle at all?
 *
 * `LeaseEvidence.sdkMarker` was read in two places and set by nothing, so the clause that
 * distinguishes "installed but not connecting" from "never installed" could never fire. That
 * distinction is the whole difference between the diagnosis a new user needs and the four causes
 * they were getting, every one of which presupposes the SDK is already there.
 *
 * The probe is a plain GET of the page that was just loaded, so it costs one localhost round trip on
 * a path that has already failed and is about to print a paragraph.
 *
 * ## Every uncertainty resolves to silence, on purpose
 *
 * `true` requires the EXACT marker the Vite plugin injects into `<head>` of every served document —
 * a constant this repo already owns, so there is no new contract and no guessing.
 *
 * `false` requires the served document to contain no `reticle` anywhere, in any case. That is the
 * only evidence strong enough to say "this app ships no SDK", and it is deliberately harder to earn
 * than `true` is: a false `false` accuses a working install, and a false `true` SUPPRESSES the one
 * instruction an uninstrumented user needs. Both are worse than saying nothing.
 *
 * Anything else — a fetch that failed, a timeout, a document that mentions Reticle without the
 * marker (a Next or Babel install, where the SDK arrives through a module and never touches the
 * HTML) — returns `undefined`, and the hint says nothing about markers at all.
 */

import { RETICLE_RENDER_PREHOOK } from '@reticlehq/core';

/** A page that has not answered in this long is not going to inform a diagnosis. */
const PROBE_TIMEOUT_MS = 1_500;
/** Enough of the document to carry a head-prepended script; a whole SPA bundle is not wanted. */
const PROBE_MAX_BYTES = 200_000;

/** Pure: the verdict for a document body we managed to read. Exported so the rule is testable. */
export function readSdkMarker(body: string): boolean | undefined {
  if (body.includes(RETICLE_RENDER_PREHOOK)) return true;
  // Case-insensitive and deliberately broad: ANY mention is enough to withhold the accusation.
  if (!/reticle/i.test(body)) return false;
  return undefined;
}

/** Never throws, never hangs. A probe that can break the diagnosis is worse than no probe. */
export async function probeSdkMarker(url: string): Promise<boolean | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return undefined;
    const body = (await res.text()).slice(0, PROBE_MAX_BYTES);
    return readSdkMarker(body);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
