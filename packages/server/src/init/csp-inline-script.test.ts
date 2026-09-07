/**
 * #679: a CSP without `'unsafe-inline'` stops the pasted connect snippet from ever RUNNING.
 *
 * The `connect-src` check next door assumes the SDK got as far as opening a socket. Under
 * `script-src 'self'` it never does: `staticPageSnippet` prints an inline `<script type="module">`,
 * the browser refuses to execute it, and there is no SDK, no socket, and nothing for `connect-src`
 * to block. `reticle open` then reports "no session / app carries no SDK" — a true statement about
 * the wrong cause, and nothing in the setup surface names the real one.
 */
import { describe, expect, it } from 'vitest';
import { cspInlineScriptProblem, EXTERNAL_CONNECT_PATH } from './csp-check.js';
import { diagnoseWebCsp } from './csp-doctor.js';
import { staticPageSnippet } from './snippets.js';

const PORT = 4400;
const problem = (text: string): string | undefined => cspInlineScriptProblem(text, PORT);

describe('the snippet init prints is inline', () => {
  it('is exactly the shape a strict script-src refuses', () => {
    // If this ever stops being inline, the check below stops describing a real failure.
    expect(staticPageSnippet('{ port: 4400 }')).toContain('<script type="module">');
    expect(staticPageSnippet('{ port: 4400 }')).not.toContain('src=');
  });
});

describe('cspInlineScriptProblem', () => {
  it('fires on the helmet default shape', () => {
    const found = problem(`"script-src 'self'; connect-src 'self'"`);
    expect(found).toContain('does not admit an inline script');
    expect(found).toContain(EXTERNAL_CONNECT_PATH);
  });

  it('falls back to default-src, as every fetch-directive does', () => {
    expect(problem(`"default-src 'self'"`)).toBeDefined();
  });

  it('stays quiet when the policy admits inline scripts', () => {
    expect(problem(`"script-src 'self' 'unsafe-inline'"`)).toBeUndefined();
  });

  it('stays quiet when there is no policy at all', () => {
    expect(problem('export default { reactStrictMode: true }')).toBeUndefined();
  });

  it('does not read a host wildcard as permission to run inline code', () => {
    // The commonest CSP misconception. `*` is a host list; it says nothing about inline code, and
    // a policy written that way still refuses the snippet.
    expect(problem(`"script-src *"`)).toBeDefined();
  });

  it('reports a nonce policy, which makes browsers IGNORE unsafe-inline', () => {
    // And the nonce is minted for the app's own tags, so it would not cover a pasted snippet even
    // if the directive were read the other way.
    expect(problem(`"script-src 'self' 'nonce-abc123' 'unsafe-inline'"`)).toBeDefined();
  });

  it('reports strict-dynamic for the same reason', () => {
    expect(problem(`"script-src 'strict-dynamic' 'unsafe-inline'"`)).toBeDefined();
  });

  it('reports a hash policy for the same reason', () => {
    expect(problem(`"script-src 'sha256-abc=' 'unsafe-inline'"`)).toBeDefined();
  });

  it('names the external-module remedy rather than telling anyone to weaken the policy', () => {
    const found = problem(`"script-src 'self'"`) ?? '';
    expect(found).toContain('EXTERNAL module');
    expect(found).not.toContain("add 'unsafe-inline'");
    // And says what the external form costs, which is the companion failure.
    expect(found).toContain('DEFERRED');
  });

  it('still names the connect-src entry, because both are needed', () => {
    expect(problem(`"script-src 'self'"`)).toContain(`ws://localhost:${String(PORT)}`);
  });
});

describe('diagnoseWebCsp', () => {
  const read =
    (files: Record<string, string>) =>
    (relative: string): string | undefined =>
      files[relative];

  it('reports the blocked snippet on a policy that also blocks the socket', () => {
    // script-src is the EARLIER failure: with no SDK the socket is never opened, so a connect-src
    // finding on the same file would describe a block that cannot happen yet.
    const findings = diagnoseWebCsp(
      read({ 'next.config.js': `"script-src 'self'; connect-src 'self'"` }),
      PORT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain('does not admit an inline script');
    expect(findings[0]?.fix).toContain(EXTERNAL_CONNECT_PATH);
  });

  it('still reports the socket block when scripts are allowed', () => {
    const findings = diagnoseWebCsp(
      read({ 'next.config.js': `"script-src 'self' 'unsafe-inline'; connect-src 'self'"` }),
      PORT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain('connect-src');
  });

  it('finds nothing on an app with no CSP', () => {
    expect(diagnoseWebCsp(read({ 'next.config.js': 'export default {}' }), PORT)).toEqual([]);
  });
});
