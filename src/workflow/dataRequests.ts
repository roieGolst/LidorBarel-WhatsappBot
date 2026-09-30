/**
 * Two requests answered without a model, so neither can be missed or met with
 * small talk: deleting one's data (NN-8), and asking to speak with Lidor or a
 * person (NN-10).
 *
 * Deletion is high precision on purpose: the request erases the person at
 * once, so it must name their *own* data ("המידע שלי", "my data"). A seller correcting what
 * they sent ("תמחק את המידע ששלחתי") or talking about a listing ("למחוק את
 * הפרטים של הנכס") is not asking for this, and is left to the normal turn.
 */

/** Delete / erase, as people write it: מחקו, תמחק, תמחקי, למחוק, מחיקת… */
const DELETE_VERB = String.raw`(?:(?:^|\s)[וש]?(?:ת?מחק(?:ו|י)?|למחוק|מחיקת))`;
/** The data, optionally "all" and "personal", and always "mine". */
const MY_DATA = String.raw`\s+(?:את\s+)?(?:כל\s+)?(?:ה?מידע|ה?פרטים|ה?נתונים)(?:\s+ה?אישי(?:ים)?)?\s+שלי(?=$|[\s.,!?])`;

const DELETION_PATTERNS: RegExp[] = [
  new RegExp(DELETE_VERB + MY_DATA, 'u'),
  /(?:^|\s)(?:ת?מחק(?:ו|י)?|למחוק)\s+אותי(?=$|[\s.,!?])/u,
  /\b(?:delete|erase|remove) my (?:personal )?(?:data|information|details)\b/i,
  /\bright to be forgotten\b/i,
];

/** "Delete my data" — in the ways people actually write it. */
export function isDeletionRequest(text: string): boolean {
  return DELETION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * "I want to speak with Lidor" — or with a person, a representative. Explicit
 * wording only: "לדבר עם מישהו" (someone in the family, say) is not one, and a
 * negation ("לא צריך לדבר עם לידור") is not one.
 */
const SPEAK_PATTERNS: RegExp[] = [
  /(?:לדבר|לשוחח|לדבר\s+ישירות)\s+(?:עם|אל)\s+לידור/u,
  /(?:לדבר|לשוחח)\s+עם\s+(?:בן\s?אדם|נציג(?:ה)?|אדם\s+אמיתי|מישהו\s+אמיתי)/u,
  /(?:תעביר(?:ו|י)?|תחבר(?:ו|י)?)\s+(?:אותי\s+)?ל(?:לידור|נציג|בן\s?אדם)/u,
  /\b(?:talk|speak)\s+(?:to|with)\s+(?:lidor|a\s+(?:human|person|real\s+person|representative))\b/i,
];
const NEGATED =
  /(?:לא|אין\s+צורך)\s+(?:צריך\s+|רוצה\s+|מעוניי?נ(?:ת)?\s+)?ל(?:דבר|שוחח)/u;

/** An explicit request to speak with Lidor or a person. */
export function isSpeakWithLidorRequest(text: string): boolean {
  if (NEGATED.test(text)) return false;
  return SPEAK_PATTERNS.some((pattern) => pattern.test(text));
}
