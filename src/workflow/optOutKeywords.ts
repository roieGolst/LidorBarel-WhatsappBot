/**
 * Deterministic opt-out keyword match — a safety net that runs without the LLM.
 *
 * The classifier is the primary opt-out detector, but there are turns where the
 * classifier never runs: the English gate and containment mode both short-circuit
 * before any model call. An opt-out is a legal obligation (Israeli Amendment 40)
 * that must never be missed, so those paths still scan for an explicit request to
 * stop. This is intentionally high-precision (clear stop phrasings only) so it
 * does not swallow ordinary messages; anything subtler is left to the classifier.
 */

/** Clear, unambiguous stop requests, Hebrew and English. */
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /תפסיק(?:ו|י)?/,
  /להפסיק/,
  /להסיר/,
  /הסירו/,
  /תסירו/,
  /תורידו אותי/,
  /מוריד אתכם/,
  /אל תפנו אליי?/,
  /לא מעוניין שתפנו/,
];

/** Whether the message is an explicit request to stop being contacted. */
export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
}
