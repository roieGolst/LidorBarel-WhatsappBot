import type { Analysis } from './classify.js';

/**
 * `selectVideo` — chooses which testimonial or promo video to send (Part B).
 *
 * Pure and deterministic given its `random` (injected for tests). It encodes the
 * spec's selection rules and nothing else — the actual send, the media-id lookup,
 * and the logging live in `conversationTurn`. Rules, in order:
 *
 *  - **Investment promo** goes only to a buyer/investor, at most once. Never to a
 *    seller-only lead; if intent is unclear it is withheld (determine intent
 *    first).
 *  - **Testimonials**: a neighborhood-specific video is preferred over a general
 *    one — a ט׳/ג׳/ד׳ lead gets the video whose metadata targets that
 *    neighborhood. With no neighborhood-specific match (or an unknown
 *    neighborhood — never guessed), a general testimonial is chosen at random.
 *  - **Never repeat** a video already sent in the conversation.
 */

export type VideoTrack = 'testimonial' | 'investment_promo';

/** A sendable asset — one that has a cached Meta media id. */
export interface SendableVideo {
  id: string;
  path: string;
  mediaId: string;
  /** `testimonial` | `promo_investment`. */
  type: string;
  /** Canonical neighborhood names this video targets. Empty = general. */
  neighborhoods: string[];
  /** `seller` | `buyer` | `investor` | null. */
  audience: string | null;
}

export interface SelectInput {
  track: VideoTrack;
  intent: Analysis['contactIntent'];
  /** Canonical neighborhood of the lead's property, if known. */
  neighborhoodCanonical?: string | null;
  /** Asset ids already sent in this conversation. */
  alreadySent: string[];
  /** Whether the investment promo has already been sent. */
  promoSent: boolean;
  assets: SendableVideo[];
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

export type SelectResult =
  | {
      kind: 'send';
      asset: SendableVideo;
      /** True when chosen because its neighborhood metadata matched the lead. */
      matchedNeighborhood: boolean;
      reason: string;
    }
  | { kind: 'none'; reason: string };

const TESTIMONIAL = 'testimonial';
const PROMO = 'promo_investment';

export function selectVideo(input: SelectInput): SelectResult {
  const random = input.random ?? Math.random;
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  const available = input.assets.filter((a) => !input.alreadySent.includes(a.id));

  if (input.track === 'investment_promo') {
    if (input.intent !== 'buyer' && input.intent !== 'investor') {
      return { kind: 'none', reason: 'Not a buyer/investor — promo withheld' };
    }
    if (input.promoSent) {
      return { kind: 'none', reason: 'Investment promo already sent' };
    }
    const promos = available.filter((a) => a.type === PROMO);
    if (promos.length === 0) {
      return { kind: 'none', reason: 'No investment promo available' };
    }
    return {
      kind: 'send',
      asset: pick(promos),
      matchedNeighborhood: false,
      reason: 'Investment promo for buyer/investor',
    };
  }

  // Testimonials.
  const testimonials = available.filter((a) => a.type === TESTIMONIAL);
  if (testimonials.length === 0) {
    return { kind: 'none', reason: 'No testimonial video available' };
  }

  // Neighborhood-specific takes priority — but only when we actually know the
  // neighborhood; an unknown neighborhood is never guessed.
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

  // No neighborhood match (or unknown neighborhood): a general testimonial at
  // random. General = not tied to any specific neighborhood.
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
