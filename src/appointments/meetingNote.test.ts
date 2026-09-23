import { describe, expect, it } from 'vitest';
import { activityItemName, callbackNote, meetingNote } from './meetingNote.js';

const TZ = 'Asia/Jerusalem';
const slot = {
  start: new Date('2026-09-22T10:30:00Z'), // 13:30 Israel, a Tuesday
  end: new Date('2026-09-22T11:15:00Z'),
};

describe('activityItemName', () => {
  it('names the item — and so the calendar event — after the person', () => {
    expect(activityItemName('פגישת ייעוץ', { name: 'רועי גולסט' })).toBe(
      'פגישת ייעוץ עם רועי גולסט',
    );
  });

  it('falls back to the bare kind when no name is known', () => {
    expect(activityItemName('פגישת ייעוץ', { name: null })).toBe('פגישת ייעוץ');
    expect(activityItemName('פגישת ייעוץ', { name: '  ' })).toBe('פגישת ייעוץ');
  });
});

describe('meetingNote', () => {
  it('tells Lidor everything the bot knows, in CRM Hebrew', () => {
    const note = meetingNote({
      contact: { name: 'רועי גולסט', phone: '+972501234567' },
      facts: {
        neighborhood: 'רמות',
        sellIntent: 'ready',
        timeline: 'immediate',
        currentlyMarketed: 'no',
        bookingIntent: true,
        additionalNotes: '4 חדרים, קומה 2, משופצת',
      },
      priorityScore: 93,
      slot,
      timeZone: TZ,
      rescheduled: false,
    });

    // One line — it goes into a `text` column mapped to the event description.
    expect(note.split(' | ')).toEqual([
      'פגישת ייעוץ נקבעה דרך הבוט ליום שלישי 13:30 (22 בספטמבר)',
      'רועי גולסט · +972501234567',
      'שכונה: רמות · מוכנות: מוכן למכור · מועד: מיידי · שיווק: לא משווק',
      'ציון רצינות: 93',
      'הנכס: 4 חדרים, קומה 2, משופצת',
      'ביקש/ה פגישה ביוזמתו/ה',
    ]);
  });

  it('says a moved meeting was moved, and omits what is not known', () => {
    const note = meetingNote({
      contact: { name: null, phone: '+972501234567' },
      facts: { neighborhood: 'רמות' },
      priorityScore: null,
      slot,
      timeZone: TZ,
      rescheduled: true,
    });

    expect(note.split(' | ')).toEqual([
      'הפגישה הועברה דרך הבוט ליום שלישי 13:30 (22 בספטמבר)',
      '+972501234567',
      'שכונה: רמות',
    ]);
  });
});

describe('callbackNote', () => {
  it('says when the exclusivity ends and whom to call', () => {
    const note = callbackNote({
      contact: { name: 'רועי גולסט', phone: '+972501234567' },
      facts: { neighborhood: 'רמות', currentlyMarketed: 'with_agent' },
      priorityScore: 40,
      exclusivityEndsOn: '2026-09-09',
    });

    expect(note.split(' | ')).toEqual([
      'תזכורת מהבוט: הבלעדיות אצל המתווך הנוכחי מסתיימת ב-2026-09-09 — לחזור ללקוח',
      'רועי גולסט · +972501234567',
      'שכונה: רמות · שיווק: משווק דרך מתווך אחר',
      'ציון רצינות: 40',
    ]);
  });
});

describe('meetingNote with a brief', () => {
  it('adds the property as described, the concerns, and the focus point', () => {
    const note = meetingNote({
      contact: { name: 'רועי גולסט', phone: '+972501234567' },
      facts: { neighborhood: 'רמות', additionalNotes: 'ישן: 4 חדרים' },
      priorityScore: 93,
      slot,
      timeZone: TZ,
      rescheduled: false,
      brief: {
        property: 'רחוב רגר 15, 4 חדרים, קומה 2, משופצת',
        concerns: ['שאל על העמלה', 'רוצה למכור לפני שקונה'],
        focus: 'להוביל עם זמן המכירה הקצר ולהציע תיאום בין מכירה לקנייה',
      },
    });

    // The brief's property line supersedes the stored notes.
    expect(note.split(' | ')).toEqual([
      'פגישת ייעוץ נקבעה דרך הבוט ליום שלישי 13:30 (22 בספטמבר)',
      'רועי גולסט · +972501234567',
      'שכונה: רמות',
      'ציון רצינות: 93',
      'הנכס: רחוב רגר 15, 4 חדרים, קומה 2, משופצת',
      'שאלות וחששות: שאל על העמלה; רוצה למכור לפני שקונה',
      'פוקוס לסגירה: להוביל עם זמן המכירה הקצר ולהציע תיאום בין מכירה לקנייה',
    ]);
  });
});
