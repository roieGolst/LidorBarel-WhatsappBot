import { describe, expect, it } from 'vitest';
import { isPlausibleNeighborhood, sanitizeExtraction } from './validateAnswer.js';

describe('isPlausibleNeighborhood', () => {
  it('rejects Latin- or number-dominated garbage', () => {
    expect(isPlausibleNeighborhood('Opus 4.8')).toBe(false);
    expect(isPlausibleNeighborhood('12345')).toBe(false);
    expect(isPlausibleNeighborhood('')).toBe(false);
  });

  it('accepts Hebrew place names, including bare-letter neighborhoods', () => {
    expect(isPlausibleNeighborhood('רמות')).toBe(true);
    expect(isPlausibleNeighborhood('שכונה ט׳')).toBe(true);
    expect(isPlausibleNeighborhood('ד׳')).toBe(true);
  });
});

describe('sanitizeExtraction', () => {
  it('drops an implausible neighborhood so it is never stored or advanced', () => {
    const result = sanitizeExtraction({ neighborhood: 'Opus 4.8' });
    expect(result.extracted.neighborhood).toBeUndefined();
    expect(result.invalidNeighborhood).toBe('Opus 4.8');
  });

  it('keeps a valid neighborhood, normalizing known aliases', () => {
    const result = sanitizeExtraction({ neighborhood: 'שכונה ט' });
    expect(result.extracted.neighborhood).toBe('שכונה ט׳');
    expect(result.invalidNeighborhood).toBeUndefined();
  });

  it('accepts an unrecognised but plausible Hebrew place verbatim', () => {
    const result = sanitizeExtraction({ neighborhood: 'שכונה חדשה כלשהי' });
    expect(result.extracted.neighborhood).toBe('שכונה חדשה כלשהי');
  });

  it('leaves enum answers untouched', () => {
    const result = sanitizeExtraction({ sellIntent: 'ready', currentlyMarketed: 'no' });
    expect(result.extracted).toEqual({ sellIntent: 'ready', currentlyMarketed: 'no' });
    expect(result.invalidNeighborhood).toBeUndefined();
  });
});
