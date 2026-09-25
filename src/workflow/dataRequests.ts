/**
 * The two requests the privacy policy promises to honour on the spot, detected
 * deterministically — like the opt-out words — so they can never be missed by a
 * model or answered with small talk.
 *
 * Both run in the gate, before any classification: a person asking for their
 * data to be deleted, or to speak to a human, has stopped talking to the bot.
 */

const DELETION_PATTERNS: RegExp[] = [
  // "מחקו את המידע שלי", "תמחק את הפרטים שלי", "אני רוצה למחוק את הנתונים שלי"
  /(?:^|\s)(?:ת?מחק(?:ו|י)?|למחוק|תמחקו|מחיקת)\s+(?:את\s+)?(?:כל\s+)?(?:ה?מידע|ה?פרטים|ה?נתונים)(?:\s+ה?אישי(?:ים)?)?(?:\s+שלי)?/u,
  /בקשת מחיקה/u,
  /למחוק אותי/u,
  /\bdelete my (?:data|information|details|account)\b/i,
  /\b(?:erase|remove) my (?:data|information|details)\b/i,
  /\bright to be forgotten\b/i,
];

const HUMAN_PATTERNS: RegExp[] = [
  // "אפשר לדבר עם לידור?", "רוצה לדבר עם נציג", "לדבר עם בן אדם"
  /לדבר\s+עם\s+(?:לידור|נציג(?:ה)?|בן\s?אדם|אדם|מישהו|אנוש)/u,
  /נציג\s+אנושי/u,
  /בן\s?אדם\s+אמיתי/u,
  /(?:תעביר(?:ו)?|העבר(?:ו)?|תחבר(?:ו)?)\s+(?:אותי\s+)?ל?לידור/u,
  /\btalk to a (?:human|person|real person|representative)\b/i,
  /\bhuman agent\b/i,
];

/** "Delete my data" — in any of the ways people actually write it. */
export function isDeletionRequest(text: string): boolean {
  return DELETION_PATTERNS.some((pattern) => pattern.test(text));
}

/** "Let me talk to a person" — the promise on the privacy page, kept in code. */
export function isHumanRequest(text: string): boolean {
  return HUMAN_PATTERNS.some((pattern) => pattern.test(text));
}
