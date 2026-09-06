import { describe, it, expect } from 'vitest';
import { describeSplitTextMiss } from './split-text-miss.js';

/**
 * The clause exists to separate two failures that produced the SAME verdict: an element that never
 * rendered, and a label the app rendered across several children. Only the second is recoverable,
 * and only if the message says so.
 */
describe('describeSplitTextMiss', () => {
  it('says nothing when the browser found no container', () => {
    // An ordinary miss keeps the short message. A clause that fires on every failure carries nothing.
    expect(describeSplitTextMiss(undefined)).toBeUndefined();
  });

  it('names the container and hands back a query that resolves', () => {
    const message = describeSplitTextMiss({ ref: 'e12', role: 'button', name: 'Move to Folder' });
    expect(message).toContain("button 'Move to Folder'");
    expect(message).toContain("{ scope: 'e12', self: true }");
  });

  it('states that no text query can match, not merely that this one did not', () => {
    // The agent's next move after "no element matched" is another text guess. The message has to
    // close that door explicitly or it buys nothing.
    const message = describeSplitTextMiss({ ref: 'e3', role: 'listitem' });
    expect(message).toContain('IS on the page');
    expect(message).toContain('no text query can match');
  });

  it('falls back to a scoping instruction when the container has no ref', () => {
    // A descriptor without a ref cannot be pasted, so the advice has to stay actionable in words.
    const message = describeSplitTextMiss({ role: 'paragraph' });
    expect(message).toContain('scope to that container');
    expect(message).not.toContain('undefined');
  });

  it('describes a container with no role as an element rather than an empty string', () => {
    const message = describeSplitTextMiss({ ref: 'e9' });
    expect(message).toContain('element');
    expect(message).not.toContain("''");
  });

  it('bounds the container name, so the verdict does not grow with the page', () => {
    // The property is that the message is BOUNDED, not that it is short: asserting a byte count
    // pins today's wording and reddens on an edit that changed nothing that matters.
    const shorter = describeSplitTextMiss({ ref: 'e1', role: 'region', name: 'x'.repeat(200) });
    const longer = describeSplitTextMiss({ ref: 'e1', role: 'region', name: 'x'.repeat(5000) });
    expect(shorter).toContain('…');
    expect(longer).toEqual(shorter);
  });
});
