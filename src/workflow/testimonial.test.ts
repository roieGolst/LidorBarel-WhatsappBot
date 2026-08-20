import { describe, expect, it } from 'vitest';
import { selectVideo, type SendableVideo } from './testimonial.js';

const tetVideo: SendableVideo = {
  id: 'tet',
  path: 'recommendations/tet.mp4',
  mediaId: 'm-tet',
  type: 'testimonial',
  neighborhoods: ['שכונה ט׳'],
  audience: 'seller',
};
const generalA: SendableVideo = {
  id: 'gen-a',
  path: 'recommendations/gen-a.mp4',
  mediaId: 'm-gen-a',
  type: 'testimonial',
  neighborhoods: [],
  audience: 'seller',
};
const generalB: SendableVideo = {
  ...generalA,
  id: 'gen-b',
  path: 'recommendations/gen-b.mp4',
};
const promo: SendableVideo = {
  id: 'promo',
  path: 'recommendations/promo.mp4',
  mediaId: 'm-promo',
  type: 'promo_investment',
  neighborhoods: [],
  audience: 'investor',
};

const first = () => 0; // deterministic pick

describe('selectVideo — testimonials', () => {
  it('prefers a neighborhood-specific video when the neighborhood matches', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: 'שכונה ט׳',
      alreadySent: [],
      promoSent: false,
      assets: [generalA, tetVideo],
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
      neighborhoodCanonical: 'שכונה ג׳', // no ג׳ video present
      alreadySent: [],
      promoSent: false,
      assets: [tetVideo, generalA],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') {
      expect(result.asset.id).toBe('gen-a');
      expect(result.matchedNeighborhood).toBe(false);
    }
  });

  it('uses a general testimonial (never guesses) when the neighborhood is unknown', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: null,
      alreadySent: [],
      promoSent: false,
      assets: [tetVideo, generalA],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.asset.neighborhoods).toEqual([]);
  });

  it('never repeats a video already sent', () => {
    const result = selectVideo({
      track: 'testimonial',
      intent: 'seller',
      neighborhoodCanonical: null,
      alreadySent: ['gen-a'],
      promoSent: false,
      assets: [generalA, generalB],
      random: first,
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.asset.id).toBe('gen-b');
  });
});

describe('selectVideo — investment promo', () => {
  it('sends the promo to an investor', () => {
    const result = selectVideo({
      track: 'investment_promo',
      intent: 'investor',
      alreadySent: [],
      promoSent: false,
      assets: [promo],
      random: first,
    });
    expect(result.kind).toBe('send');
  });

  it('withholds the promo from a seller', () => {
    const result = selectVideo({
      track: 'investment_promo',
      intent: 'seller',
      alreadySent: [],
      promoSent: false,
      assets: [promo],
      random: first,
    });
    expect(result.kind).toBe('none');
  });

  it('withholds the promo when intent is unclear (determine intent first)', () => {
    const result = selectVideo({
      track: 'investment_promo',
      intent: 'unclear',
      alreadySent: [],
      promoSent: false,
      assets: [promo],
      random: first,
    });
    expect(result.kind).toBe('none');
  });

  it('does not resend the promo', () => {
    const result = selectVideo({
      track: 'investment_promo',
      intent: 'investor',
      alreadySent: [],
      promoSent: true,
      assets: [promo],
      random: first,
    });
    expect(result.kind).toBe('none');
  });
});
