import { describe, expect, it } from 'vitest';
import { streamlitPageSnippet } from './snippets.js';
import { SERVER_VERSION } from '../version/server-version.js';

const snippet = streamlitPageSnippet("{ token: 'tok_abc123' }");

describe('the Streamlit parent-document helper', () => {
  it('executes from a Streamlit component but installs Reticle in the app document', () => {
    expect(snippet).toContain('streamlit.components.v1');
    expect(snippet).toContain('window.parent.document');
    expect(snippet).toContain("script.type = 'module'");
  });

  it('is idempotent across Streamlit reruns', () => {
    expect(snippet).toContain("getElementById('reticle-streamlit-connect')");
    expect(snippet.match(/script\.id = 'reticle-streamlit-connect'/g)).toHaveLength(1);
  });

  it('pins the browser SDK and carries the local pairing token', () => {
    expect(snippet).toContain(`@reticlehq/browser@${SERVER_VERSION}/+esm`);
    expect(snippet).toContain("reticle.connect({ token: 'tok_abc123' });");
  });
});
