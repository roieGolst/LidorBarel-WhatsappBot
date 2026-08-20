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
 * The list is the full set of Be'er Sheva neighborhoods. It can still grow —
 * unknown values surfaced in the logs are the backlog for extending it — but a
 * customer is never restricted to it.
 */

/**
 * Canonical neighborhood names, in the spelling we store and display.
 *
 * The lettered שכונות use a geresh (׳) / gershayim (״); the normalizer accepts the
 * apostrophe, gershayim, and bare-letter variants people actually type.
 */
export const BEER_SHEVA_NEIGHBORHOODS = [
  // Lettered neighborhoods.
  'שכונה א׳',
  'שכונה ב׳',
  'שכונה ג׳',
  'שכונה ד׳',
  'שכונה ה׳',
  'שכונה ו׳',
  'שכונה ט׳',
  'שכונה י״א',
  // Named neighborhoods.
  'העיר העתיקה',
  'שכונת דרום',
  'נווה עופר',
  'המרכז האזרחי',
  'נאות לון',
  'נווה זאב',
  'נווה נוי',
  'נחל בקע',
  'נחל עשן',
  'רמות',
  'נאות אברהם',
  'נווה אילן',
  'רובע החדשנות',
  'קריית גנים',
  'כלניות',
  'סיגליות',
  'פארק הנחל',
  'נאות הדרים',
  'רקפות',
  'בית אשל',
  'מתחם אורות',
  'ברגמן',
] as const;

export type CanonicalNeighborhood = (typeof BEER_SHEVA_NEIGHBORHOODS)[number];

/**
 * Explicit spelling/alias variants that map onto a canonical name. Keys are
 * matched after {@link clean} (geresh/quotes stripped, whitespace collapsed), so
 * only variants `clean` does not already fold need to appear here.
 */
const ALIASES: Record<string, CanonicalNeighborhood> = {
  // Bare letters for the lettered neighborhoods (the geresh-less "שכונה X" forms
  // already fold onto the canonical names via `clean`).
  א: 'שכונה א׳',
  ב: 'שכונה ב׳',
  ג: 'שכונה ג׳',
  ד: 'שכונה ד׳',
  ה: 'שכונה ה׳',
  ו: 'שכונה ו׳',
  ט: 'שכונה ט׳',
  יא: 'שכונה י״א',
  // Alternate / former names (the parentheticals in the official list).
  'שיכון רסקו': 'נווה עופר',
  רסקו: 'נווה עופר',
  'נוה עופר': 'נווה עופר',
  'נווה מנחם': 'נחל עשן',
  'נוה מנחם': 'נחל עשן',
  'פלח 6': 'נאות אברהם',
  'פלח 7': 'נווה אילן',
  'נוה אילן': 'נווה אילן',
  'שכונת הפארק': 'פארק הנחל',
  דרום: 'שכונת דרום',
  'מרכז אזרחי': 'המרכז האזרחי',
  'קרית גנים': 'קריית גנים',
  // Common spelling variants (defective spelling, "שכונת X" phrasing).
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
