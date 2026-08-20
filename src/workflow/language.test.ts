import { describe, expect, it } from 'vitest';
import { ENGLISH_ONLY_REPLY, hasHebrew, isPredominantlyEnglish } from './language.js';

describe('hasHebrew', () => {
  it('is true for any text containing a Hebrew letter', () => {
    expect(hasHebrew('שלום')).toBe(true);
    expect(hasHebrew('רגר 15')).toBe(true);
    expect(hasHebrew('ok שלום')).toBe(true);
  });

  it('is false for text with no Hebrew — digits, symbols, emoji, gibberish', () => {
    expect(hasHebrew('12345')).toBe(false);
    expect(hasHebrew('!!!???')).toBe(false);
    expect(hasHebrew('😀😀')).toBe(false);
    expect(hasHebrew('asdfg')).toBe(false);
    expect(hasHebrew('')).toBe(false);
  });
});

describe('isPredominantlyEnglish', () => {
  it('flags real English prose', () => {
    expect(isPredominantlyEnglish('Hello, I want to sell my apartment')).toBe(true);
  });

  it('flags a single long English word', () => {
    expect(isPredominantlyEnglish('unsubscribe')).toBe(true);
  });

  it('does not flag a Hebrew message', () => {
    expect(isPredominantlyEnglish('שלום, אני רוצה למכור את הדירה')).toBe(false);
  });

  it('does not flag Hebrew that contains a short English term or address', () => {
    expect(isPredominantlyEnglish('הנכס ברחוב Rager 5')).toBe(false);
    expect(isPredominantlyEnglish('שכונה ט׳, דירת 4 חדרים')).toBe(false);
  });

  it('does not flag a short stray Latin token — that is an invalid answer, not English', () => {
    expect(isPredominantlyEnglish('Opus 4.8')).toBe(false);
    expect(isPredominantlyEnglish('ok')).toBe(false);
  });

  it('does not flag numbers, punctuation, or emoji alone', () => {
    expect(isPredominantlyEnglish('12345')).toBe(false);
    expect(isPredominantlyEnglish('👍👍')).toBe(false);
  });

  it('has a Hebrew reply', () => {
    expect(ENGLISH_ONLY_REPLY).toContain('עברית');
  });
});
