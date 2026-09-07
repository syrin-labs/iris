import { describe, expect, it } from 'vitest';
import { PortPresence } from '../daemon/port-presence.js';
import { bridgeOccupied } from './bridge-port.js';

/**
 * The bridge is the channel between the daemon and the SDK in the page. While something else holds
 * that port no session can EVER appear, however correct the wiring is — so a run that goes ahead
 * spends its whole budget and then blames the app's instrumentation, which is the wrong place
 * entirely.
 *
 * `serve` already refuses a held port, with prose written for someone starting a daemon. This is the
 * same fact told to someone installing: it has to say what the bridge is, because that is the part
 * that makes "no session appeared" make sense.
 */
describe('init refuses to start over an occupied bridge', () => {
  it('refuses when something that is not a daemon holds the port', () => {
    const refusal = bridgeOccupied(PortPresence.FOREIGN, 59996);
    expect(refusal).toContain('is held by something that is not a Reticle daemon');
    expect(refusal).toContain('59996');
  });

  // Our own daemon on that port is the NORMAL case — that is what init connects to.
  it('says nothing when a Reticle daemon holds it', () => {
    expect(bridgeOccupied(PortPresence.DAEMON, 4400)).toBeUndefined();
  });

  it('says nothing when the port is free', () => {
    expect(bridgeOccupied(PortPresence.FREE, 4400)).toBeUndefined();
  });

  // The refusal has to name both ways out, or it is a dead end.
  it('names how to get out of it', () => {
    const refusal = bridgeOccupied(PortPresence.FOREIGN, 4400);
    expect(refusal).toContain('--port');
    expect(refusal).toContain('.reticle.json');
  });
});
