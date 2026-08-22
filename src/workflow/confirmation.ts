/**
 * Recognising an explicit "yes" — deterministic, no model call.
 *
 * Used where a confirmation must be *explicit* before something destructive or
 * repetitive happens: an already-complete lead re-opening a screening flow is
 * asked whether they really want to start over, and only a clear yes restarts it
 * (see `decideMainMenu` / `confirm_restart`). Anything else — a question, a
 * change of subject, a plain "no" — is deliberately NOT a confirmation, so the
 * flow is never redone by accident.
 *
 * Kept narrow on purpose: it matches short agreement messages, not any message
 * that happens to contain the word "כן" inside a longer sentence.
 */

/** Short agreement words/phrases, matched against the whole (trimmed) message. */
const AFFIRMATIVES = new Set([
  'כן',
  'כן!',
  'כן בבקשה',
  'כן בטוח',
  'כן בהחלט',
  'בטוח',
  'בהחלט',
  'בוודאי',
  'ודאי',
  'אישור',
  'מאשר',
  'מאשרת',
  'אוקיי',
  'אוקי',
  'אישרתי',
  'ברור',
  'סבבה',
  'יאללה',
  'בוא נתחיל',
  'בואי נתחיל',
  'נתחיל',
  'להתחיל',
  'התחל',
  'מחדש',
  'התחל מחדש',
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'sure',
  'confirm',
]);

/**
 * Short refusals, matched the same way.
 *
 * These exist to be handled DETERMINISTICALLY. A bare "לא" answering "are you
 * sure you want to start over?" was once classified as an opt-out, which marked
 * the lead do-not-contact and silenced the bot for good — a decline of one offer
 * is not a request to never be contacted again. Recognising it here keeps that
 * answer away from the classifier entirely.
 */
const NEGATIVES = new Set([
  'לא',
  'לא תודה',
  'לא צריך',
  'לא רוצה',
  'לא עכשיו',
  'בטל',
  'ביטול',
  'עזוב',
  'nope',
  'no',
  'no thanks',
  'cancel',
]);

/** Characters to ignore when comparing — trailing punctuation and emoji. */
const TRIM_PATTERN = /[\s.!?,;:'"״׳\p{Extended_Pictographic}️]+/gu;

/** Normalizes a message for comparison against the word sets. */
function normalize(text: string): string {
  return text.trim().replace(TRIM_PATTERN, ' ').trim().toLowerCase();
}

/**
 * Whether a message is an explicit, unambiguous "yes".
 *
 * True only for a short agreement message on its own. A longer sentence that
 * merely contains an agreement word is not a confirmation — being wrong here
 * means redoing a flow the person did not ask to redo.
 */
export function isAffirmative(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length === 0) return false;
  return AFFIRMATIVES.has(normalized);
}

/**
 * Whether a message is a short, explicit "no".
 *
 * Used to answer a declined confirmation deterministically, so a bare "לא" never
 * reaches the classifier — where it has been read as an opt-out and permanently
 * silenced a lead who only meant "no, don't start over".
 */
export function isNegative(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length === 0) return false;
  return NEGATIVES.has(normalized);
}
