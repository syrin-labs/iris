/**
 * Two InstrumentationGapKind enums is how `reticle_domain` says `missing-signal` while honesty
 * says `no-signal-on-mutation` for the same absence. Core is the contract. This file must not
 * grow a second copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('oracles use the core gap vocabulary', () => {
  it('self-instrument.ts does not declare its own InstrumentationGapKind', () => {
    const src = readFileSync(join(HERE, 'self-instrument.ts'), 'utf8');
    expect(src).not.toMatch(/export const InstrumentationGapKind/);
    expect(src).toMatch(/from '@reticlehq\/core'/);
  });

  it('flow-instrument-gaps.ts does not import a local gap kind', () => {
    const src = readFileSync(join(HERE, 'flow-instrument-gaps.ts'), 'utf8');
    expect(src).not.toMatch(/InstrumentationGapKind.*from '\.\/self-instrument/);
    expect(src).toMatch(/InstrumentationGapKind.*from '@reticlehq\/core'/);
  });

  it('does not emit the retired oracle-local kind strings', () => {
    const self = readFileSync(join(HERE, 'self-instrument.ts'), 'utf8');
    const flow = readFileSync(join(HERE, 'flow-instrument-gaps.ts'), 'utf8');
    for (const src of [self, flow]) {
      expect(src).not.toMatch(/['"]missing-signal['"]/);
      expect(src).not.toMatch(/['"]unregistered-store['"]/);
    }
  });
});
