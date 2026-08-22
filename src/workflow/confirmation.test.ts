import { describe, expect, it } from 'vitest';
import { isAffirmative, isNegative } from './confirmation.js';

describe('isAffirmative', () => {
  it('accepts short, explicit agreement', () => {
    for (const text of [
      'כן',
      'כן!',
      ' כן ',
      'כן בבקשה',
      'בטוח',
      'בהחלט',
      'אישור',
      'אוקיי',
      'yes',
      'OK',
    ]) {
      expect(isAffirmative(text)).toBe(true);
    }
  });

  it('rejects a decline, a question, or a change of subject', () => {
    // Being wrong here means redoing a flow the person did not ask to redo.
    for (const text of [
      'לא',
      'לא תודה',
      'למה?',
      'כמה אחוזים לידור לוקח?',
      'רגע, אני רוצה לשאול משהו',
      'no',
      '',
    ]) {
      expect(isAffirmative(text)).toBe(false);
    }
  });

  it('does not treat a long sentence containing "כן" as a confirmation', () => {
    expect(isAffirmative('כן אבל קודם תסביר לי מה קורה עם הפרטים הקודמים')).toBe(false);
    expect(isAffirmative('אני לא בטוח שכן')).toBe(false);
  });
});

describe('isNegative', () => {
  it('recognises a short, explicit refusal', () => {
    // These are answered deterministically so a bare "לא" is never mistaken for
    // an opt-out (which would silence the lead permanently).
    for (const text of ['לא', 'לא!', ' לא תודה ', 'לא עכשיו', 'ביטול', 'no']) {
      expect(isNegative(text)).toBe(true);
    }
  });

  it('does not swallow a real opt-out or a question', () => {
    // A genuine opt-out must fall through to the normal path and be honoured.
    expect(isNegative('תפסיקו לשלוח לי הודעות')).toBe(false);
    expect(isNegative('אל תפנו אליי יותר')).toBe(false);
    expect(isNegative('למה צריך להתחיל מחדש?')).toBe(false);
  });

  it('is not confusable with a confirmation', () => {
    expect(isNegative('כן')).toBe(false);
    expect(isAffirmative('לא')).toBe(false);
  });
});
