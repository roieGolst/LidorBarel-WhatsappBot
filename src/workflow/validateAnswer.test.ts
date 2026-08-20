import { describe, expect, it } from 'vitest';
import type { ExtractedFacts } from './classify.js';
import { isPlausibleNeighborhood, validateAnswers } from './validateAnswer.js';

const relevant = { relevantToSelling: true };

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

describe('validateAnswers', () => {
  it('rejects a nonsensical property answer and never stores it', () => {
    const extracted: ExtractedFacts = { neighborhood: 'Opus 4.8' };
    const result = validateAnswers(extracted, relevant);
    expect(result.validFacts.neighborhood).toBeUndefined();
    expect(result.invalidAttempts).toHaveLength(1);
    expect(result.invalidAttempts[0]?.field).toBe('neighborhood');
  });

  it('accepts a valid Hebrew neighborhood and adds the canonical name', () => {
    const result = validateAnswers({ neighborhood: 'רמות' }, relevant);
    expect(result.validFacts.neighborhood).toBe('רמות');
    expect(result.validFacts.neighborhoodCanonical).toBe('רמות');
    expect(result.unknownNeighborhood).toBeUndefined();
  });

  it('accepts an unknown Hebrew neighborhood verbatim and flags it for review', () => {
    const result = validateAnswers({ neighborhood: 'שכונה חדשה כלשהי' }, relevant);
    expect(result.validFacts.neighborhood).toBe('שכונה חדשה כלשהי');
    expect(result.validFacts.neighborhoodCanonical).toBeNull();
    expect(result.unknownNeighborhood).toBe('שכונה חדשה כלשהי');
  });

  it('treats enum answers as valid by construction', () => {
    const result = validateAnswers(
      { sellIntent: 'ready', timeline: 'immediate' },
      relevant,
    );
    expect(result.validFacts.sellIntent).toBe('ready');
    expect(result.validFacts.timeline).toBe('immediate');
    expect(result.invalidAttempts).toHaveLength(0);
  });

  it('stores a city outside Be’er Sheva separately and flags the service area', () => {
    const result = validateAnswers({ neighborhood: 'מרכז', city: 'תל אביב' }, relevant);
    expect(result.validFacts.city).toBe('תל אביב');
    expect(result.outsideServiceArea).toBe(true);
  });

  it('drops everything extracted from an off-topic message', () => {
    const result = validateAnswers(
      { neighborhood: 'רמות' },
      { relevantToSelling: false },
    );
    expect(result.validFacts.neighborhood).toBeUndefined();
    expect(result.invalidAttempts[0]?.reason).toContain('unrelated');
  });
});
