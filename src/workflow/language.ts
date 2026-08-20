/**
 * Language gate — the bot serves Hebrew conversations only.
 *
 * A message written *primarily in English* is unsupported input: it must not be
 * processed as an answer, saved, advanced through the flow, or allowed to affect
 * qualification. The turn short-circuits to a fixed Hebrew reply asking for Hebrew
 * (see the plan, Part A req #4). This is deterministic — no model call — because
 * script is a mechanical property of the text, not something to reason about.
 *
 * The gate is deliberately conservative about *rejecting*: a valid Hebrew message
 * that happens to carry a short English term, a property/brand name, an address,
 * an abbreviation, or a number is Hebrew, not English. So any Hebrew content at
 * all makes the message pass, and a Latin-only message trips the gate only when it
 * is real English prose — several words, or one long word — not a stray token like
 * a model name (that is an invalid *answer*, handled downstream, not a language
 * problem).
 */

/** The reply sent when a message is predominantly English. Verbatim per spec. */
export const ENGLISH_ONLY_REPLY =
  'אני מיועד לשיחות בעברית בלבד. כדי שאוכל לעזור, יש לשלוח את ההודעה בעברית.';

/** Number of Latin letters in a single run that, alone, reads as English. */
const LONG_LATIN_RUN = 8;

/**
 * Whether the text contains any Hebrew letter.
 *
 * This bot converses in Hebrew, so a message with **no Hebrew at all** — random
 * symbols, digits, emoji, or gibberish — carries no information: it must not be
 * processed as an answer or acknowledged as property details. (English prose is
 * caught earlier by {@link isPredominantlyEnglish}; this catches everything else
 * with no Hebrew content.)
 */
export function hasHebrew(text: string): boolean {
  return /\p{Script=Hebrew}/u.test(text);
}

/**
 * Whether a message is predominantly English and should be refused.
 *
 * True only when the text contains **no Hebrew letters** and carries substantive
 * Latin content — two or more Latin words, or a single long Latin word. Anything
 * with Hebrew letters, or with only a short stray Latin token/number/emoji, is not
 * English.
 */
export function isPredominantlyEnglish(text: string): boolean {
  // Any Hebrew letter means this is a Hebrew message (possibly with an English
  // term inside it) — never refuse it for language.
  if (/\p{Script=Hebrew}/u.test(text)) return false;

  const latinWords = text.match(/[A-Za-z]+/g) ?? [];
  if (latinWords.length === 0) return false; // digits, punctuation, or emoji only

  const words = latinWords.length;
  const longestWord = latinWords.reduce((max, w) => Math.max(max, w.length), 0);

  // Real English prose: several words, or one long word (e.g. "unsubscribe").
  return words >= 2 || longestWord >= LONG_LATIN_RUN;
}
