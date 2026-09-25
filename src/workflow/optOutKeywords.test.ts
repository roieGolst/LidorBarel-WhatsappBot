import { describe, expect, it } from 'vitest';
import { isOptOutKeyword } from './optOutKeywords.js';

describe('isOptOutKeyword — the words the privacy page promises', () => {
  it('honours exactly the three phrases printed on /privacy', () => {
    // If a phrase is ever removed from the patterns, the page must change too.
    for (const text of ['תפסיקו', 'הסירו אותי', 'STOP']) {
      expect(isOptOutKeyword(text), text).toBe(true);
    }
  });

  it('does not read a screening answer as an opt-out', () => {
    for (const text of ['לא', 'רמות', 'כן, רוצה למכור']) {
      expect(isOptOutKeyword(text), text).toBe(false);
    }
  });
});
