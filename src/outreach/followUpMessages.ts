/**
 * The follow-up wording.
 *
 * Written rather than generated. A follow-up goes out with nobody watching, to
 * someone who has not answered, and an LLM turn here would add cost, latency and
 * a validator failure mode to a background job for no gain — the message says
 * one thing and says it the same way every time. `followUpMessages.test.ts` runs
 * each of these through the same voice validator the model's replies face, so
 * they cannot drift off-spec.
 *
 * The ladder softens as it goes: a light nudge, then an offer of the easier
 * path, then a final message that closes the loop and stops. Nothing pressures,
 * nothing promises, and every message makes stopping easy — a person who has
 * ignored three messages is telling us something, and the wording should respect
 * that before the cap does.
 */

/**
 * Follow-ups in order. The last is reused if the cap ever exceeds the ladder,
 * so adding a follow-up cannot silently produce an empty message.
 */
export const FOLLOW_UP_MESSAGES: readonly string[] = [
  'היי 🙂 רק מוודא שההודעה הגיעה. אם תרצה, נוכל להתחיל בכמה שאלות קצרות ולהעריך את שווי הנכס — ואם עכשיו לא הזמן, זה בסדר גמור.',

  'עדיין כאן אם תרצה להתקדם עם הנכס 🏠 אפשר פשוט לענות כאן, ואם נוח לך יותר לדבר — נשמח לתאם שיחה קצרה עם לידור.',

  'לא רוצה להעיק 🙂 אם תרצה שנבדוק יחד את שווי הנכס, אני כאן. אם לא רלוונטי כרגע — אפשר לכתוב *עצור* ולא אפריע יותר.',

  'זו ההודעה האחרונה שלי בנושא. אם תרצה לחזור לזה בעתיד — פשוט תכתוב לי כאן ונמשיך מאיפה שעצרנו. בהצלחה! 🙏',
] as const;

/**
 * The message for a given follow-up number (1-based).
 *
 * Clamped to the ladder rather than indexed blindly: raising the cap in config
 * should change how many nudges are sent, not start sending `undefined`.
 */
export function followUpMessage(followUpNumber: number): string {
  const index = Math.min(Math.max(followUpNumber, 1), FOLLOW_UP_MESSAGES.length) - 1;
  // The clamp guarantees a hit; the assertion documents that for the reader.
  return FOLLOW_UP_MESSAGES[index]!;
}
