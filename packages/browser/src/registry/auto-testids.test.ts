import { describe, it, expect, beforeEach } from 'vitest';
import { domTestids, MAX_AUTO_TESTIDS } from './auto-testids.js';

describe('domTestids', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the testids the app actually rendered', () => {
    document.body.innerHTML =
      '<button data-testid="pay">Pay</button><input data-testid="amount" />';
    expect(domTestids(document)).toEqual(['pay', 'amount']);
  });

  it('returns nothing for a page with no testids', () => {
    document.body.innerHTML = '<button>Pay</button>';
    expect(domTestids(document)).toEqual([]);
  });

  it('drops blanks and duplicates', () => {
    document.body.innerHTML =
      '<i data-testid="row"></i><i data-testid="row"></i><i data-testid=""></i>';
    expect(domTestids(document)).toEqual(['row']);
  });

  it('caps a list a big table would otherwise make unbounded', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_AUTO_TESTIDS + 25 },
      (_unused, i) => `<i data-testid="row-${String(i)}"></i>`,
    ).join('');
    expect(domTestids(document)).toHaveLength(MAX_AUTO_TESTIDS);
  });
});
