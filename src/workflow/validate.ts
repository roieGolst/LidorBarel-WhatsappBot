/**
 * `validateReply` — the spec's voice rules, enforced before anything is sent (§5.5).
 *
 * The LLM writes the reply; this decides whether it may leave the building. It is
 * pure and deterministic: the same text always yields the same verdict, so a
 * banned word can never slip through on a lucky sample. The workflow regenerates
 * once when a draft fails and falls back to a pre-written safe variant if the
 * second attempt fails too.
 *
 * The banned list and {@link findBannedTerms} are exported so the same check can
 * be re-asserted at the transport boundary and at template-authoring time —
 * defense in depth, since a banned word reaching a real customer is a brand and
 * trust failure, not a cosmetic one.
 */

/**
 * Words the bot must never use — the spec's full forbidden list (§10). Salesy
 * pressure (`מבצע`, `זול`, `דחוף`, `מציאה`), over-promising (`מבטיח`, `תתחייב`,
 * `נסגור`) and false certainty (`בטוח`, `בוודאות`, `חייב`) all read as a pushy
 * agent rather than the senior, trustworthy voice the spec wants. Preferred
 * phrasings instead: אבדוק · אעריך · על סמך הנתונים · לפי מצב השוק · המטרה היא ·
 * אסטרטגיית מכירה · חשיפה רחבה · הערכת שווי.
 */
export const BANNED_WORDS = [
  'מבצע', // "deal/sale"
  'זול', // "cheap"
  'מציאה', // "a steal / bargain"
  'דחוף', // "urgent"
  'בטוח', // "certain/guaranteed"
  'בוודאות', // "with certainty" (spec spelling)
  'בודאות', // "with certainty" (defective spelling)
  'חייב', // "must"
  'מבטיח', // "promise"
  'תתחייב', // "commit yourself"
  'נסגור', // "we'll close (the deal)"
] as const;

/**
 * Banned multi-word expressions, matched anywhere in the text. Includes the
 * on-property price framings the spec forbids (`יקר מדי`, `מקסימום מחיר` — prefer
 * "המחיר הגבוה ביותר שהשוק מאפשר").
 */
export const BANNED_PHRASES = [
  'מאה אחוז', // "a hundred percent"
  'אין סיכוי', // "no chance"
  'רק היום', // "today only"
  'יקר מדי', // "too expensive" (about the property)
  'אי אפשר', // "impossible"
  'אין מה לעשות', // "nothing to be done"
  'מקסימום מחיר', // "maximum price" — over-promising the outcome
] as const;

/**
 * Single-letter Hebrew prefixes that attach to a word (the/and/in/to/…). A
 * banned word wearing one of these — `המבצע`, `ובטוח` — is still banned.
 */
const HEBREW_PREFIXES = ['ב', 'ה', 'ו', 'ל', 'מ', 'ש', 'כ'];

/** Longest reply we will send. Beyond this it is a wall of text, not a message. */
export const MAX_REPLY_LENGTH = 600;

export type Violation = 'empty' | 'too_long' | 'multiple_questions' | 'banned_word';

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  /** The specific banned terms found, so a regeneration prompt can name them. */
  bannedTerms: string[];
}

/** Splits text into word tokens, dropping punctuation and whitespace. */
function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Returns the banned word a token represents (bare or prefixed), if any. */
function bannedWordFor(token: string): string | undefined {
  for (const word of BANNED_WORDS) {
    if (token === word) return word;
    for (const prefix of HEBREW_PREFIXES) {
      if (token === prefix + word) return word;
    }
  }
  return undefined;
}

/**
 * Every banned term in the text, bare or prefixed. Exported for the channel
 * adapter's transport-boundary re-check.
 */
export function findBannedTerms(text: string): string[] {
  const found = new Set<string>();

  for (const token of tokenize(text)) {
    const hit = bannedWordFor(token);
    if (hit) found.add(hit);
  }
  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) found.add(phrase);
  }

  return [...found];
}

/** Checks a candidate reply against the spec's send-time rules. */
export function validateReply(text: string): ValidationResult {
  const trimmed = text.trim();
  const violations = new Set<Violation>();

  if (trimmed.length === 0) violations.add('empty');
  if (trimmed.length > MAX_REPLY_LENGTH) violations.add('too_long');

  // "One question at a time, don't flood them." Zero questions (an
  // acknowledgement) is fine; two or more is a violation.
  const questionMarks = trimmed.match(/\?/g)?.length ?? 0;
  if (questionMarks > 1) violations.add('multiple_questions');

  const bannedTerms = findBannedTerms(trimmed);
  if (bannedTerms.length > 0) violations.add('banned_word');

  return { ok: violations.size === 0, violations: [...violations], bannedTerms };
}
