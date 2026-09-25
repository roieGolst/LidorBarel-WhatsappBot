import { describe, expect, it } from 'vitest';
import { isDeletionRequest, isHumanRequest } from './dataRequests.js';

describe('isDeletionRequest', () => {
  it('recognises the phrase the privacy page tells people to send, and its variants', () => {
    for (const text of [
      'מחקו את המידע שלי',
      'תמחק את הפרטים שלי בבקשה',
      'אני רוצה למחוק את הנתונים שלי',
      'מחקו את כל המידע האישי שלי',
      'בקשת מחיקה',
      'למחוק אותי מהמערכת',
      'Delete my data',
      'please erase my information',
    ]) {
      expect(isDeletionRequest(text), text).toBe(true);
    }
  });

  it('is not triggered by ordinary talk about deleting or details', () => {
    for (const text of [
      'מחק את ההודעה הקודמת',
      'הפרטים שלי: 4 חדרים, קומה 2',
      'אפשר לשנות את הפרטים?',
      'תפסיקו לשלוח לי הודעות',
      'delete',
    ]) {
      expect(isDeletionRequest(text), text).toBe(false);
    }
  });
});

describe('isHumanRequest', () => {
  it('recognises asking for a person', () => {
    for (const text of [
      'אפשר לדבר עם לידור?',
      'אני רוצה לדבר עם נציג',
      'לדבר עם בן אדם',
      'תעביר אותי ללידור',
      'יש נציג אנושי?',
      'I want to talk to a human',
    ]) {
      expect(isHumanRequest(text), text).toBe(true);
    }
  });

  it('is not triggered by mentioning Lidor or a meeting', () => {
    for (const text of ['מתי לידור יתקשר?', 'קביעת פגישה', 'לידור נשמע מקצועי', 'כן']) {
      expect(isHumanRequest(text), text).toBe(false);
    }
  });
});
