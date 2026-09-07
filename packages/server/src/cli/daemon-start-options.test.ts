/**
 * The flag has to SURVIVE the trip to startDaemon.
 *
 * Parsing `--headed` correctly and then discarding it is indistinguishable, from the CLI, from not
 * supporting the flag at all — and that is exactly how it shipped.
 */
import { describe, expect, it } from 'vitest';
import { daemonSpawnArgs, daemonStartOptions } from './daemon-start-options.js';

const flags = (over: Partial<Parameters<typeof daemonStartOptions>[0]> = {}) => ({
  port: 4400,
  headless: true,
  http: false,
  ...over,
});

describe('daemonStartOptions', () => {
  it('carries --headed through even when no --drive url was given', () => {
    // The regression: headless rode inside the driveUrl branch, so this case lost it entirely and
    // the pool fell back to its hidden default.
    expect(daemonStartOptions(flags({ headless: false })).headless).toBe(false);
  });

  it('carries it through with a drive url too', () => {
    const o = daemonStartOptions(flags({ headless: false, driveUrl: 'http://localhost:3000' }));
    expect(o.headless).toBe(false);
    expect(o.driveUrl).toBe('http://localhost:3000');
  });

  it('keeps headless true when the flag was not passed', () => {
    expect(daemonStartOptions(flags()).headless).toBe(true);
  });

  it('omits driveUrl entirely rather than passing undefined', () => {
    expect('driveUrl' in daemonStartOptions(flags())).toBe(false);
  });

  it('passes the http verify options through untouched', () => {
    const o = daemonStartOptions(flags({ http: true, httpPort: 9000, httpToken: 't' }));
    expect(o.httpVerify).toBe(true);
    expect(o.httpVerifyPort).toBe(9000);
    expect(o.httpVerifyToken).toBe('t');
  });
});

describe('daemonSpawnArgs', () => {
  it('forwards --headed to the child with no --drive url', () => {
    // The second half of the same bug: parsed correctly, then not passed on to the process that
    // actually launches the browser.
    expect(daemonSpawnArgs(flags({ headless: false }))).toContain('--headed');
  });

  it('forwards it alongside a drive url too', () => {
    const a = daemonSpawnArgs(flags({ headless: false, driveUrl: 'http://localhost:3000' }));
    expect(a).toContain('--headed');
    expect(a).toContain('http://localhost:3000');
  });

  it('never passes --headed when headless was left on', () => {
    expect(daemonSpawnArgs(flags())).not.toContain('--headed');
  });

  it('names the inner command and port first', () => {
    expect(daemonSpawnArgs(flags()).slice(0, 3)).toEqual(['_daemon', '--port', '4400']);
  });

  it('carries the http verify flags', () => {
    const a = daemonSpawnArgs(flags({ http: true, httpPort: 9000, httpToken: 't' }));
    expect(a).toContain('--http');
    expect(a).toContain('9000');
    expect(a).toContain('t');
  });
});
