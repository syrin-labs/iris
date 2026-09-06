import { describe, expect, it } from 'vitest';
import { streamlitPageSnippet } from './snippets.js';
import { SERVER_VERSION } from '../version/server-version.js';

const snippet = streamlitPageSnippet("{ token: 'tok_abc123' }");

describe('the Streamlit executable HTML helper', () => {
  it('runs a dynamic SDK import through Streamlit explicit JavaScript support', () => {
    expect(snippet).toContain('st.html');
    expect(snippet).toContain('unsafe_allow_javascript=True');
    expect(snippet).toContain("void import('https://");
  });

  it('is idempotent across Streamlit reruns', () => {
    expect(snippet).toContain("getElementById('reticle-streamlit-connect')");
    expect(snippet.match(/marker\.id = 'reticle-streamlit-connect'/g)).toHaveLength(1);
    expect(snippet).toContain('marker.remove()');
  });

  it('pins the browser SDK and carries the local pairing token', () => {
    expect(snippet).toContain(`@reticlehq/browser@${SERVER_VERSION}/+esm`);
    expect(snippet).toContain("reticle.connect({ token: 'tok_abc123' })");
  });
});
