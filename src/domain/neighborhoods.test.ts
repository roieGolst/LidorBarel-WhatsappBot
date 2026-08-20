import { describe, expect, it } from 'vitest';
import { normalizeNeighborhood } from './neighborhoods.js';

describe('normalizeNeighborhood', () => {
  it('recognises a canonical named neighborhood', () => {
    const match = normalizeNeighborhood('רמות');
    expect(match).toEqual({ canonical: 'רמות', original: 'רמות', known: true });
  });

  it('normalizes geresh/apostrophe variants of lettered neighborhoods', () => {
    expect(normalizeNeighborhood('שכונה ט').canonical).toBe('שכונה ט׳');
    expect(normalizeNeighborhood("ט'").canonical).toBe('שכונה ט׳');
    expect(normalizeNeighborhood('ג').canonical).toBe('שכונה ג׳');
  });

  it('normalizes spelling variants and the שכונת prefix', () => {
    expect(normalizeNeighborhood('נוה זאב').canonical).toBe('נווה זאב');
    expect(normalizeNeighborhood('שכונת נווה זאב').canonical).toBe('נווה זאב');
  });

  it('accepts an unknown neighborhood, preserving the original and never guessing', () => {
    const match = normalizeNeighborhood('שכונה חדשה כלשהי');
    expect(match.known).toBe(false);
    expect(match.canonical).toBeNull();
    expect(match.original).toBe('שכונה חדשה כלשהי');
  });

  it('trims but otherwise preserves the original', () => {
    expect(normalizeNeighborhood('  רמות  ').original).toBe('רמות');
  });
});
