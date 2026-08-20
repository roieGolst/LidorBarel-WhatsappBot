import { describe, expect, it } from 'vitest';
import { selectVideo, type CatalogVideo } from './testimonial.js';

const tet: CatalogVideo = {
  id: 'tet',
  path: 'recommendations/tet.mp4',
  type: 'testimonial',
  neighborhoods: ['שכונה ט׳'],
  audience: 'seller',
};
const generalA: CatalogVideo = {
  id: 'gen-a',
  path: 'recommendations/gen-a.mp4',
  type: 'testimonial',
  neighborhoods: [],
  audience: 'seller',
};
const promo: CatalogVideo = {
  id: 'promo',
  path: 'recommendations/promo.mp4',
  type: 'promo_investment',
  neighborhoods: [],
  audience: 'investor',
};

const first = () => 0;

describe('selectVideo — testimonials', () => {
  it('prefers a neighborhood-specific video when the neighborhood matches', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: 'שכונה ט׳',
      assets: [generalA, tet],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') {
      expect(result.asset.id).toBe('tet');
      expect(result.matchedNeighborhood).toBe(true);
    }
  });

  it('falls back to a general testimonial when no neighborhood matches', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: 'שכונה ג׳',
      assets: [tet, generalA],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.asset.id).toBe('gen-a');
  });

  it('uses a general testimonial (never guesses) when the neighborhood is unknown', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: null,
      assets: [tet, generalA],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.asset.neighborhoods).toEqual([]);
  });

  it('sends nothing when only neighborhood-specific videos exist and none match', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: 'שכונה ג׳',
      assets: [tet],
      random: first,
    });
    expect(result.kind).toBe('none');
  });
});

describe('selectVideo — investment promo', () => {
  it('sends the promo to an investor', () => {
    const result = selectVideo({
      track: 'investment_promo',
      intent: 'investor',
      assets: [promo],
      random: first,
    });
    expect(result.kind).toBe('send');
  });

  it('withholds the promo from a seller and when intent is unclear', () => {
    for (const intent of ['seller', 'unclear'] as const) {
      const result = selectVideo({ track: 'investment_promo', intent, assets: [promo], random: first });
      expect(result.kind).toBe('none');
    }
  });
});
