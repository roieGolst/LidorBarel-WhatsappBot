import { describe, expect, it } from 'vitest';
import {
  BANNED_WORDS,
  findBannedTerms,
  MAX_REPLY_LENGTH,
  validateReply,
} from './validate.js';

describe('validateReply', () => {
  it('accepts a clean single-question reply', () => {
    const result = validateReply('שלום! באיזו שכונה נמצא הנכס?');
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('accepts an acknowledgement with no question', () => {
    expect(validateReply('תודה, קיבלתי את הפרטים.').ok).toBe(true);
  });

  it('flags an empty reply', () => {
    expect(validateReply('   ').violations).toContain('empty');
  });

  it('flags more than one question', () => {
    const result = validateReply('באיזו שכונה? וכמה חדרים?');
    expect(result.violations).toContain('multiple_questions');
  });

  it('flags a reply over the length limit', () => {
    const result = validateReply('א'.repeat(MAX_REPLY_LENGTH + 1));
    expect(result.violations).toContain('too_long');
  });

  it('flags each banned word and names it', () => {
    for (const word of BANNED_WORDS) {
      const result = validateReply(`יש לנו ${word} בשבילך`);
      expect(result.violations).toContain('banned_word');
      expect(result.bannedTerms).toContain(word);
    }
  });

  it('flags a banned word carrying a Hebrew prefix', () => {
    // "המבצע" — the definite article on "מבצע".
    const result = validateReply('אל תפספס את המבצע');
    expect(result.violations).toContain('banned_word');
    expect(result.bannedTerms).toContain('מבצע');
  });

  it('flags a banned phrase', () => {
    expect(findBannedTerms('אני מאה אחוז בטוח')).toEqual(
      expect.arrayContaining(['מאה אחוז', 'בטוח']),
    );
  });

  it('does not flag an innocent word that merely contains banned letters', () => {
    // "שבטים" (tribes) contains the letters of "בטים" but is not "בטוח".
    expect(validateReply('דיברנו על שבטים').ok).toBe(true);
  });

  it('flags a missing question only when one is required', () => {
    const noQuestion = 'תודה, קיבלתי את הפרטים.';
    expect(validateReply(noQuestion).ok).toBe(true);
    expect(validateReply(noQuestion, { requireQuestion: true }).violations).toContain(
      'missing_question',
    );
    // A single question satisfies the requirement.
    expect(validateReply('נמשיך לבדיקה קצרה?', { requireQuestion: true }).ok).toBe(true);
  });

  it('reports every distinct violation at once', () => {
    const result = validateReply(`${'א'.repeat(MAX_REPLY_LENGTH + 1)} מבצע? זול?`);
    expect(new Set(result.violations)).toEqual(
      new Set(['too_long', 'multiple_questions', 'banned_word']),
    );
  });
});
