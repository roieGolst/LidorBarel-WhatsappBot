/**
 * Be'er Sheva neighborhoods — the reference list, plus normalization.
 *
 * Two rules govern how this is used (see the plan, Part B):
 *
 *  1. **The customer is never restricted to this list.** A neighborhood we do not
 *     recognise is still a valid answer: it is accepted, saved *verbatim* as the
 *     lead's property info, and logged so it can be reviewed and added here later.
 *     We never replace what the customer said with the "closest" known option.
 *  2. **Aliases and spelling variants normalize to a canonical name** for matching
 *     (testimonial video selection, deduplication) while the original text is
 *     always preserved alongside.
 *
 * The list starts from the spec's Q2 options (the authoritative set for this
 * business) extended with widely-known Be'er Sheva neighborhoods. It is meant to
 * grow: unknown values surfaced in the logs are the backlog for extending it.
 */

/**
 * Canonical neighborhood names, in the spelling we store and display.
 *
 * The lettered שכונות use a geresh (׳); the normalizer accepts the apostrophe and
 * bare-letter variants people actually type.
 */
export const BEER_SHEVA_NEIGHBORHOODS = [
  // Lettered neighborhoods — the spec's Q2 set.
  'שכונה א׳',
  'שכונה ב׳',
  'שכונה ג׳',
  'שכונה ד׳',
  'שכונה ה׳',
  'שכונה ו׳',
  'שכונה ט׳',
  // Named neighborhoods (widely known; extend from logged unknowns).
  'נווה זאב',
  'נחל עשן',
  'נחל בקע',
  'רמות',
  'נאות לון',
  'נווה נוי',
  'נאות אברהם',
  'העיר העתיקה',
] as const;

export type CanonicalNeighborhood = (typeof BEER_SHEVA_NEIGHBORHOODS)[number];

/**
 * Explicit spelling/alias variants that map onto a canonical name. Keys are
 * matched after {@link clean} (geresh/quotes stripped, whitespace collapsed), so
 * only variants `clean` does not already fold need to appear here.
 */
const ALIASES: Record<string, CanonicalNeighborhood> = {
  // "שכונת X" phrasing and bare letters for the lettered neighborhoods.
  'שכונה א': 'שכונה א׳',
  'שכונה ב': 'שכונה ב׳',
  'שכונה ג': 'שכונה ג׳',
  'שכונה ד': 'שכונה ד׳',
  'שכונה ה': 'שכונה ה׳',
  'שכונה ו': 'שכונה ו׳',
  'שכונה ט': 'שכונה ט׳',
  א: 'שכונה א׳',
  ב: 'שכונה ב׳',
  ג: 'שכונה ג׳',
  ד: 'שכונה ד׳',
  ה: 'שכונה ה׳',
  ו: 'שכונה ו׳',
  ט: 'שכונה ט׳',
  // Named-neighborhood variants.
  'שכונת נווה זאב': 'נווה זאב',
  'נוה זאב': 'נווה זאב',
  'שכונת נחל עשן': 'נחל עשן',
  'שכונת נחל בקע': 'נחל בקע',
  'שכונת רמות': 'רמות',
  'שכונת נאות לון': 'נאות לון',
  'שכונת נווה נוי': 'נווה נוי',
  'נוה נוי': 'נווה נוי',
  'שכונת נאות אברהם': 'נאות אברהם',
  'עיר עתיקה': 'העיר העתיקה',
};

/** Cleaned canonical form → canonical, built once. */
const CANONICAL_BY_CLEAN = new Map<string, CanonicalNeighborhood>(
  BEER_SHEVA_NEIGHBORHOODS.map((name) => [clean(name), name]),
);

/**
 * Folds the spelling noise that should never affect a match: the geresh/apostrophe
 * marks on lettered neighborhoods, surrounding quotes, and repeated whitespace. A
 * leading "שכונת" is normalized to "שכונה" so both phrasings collide.
 */
function clean(raw: string): string {
  return raw
    .trim()
    .replace(/[׳״'’`"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^שכונת\b/, 'שכונה');
}

export interface NeighborhoodMatch {
  /** Canonical name when recognised, else null — never a guessed nearest match. */
  canonical: CanonicalNeighborhood | null;
  /** Exactly what the customer said, trimmed. Always preserved. */
  original: string;
  /** True when the value maps onto a known neighborhood. */
  known: boolean;
}

/**
 * Normalizes a free-text neighborhood answer.
 *
 * Recognises canonical names and the alias/spelling variants; on no match returns
 * `{ canonical: null, known: false }` with the original preserved — the caller
 * saves the original verbatim and logs the unknown. This never substitutes a
 * "closest" neighborhood for an unrecognised one.
 */
export function normalizeNeighborhood(raw: string): NeighborhoodMatch {
  const original = raw.trim();
  const key = clean(original);

  const canonical = CANONICAL_BY_CLEAN.get(key) ?? ALIASES[key] ?? null;
  return { canonical, original, known: canonical !== null };
}
