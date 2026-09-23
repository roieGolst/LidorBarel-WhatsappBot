import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODEL } from '../llm/client.js';
import { FakeLlmClient } from '../llm/fake.js';
import { generateMeetingBrief, parseBrief } from './meetingBrief.js';

const BRIEF = JSON.stringify({
  property: 'רחוב רגר 15, 4 חדרים, קומה 2, משופצת, חניה',
  concerns: ['שאל על גובה העמלה', 'חושש שהמכירה תיקח זמן'],
  focus: 'להדגיש את זמן המכירה הממוצע (82% בפחות מחודשיים) ולפרט את העמלה בשקיפות',
});

describe('parseBrief', () => {
  it('reads the three fields', () => {
    expect(parseBrief(BRIEF)).toEqual({
      property: 'רחוב רגר 15, 4 חדרים, קומה 2, משופצת, חניה',
      concerns: ['שאל על גובה העמלה', 'חושש שהמכירה תיקח זמן'],
      focus: 'להדגיש את זמן המכירה הממוצע (82% בפחות מחודשיים) ולפרט את העמלה בשקיפות',
    });
  });

  it('tolerates prose around the JSON and missing fields', () => {
    expect(parseBrief(`הנה התקציר:\n{"focus":"לדבר על המחיר"}\nבהצלחה`)).toEqual({
      property: '',
      concerns: [],
      focus: 'לדבר על המחיר',
    });
  });

  it('treats garbage, and an empty brief, as no brief', () => {
    expect(parseBrief('not json')).toBeUndefined();
    expect(parseBrief('{"intent":"UNCLEAR","confidence":0.2}')).toBeUndefined();
    expect(parseBrief('{"property":"  ","concerns":["  "],"focus":""}')).toBeUndefined();
  });
});

describe('generateMeetingBrief', () => {
  it('asks the cheap model with the transcript and what is on file, and returns the brief', async () => {
    const llm = new FakeLlmClient([BRIEF]);
    const history = [
      { role: 'assistant' as const, content: 'באיזו שכונה נמצא הנכס?' },
      { role: 'user' as const, content: 'רגר 15, נחל עשן. כמה העמלה?' },
    ];

    const result = await generateMeetingBrief(llm, {
      history,
      facts: { neighborhood: 'נחל עשן', additionalNotes: '4 חדרים, קומה 2' },
    });

    expect(result.brief?.focus).toContain('העמלה');
    expect(result.usage?.model).toBe(CLASSIFIER_MODEL);
    const request = llm.requests[0]!;
    expect(request.model).toBe(CLASSIFIER_MODEL);
    expect(request.messages.slice(0, 2)).toEqual(history);
    expect(request.messages.map((m) => m.content)).toContainEqual(
      '(על הנכס בקובץ: שכונה: נחל עשן · פרטי הנכס: 4 חדרים, קומה 2)',
    );
    expect(request.system).toContain('"focus"');
  });

  it('never throws — a model failure means no brief, not a failed booking', async () => {
    // A fake with nothing queued rejects the call, like an outage would.
    const result = await generateMeetingBrief(new FakeLlmClient([]), {
      history: [],
      facts: {},
    });

    expect(result).toEqual({});
  });
});
