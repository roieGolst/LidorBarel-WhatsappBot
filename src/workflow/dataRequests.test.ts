import { describe, expect, it } from 'vitest';
import { isDeletionRequest, isSpeakWithLidorRequest } from './dataRequests.js';

describe('isDeletionRequest', () => {
  it('recognises the phrase the privacy page tells people to send, and its variants', () => {
    for (const text of [
      'מחקו את המידע שלי',
      'תמחק את הפרטים שלי בבקשה',
      'אני רוצה למחוק את הנתונים שלי',
      'מחקו את כל המידע האישי שלי',
      'אבקש שתמחקו את המידע שלי.',
      'בקשה: מחיקת הנתונים שלי',
      'תמחקו אותי מהמערכת',
      'Delete my data',
      'please erase my personal information',
    ]) {
      expect(isDeletionRequest(text), text).toBe(true);
    }
  });

  it('is not triggered by a seller correcting what they sent or talking about a listing', () => {
    for (const text of [
      'טעיתי, תמחק את המידע ששלחתי קודם, הכתובת היא הרצל 5',
      'איך מוחקים? למחוק את הפרטים של הנכס הישן',
      'מחיקת הנתונים הישנים מהמודעה ביד2',
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

describe('isSpeakWithLidorRequest', () => {
  it('recognises an explicit request to speak with Lidor or a person', () => {
    for (const text of [
      'אני רוצה לדבר עם לידור',
      'אפשר לדבר עם לידור?',
      'מתי אפשר לדבר עם לידור על המחיר?',
      'אני רוצה לדבר עם בן אדם',
      'אפשר לדבר עם נציג?',
      'תעביר אותי ללידור',
      'I want to talk to a human',
      'can I speak with Lidor',
    ]) {
      expect(isSpeakWithLidorRequest(text), text).toBe(true);
    }
  });

  it('is not triggered by mentioning Lidor, someone else, or a negation', () => {
    for (const text of [
      'לפני שאני מחליט אני צריך לדבר עם מישהו במשפחה',
      'לידור נשמע מקצועי',
      'מתי לידור יתקשר?',
      'אני לא צריך לדבר עם לידור, רק שאלה',
      'אין צורך לדבר עם נציג',
      'קביעת פגישה',
      'כן',
    ]) {
      expect(isSpeakWithLidorRequest(text), text).toBe(false);
    }
  });
});
