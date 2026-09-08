import { describe, expect, it } from 'vitest';
import type { TurnAction } from './decide.js';
import {
  cannedReplyFor,
  disqualificationClose,
  DISQUALIFIED_MESSAGE,
  EXCLUSIVE_FOLLOWUP_MESSAGE,
  EXCLUSIVE_NO_FOLLOWUP_MESSAGE,
  EXCLUSIVITY_QUESTION,
  FACT_CHANGE_APPLIED_MESSAGE,
  FACT_CHANGE_DECLINED_MESSAGE,
  factChangeConfirmation,
  INTRO_VIDEO_PATH,
  MAIN_MENU,
  mainMenuChoiceFor,
  screeningAnswerFor,
  screeningQuestionFor,
  WELCOME_MESSAGE,
} from './interactive.js';
import { validateReply } from './validate.js';

const SCREENING_ACTIONS: TurnAction[] = [
  'ask_sell_intent',
  'ask_neighborhood',
  'ask_timeline',
  'ask_currently_marketed',
];

describe('interactive content', () => {
  it('has a verbatim welcome and the intro video asset path', () => {
    expect(WELCOME_MESSAGE).toContain('שאלות קצרות');
    expect(INTRO_VIDEO_PATH.endsWith('assets/intro_video.mp4')).toBe(true);
  });

  it('provides an interactive question for every screening action', () => {
    for (const action of SCREENING_ACTIONS) {
      expect(screeningQuestionFor(action)).toBeDefined();
    }
  });

  it('has no question for non-screening actions', () => {
    for (const action of [
      'proceed_qualified',
      'answer_faq',
      'handle_objection',
    ] as TurnAction[]) {
      expect(screeningQuestionFor(action)).toBeUndefined();
    }
  });

  it('uses buttons for ≤3 options and a list for more', () => {
    expect(screeningQuestionFor('ask_sell_intent')?.kind).toBe('buttons');
    expect(screeningQuestionFor('ask_currently_marketed')?.kind).toBe('buttons');
    expect(screeningQuestionFor('ask_neighborhood')?.kind).toBe('text');
    expect(screeningQuestionFor('ask_timeline')?.kind).toBe('list');
  });

  it('is an elegant list: priorities first, a description per row, within the caps', () => {
    expect(MAIN_MENU.rows.map((r) => r.id)).toEqual([
      'menu:check_fit',
      'menu:book_meeting',
      'menu:testimonials',
      'menu:learn_more',
    ]);
    // The single "open the list" button label, within Meta's 20-char cap.
    expect(MAIN_MENU.buttonLabel).toBe('כל האפשרויות');
    expect(MAIN_MENU.buttonLabel.length).toBeLessThanOrEqual(20);
    for (const row of MAIN_MENU.rows) {
      expect(row.title.length).toBeLessThanOrEqual(24);
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.description.length).toBeLessThanOrEqual(72);
    }
  });

  it('maps a tapped or typed menu option to its choice', () => {
    expect(mainMenuChoiceFor('בדיקת התאמה')).toBe('check_fit');
    expect(mainMenuChoiceFor('קביעת פגישה')).toBe('book_meeting');
    expect(mainMenuChoiceFor('המלצות')).toBe('testimonials');
    expect(mainMenuChoiceFor('מידע עלי')).toBe('learn_more');
    // The older "לשמוע פרטים" wording still maps to learn_more.
    expect(mainMenuChoiceFor('ℹ️ לשמוע פרטים')).toBe('learn_more');
    // A normal answer is not a menu choice.
    expect(mainMenuChoiceFor('שכונת רמות')).toBeUndefined();
    expect(mainMenuChoiceFor('יאללה')).toBeUndefined();
  });

  describe('screeningAnswerFor (deterministic option mapping)', () => {
    it('maps an exact Q4 answer to the enum — the bare "לא" that was missed', () => {
      expect(screeningAnswerFor('screening_currently_marketed', 'לא')).toEqual({
        currentlyMarketed: 'no',
      });
      expect(
        screeningAnswerFor('screening_currently_marketed', ' כן, עם מתווך '),
      ).toEqual({ currentlyMarketed: 'with_agent' });
    });

    it('maps Q1 and Q3 options too', () => {
      expect(screeningAnswerFor('screening_sell_intent', 'מתלבט, רוצה מחיר')).toEqual({
        sellIntent: 'not_sure',
      });
      expect(screeningAnswerFor('screening_timeline', 'מיד')).toEqual({
        timeline: 'immediate',
      });
    });

    it('returns undefined for free-text stages, non-options, and non-screening stages', () => {
      // Q2 is free text — no fixed options to match.
      expect(screeningAnswerFor('screening_neighborhood', 'רמות')).toBeUndefined();
      // Not one of Q4's option titles.
      expect(
        screeningAnswerFor('screening_currently_marketed', 'אולי בעתיד'),
      ).toBeUndefined();
      // "לא" only means "not marketed" at Q4, not at an unrelated stage.
      expect(screeningAnswerFor('assessing_intent', 'לא')).toBeUndefined();
    });
  });

  it('respects WhatsApp length caps: ≤3 buttons (title ≤20), ≤10 rows (title ≤24)', () => {
    for (const action of SCREENING_ACTIONS) {
      const q = screeningQuestionFor(action)!;
      if (q.kind === 'text') {
        expect(q.body.length).toBeGreaterThan(0);
      } else if (q.kind === 'buttons') {
        expect(q.buttons.length).toBeLessThanOrEqual(3);
        for (const b of q.buttons) {
          expect(b.title.length).toBeLessThanOrEqual(20);
          expect(b.title.length).toBeGreaterThan(0);
        }
      } else {
        expect(q.rows.length).toBeLessThanOrEqual(10);
        expect(q.buttonLabel.length).toBeLessThanOrEqual(20);
        for (const r of q.rows) {
          expect(r.title.length).toBeLessThanOrEqual(24);
          expect(r.title.length).toBeGreaterThan(0);
          if (r.description) expect(r.description.length).toBeLessThanOrEqual(72);
        }
      }
    }
  });
});

