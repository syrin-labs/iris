/**
 * An app that registers nothing must say so on its FIRST verdict, not only if asked.
 *
 * `no-store-registered` fires when `stateAsked && stateUnwatched` — the agent has to explicitly
 * assert about state before the missing store is mentioned. That is the right rule for THAT gap:
 * it is about an assertion that could not be answered.
 *
 * It leaves the common case silent. An app whose `src/reticle-dev.ts` registers nothing drives
 * fine, produces verdicts, and never once mentions that it is under-instrumented — unless the agent
 * happens to ask about state, which an agent with no reason to suspect a problem will not do.
 *
 * That is the shape of the reported failure: `hasCapabilities: false` on every session, an empty
 * `reticle_state`, and an install that looked clean. The session has known the answer the whole
 * time — `hasCapabilities` is on `SessionInfo` — and no verdict ever consulted it.
 *
 * So a verdict drawn against an app that declared no capabilities carries the gap. Once per
 * session, like every other nudge: repeated on every call it becomes noise and gets tuned out.
 *
 * Both arms now also require `stateUnwatched` (#700). The fixtures below used to say
 * `hasCapabilities: false` with `stateUnwatched: false` — an app that registered nothing, which
 * nonetheless has a store to watch — and those two cannot both be true. That contradiction is
 * exactly what shipped: apps calling `registerStore()` without `registerCapabilities()` were told
 * "no state can be read from it" in the same response that read their state.
 */

import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind } from '@reticlehq/core';
import { gapsForAction } from './instrumentation-gaps.js';

/** A healthy action against a fully-declared app: nothing to report. */
const declared = {
  pass: true,
  // A source pointer, or `no-source-mapping` fires and this fixture stops being "healthy".
  source: 'src/components/Login.tsx:81',
  stateAsked: false,
  stateUnwatched: false,
  domMutated: true,
  signalsFired: 1,
  routeChanged: false,
  routeSignalFired: false,
  proved: true,
  hasCapabilities: true,
} as const;

const kinds = (facts: Parameters<typeof gapsForAction>[0]) =>
  gapsForAction(facts).map((g) => g.kind);

describe('an app that declared no capabilities is told once', () => {
  it('reports the gap even when the agent never asked about state', () => {
    expect(kinds({ ...declared, hasCapabilities: false, stateUnwatched: true })).toContain(
      InstrumentationGapKind.NO_STORE_REGISTERED,
    );
  });

  /**
   * The reported defect (#700). An app that calls `registerStore()` and not
   * `registerCapabilities()` has no declaration and a perfectly readable store, and was told its
   * state could not be read — beside a response carrying `reticle_state { found: true }`, a
   * populated `stateDiffs`, and `statePathsChanged` naming the store.
   */
  it('stays silent when a store IS registered, however the app declared itself', () => {
    expect(kinds({ ...declared, hasCapabilities: false, stateUnwatched: false })).not.toContain(
      InstrumentationGapKind.NO_STORE_REGISTERED,
    );
  });

  /**
   * The point of the change: an agent driving a healthy-looking flow gets told, without having to
   * suspect anything first.
   */
  it('reports it on a PROVED verdict, where nothing else would raise it', () => {
    const gaps = gapsForAction({
      ...declared,
      hasCapabilities: false,
      stateUnwatched: true,
      proved: true,
    });
    expect(gaps.length).toBeGreaterThan(0);
  });
});

describe('the sentence says which of the two conditions it was', () => {
  /**
   * Describing an assertion about state to an agent that made no such assertion is a false
   * explanation. A gap nobody can act on is worse than no gap: it costs the trip and teaches the
   * wrong lesson about what went wrong.
   */
  it('an app that declared nothing is not told its assertion was about state', () => {
    const [gap] = gapsForAction({ ...declared, hasCapabilities: false, stateUnwatched: true });
    expect(gap?.missing).toMatch(/declared no capabilities/i);
    expect(gap?.missing).not.toMatch(/this assertion was about state/i);
  });

  it('says the consequence in terms an agent can act on', () => {
    const [gap] = gapsForAction({ ...declared, hasCapabilities: false, stateUnwatched: true });
    expect(gap?.cost).toMatch(/reticle_state will stay empty/i);
  });

  it('keeps the original sentence for the assertion case', () => {
    const [gap] = gapsForAction({
      ...declared,
      hasCapabilities: true,
      stateAsked: true,
      stateUnwatched: true,
    });
    expect(gap?.missing).toMatch(/this assertion was about state/i);
  });
});

describe('it stays quiet where it should', () => {
  it('says nothing about a fully declared app', () => {
    expect(kinds(declared)).toEqual([]);
  });

  /**
   * Callers that predate this field must not start reporting a gap they cannot substantiate.
   * Undefined means "not known", and not-known must never become an accusation.
   */
  it('says nothing when capabilities are unknown', () => {
    const { hasCapabilities: _drop, ...withoutField } = declared;
    expect(kinds(withoutField as Parameters<typeof gapsForAction>[0])).toEqual([]);
  });

  /** The existing rule still stands on its own terms. */
  it('still fires for an assertion about state with no store', () => {
    expect(
      kinds({ ...declared, stateAsked: true, stateUnwatched: true, hasCapabilities: true }),
    ).toContain(InstrumentationGapKind.NO_STORE_REGISTERED);
  });

  it('does not report the same gap twice when both conditions hold', () => {
    const k = kinds({
      ...declared,
      stateAsked: true,
      stateUnwatched: true,
      hasCapabilities: false,
    });
    expect(k.filter((x) => x === InstrumentationGapKind.NO_STORE_REGISTERED)).toHaveLength(1);
  });
});
