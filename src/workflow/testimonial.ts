/**
 * `selectVideo` — chooses which testimonial or promo video to send (Part B).
 *
 * Pure and deterministic given its `random` (injected for tests). It encodes the
 * spec's selection rules; the actual send (upload + cache) is the channel's job,
 * so a selected asset is identified only by its file path. Rules, in order:
 *
 *  - **Investment promo** goes only to a buyer/investor. Never to a seller; if
 *    intent is unclear it is withheld (determine intent first).
 *  - **Testimonials**: a neighborhood-specific video is preferred over a general
 *    one — a ט׳/ג׳/ד׳ lead gets the video whose metadata targets that
 *    neighborhood. With no neighborhood-specific match (or an unknown
 *    neighborhood — never guessed), a general testimonial is chosen at random.
 */

export type VideoTrack = 'testimonial' | 'investment_promo';

/** A catalog video, identified by its file path (the channel uploads by path). */
export interface CatalogVideo {
  id: string;
  path: string;
  /** `testimonial` | `promo_investment`. */
  type: string;
  /** Canonical neighborhood names this video targets. Empty = general. */
  neighborhoods: string[];
  audience: string | null;
}

export interface SelectInput {
  track: VideoTrack;
  intent: 'seller' | 'buyer' | 'investor' | 'unclear';
  /** Canonical neighborhood of the lead's property, if known. */
  neighborhoodCanonical?: string | null;
  assets: CatalogVideo[];
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

export type SelectResult =
  | { kind: 'send'; asset: CatalogVideo; matchedNeighborhood: boolean; reason: string }
  | { kind: 'none'; reason: string };

const TESTIMONIAL = 'testimonial';
const PROMO = 'promo_investment';

export function selectVideo(input: SelectInput): SelectResult {
  const random = input.random ?? Math.random;
  const pick = (items: CatalogVideo[]): CatalogVideo =>
    items[Math.floor(random() * items.length)]!;

  if (input.track === 'investment_promo') {
    if (input.intent !== 'buyer' && input.intent !== 'investor') {
      return { kind: 'none', reason: 'Not a buyer/investor — promo withheld' };
    }
    const promos = input.assets.filter((a) => a.type === PROMO);
    if (promos.length === 0) return { kind: 'none', reason: 'No investment promo available' };
    return {
      kind: 'send',
      asset: pick(promos),
      matchedNeighborhood: false,
      reason: 'Investment promo for buyer/investor',
    };
  }

  const testimonials = input.assets.filter((a) => a.type === TESTIMONIAL);
  if (testimonials.length === 0) {
    return { kind: 'none', reason: 'No testimonial video available' };
  }

  // Neighborhood-specific takes priority — but only when the neighborhood is
  // known; an unknown neighborhood is never guessed.
  if (input.neighborhoodCanonical) {
    const canonical = input.neighborhoodCanonical;
    const matches = testimonials.filter((a) => a.neighborhoods.includes(canonical));
    if (matches.length > 0) {
      return {
        kind: 'send',
        asset: pick(matches),
        matchedNeighborhood: true,
        reason: `Neighborhood match for ${canonical}`,
      };
    }
  }

  const generals = testimonials.filter((a) => a.neighborhoods.length === 0);
  if (generals.length === 0) {
    return { kind: 'none', reason: 'No general testimonial available' };
  }
  return {
    kind: 'send',
    asset: pick(generals),
    matchedNeighborhood: false,
    reason: 'General testimonial (random)',
  };
}
