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

  it('recognises the newer neighborhoods', () => {
    expect(normalizeNeighborhood('רובע החדשנות').known).toBe(true);
    expect(normalizeNeighborhood('שכונה י״א').canonical).toBe('שכונה י״א');
    expect(normalizeNeighborhood('יא').canonical).toBe('שכונה י״א');
  });

  it('folds alternate / former names onto the canonical name', () => {
    expect(normalizeNeighborhood('שיכון רסקו').canonical).toBe('נווה עופר');
    expect(normalizeNeighborhood('נווה מנחם').canonical).toBe('נחל עשן');
    expect(normalizeNeighborhood('פלח 6').canonical).toBe('נאות אברהם');
    expect(normalizeNeighborhood('פלח 7').canonical).toBe('נווה אילן');
    expect(normalizeNeighborhood('שכונת הפארק').canonical).toBe('פארק הנחל');
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
