import { describe, expect, it } from 'vitest';
import { controlCommandFor } from './gate.js';
import { isOptOutKeyword } from './optOutKeywords.js';

describe('isOptOutKeyword — the words the privacy page tells people to send', () => {
  it('honours the phrases printed on /privacy', () => {
    // If a phrase is ever removed from the patterns, the page must change too.
    for (const text of ['תפסיקו', 'הסירו אותי', 'unsubscribe']) {
      expect(isOptOutKeyword(text), text).toBe(true);
      // None of them is swallowed by the gate's control words first.
      expect(controlCommandFor(text), text).toBeUndefined();
    }
  });

  it('does not read a screening answer as an opt-out', () => {
    for (const text of ['לא', 'רמות', 'כן, רוצה למכור']) {
      expect(isOptOutKeyword(text), text).toBe(false);
    }
  });
});
