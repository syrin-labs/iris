/**
 * A write whose transport was displaced must not become a claim about the app.
 */
import { describe, expect, it } from 'vitest';
import { dispatchAct } from './act-preflight.js';
import { SessionReplacedError } from '../session/pending-commands.js';
import { CommandTimeoutError } from '../session/pending-commands.js';
import { followLostObservation } from './act-observation.js';
import type { Session } from '../session/session.js';

describe('dispatchAct', () => {
  it('returns the result when nothing displaced the transport', async () => {
    await expect(dispatchAct(() => Promise.resolve({ ok: true }))).resolves.toStrictEqual({
      ok: true,
    });
  });

  it('reports a displaced write as unobserved rather than throwing transport at the caller', async () => {
    const out = await dispatchAct(() => Promise.reject(new SessionReplacedError('replaced')));
    expect(out).toBeNull();
  });

  it('NEVER re-sends the write — one call in, one call out', async () => {
    let sent = 0;
    await dispatchAct(() => {
      sent += 1;
      return Promise.reject(new SessionReplacedError('replaced'));
    });
    expect(sent).toBe(1);
  });

  it('leaves every other failure alone, so a timeout cannot launder into a shrug', async () => {
    await expect(
      dispatchAct(() => Promise.reject(new CommandTimeoutError('slow'))),
    ).rejects.toThrow(/slow/);
    await expect(dispatchAct(() => Promise.reject(new Error('act failed')))).rejects.toThrow(
      /act failed/,
    );
  });
});

const sessionAt = (id: string, url: string, elapsed: number): Session =>
  ({ id, url, elapsed: () => elapsed }) as unknown as Session;

describe('followLostObservation', () => {
  const registry = (all: readonly Session[]) => ({
    get: (id: string) => all.find((s) => s.id === id),
    all: () => all,
  });

  it('leaves a verdict that was actually observed untouched', async () => {
    const session = sessionAt('a', 'http://app.test/', 0);
    const out = await followLostObservation({
      sessions: registry([session]),
      session,
      verdict: { pass: false },
      timeout: 1000,
      predicateStarted: 0,
      reevaluate: () => Promise.reject(new Error('must not re-ask')),
    });
    expect(out.followed).toBe(false);
    expect(out.verdict.pass).toBe(false);
  });

  it('re-asks on the document that took over, so a green survives the navigation', async () => {
    const departed = sessionAt('a', 'http://app.test/login', 10);
    const next = sessionAt('b', 'http://app.test/home', 0);
    const out = await followLostObservation({
      sessions: registry([departed, next]),
      session: departed,
      verdict: { pass: false, observationLost: true },
      timeout: 1000,
      predicateStarted: 0,
      reevaluate: (s, budget) => {
        expect(s.id).toBe('b');
        expect(budget).toBeLessThanOrEqual(1000);
        return Promise.resolve({ pass: true });
      },
    });
    expect(out.followed).toBe(true);
    expect(out.session.id).toBe('b');
    expect(out.verdict.pass).toBe(true);
  });

  it('does not follow when no budget is left — a refunded budget is a wait nobody asked for', async () => {
    const departed = sessionAt('a', 'http://app.test/login', 5000);
    const next = sessionAt('b', 'http://app.test/home', 0);
    const out = await followLostObservation({
      sessions: registry([departed, next]),
      session: departed,
      verdict: { pass: false, observationLost: true },
      timeout: 1000,
      predicateStarted: 0,
      reevaluate: () => Promise.reject(new Error('must not re-ask')),
    });
    expect(out.followed).toBe(false);
  });

  it('refuses to guess between two live tabs at the same origin', async () => {
    const departed = sessionAt('a', 'http://app.test/login', 0);
    const out = await followLostObservation({
      sessions: registry([
        departed,
        sessionAt('b', 'http://app.test/home', 0),
        sessionAt('c', 'http://app.test/other', 0),
      ]),
      session: departed,
      verdict: { pass: false, observationLost: true },
      timeout: 60,
      predicateStarted: 0,
      reevaluate: () => Promise.reject(new Error('must not re-ask')),
    });
    expect(out.followed).toBe(false);
  });
});