describe('the fixed closes and checks', () => {
  it.each([
    ['exclusivity question', EXCLUSIVITY_QUESTION],
    ['disqualified', DISQUALIFIED_MESSAGE],
    ['exclusive, follow-up', EXCLUSIVE_FOLLOWUP_MESSAGE],
    ['exclusive, no follow-up', EXCLUSIVE_NO_FOLLOWUP_MESSAGE],
    ['change applied', FACT_CHANGE_APPLIED_MESSAGE],
    ['change declined', FACT_CHANGE_DECLINED_MESSAGE],
  ])('%s passes the same validator as a model-written reply', (_name, text) => {
    expect(validateReply(text).ok).toBe(true);
  });

  it('picks the close by reason and follow-up wish', () => {
    expect(disqualificationClose('not_selling', undefined)).toBe(DISQUALIFIED_MESSAGE);
    expect(disqualificationClose('exclusive_with_other_agent', undefined)).toBe(
      EXCLUSIVE_FOLLOWUP_MESSAGE,
    );
    expect(disqualificationClose('exclusive_with_other_agent', true)).toBe(
      EXCLUSIVE_FOLLOWUP_MESSAGE,
    );
    expect(disqualificationClose('exclusive_with_other_agent', false)).toBe(
      EXCLUSIVE_NO_FOLLOWUP_MESSAGE,
    );
  });

  it('the exclusivity question is canned, not model-written', () => {
    expect(cannedReplyFor('ask_exclusivity')).toBe(EXCLUSIVITY_QUESTION);
  });

  it('the change check quotes both answers and asks exactly one question', () => {
    const check = factChangeConfirmation(
      { field: 'currentlyMarketed', value: 'with_agent' },
      'no',
    );
    expect(check.body).toContain('הנכס משווק דרך מתווך אחר?');
    expect(check.body).toContain('קודם ציינת: הנכס לא משווק כרגע.');
    expect(validateReply(check.body, { requireQuestion: true }).ok).toBe(true);
    expect(check.buttons).toHaveLength(2);

    const place = factChangeConfirmation(
      { field: 'neighborhood', value: 'נווה זאב' },
      'רמות',
    );
    expect(place.body).toContain('הנכס בשכונת נווה זאב?');
    expect(place.body).toContain('הנכס בשכונת רמות.');
  });
});
