import { describe, expect, it } from 'vitest';
import type { TurnAction } from './decide.js';
import {
  INTRO_VIDEO_PATH,
  MAIN_MENU,
  mainMenuChoiceFor,
  screeningQuestionFor,
  WELCOME_MESSAGE,
} from './interactive.js';

const SCREENING_ACTIONS: TurnAction[] = [
  'ask_sell_intent',
  'ask_neighborhood',
  'ask_timeline',
  'ask_currently_marketed',
];

describe('interactive content', () => {
  it('has a verbatim welcome and the intro video asset path', () => {
    expect(WELCOME_MESSAGE).toContain('נתחיל בכמה שאלות קצרות?');
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
    expect(screeningQuestionFor('ask_neighborhood')?.kind).toBe('list');
    expect(screeningQuestionFor('ask_timeline')?.kind).toBe('list');
  });

  it('offers the four main-menu options within the list caps', () => {
    expect(MAIN_MENU.rows).toHaveLength(4);
    expect(MAIN_MENU.rows.map((r) => r.id)).toEqual([
      'menu:check_fit',
      'menu:learn_more',
      'menu:book_meeting',
      'menu:testimonials',
    ]);
    expect(MAIN_MENU.buttonLabel.length).toBeLessThanOrEqual(20);
    for (const row of MAIN_MENU.rows) {
      expect(row.title.length).toBeLessThanOrEqual(24);
    }
  });

  it('maps a tapped or typed menu option to its choice', () => {
    expect(mainMenuChoiceFor('בדיקת התאמה ✅')).toBe('check_fit');
    expect(mainMenuChoiceFor('ℹ️ לשמוע פרטים')).toBe('learn_more');
    expect(mainMenuChoiceFor('קביעת פגישה 📅')).toBe('book_meeting');
    expect(mainMenuChoiceFor('המלצות ⭐')).toBe('testimonials');
    // The talk-to-human option was removed; it is no longer a menu choice.
    expect(mainMenuChoiceFor('דברו איתי 👤')).toBeUndefined();
    // A normal answer is not a menu choice.
    expect(mainMenuChoiceFor('שכונת רמות')).toBeUndefined();
    expect(mainMenuChoiceFor('יאללה')).toBeUndefined();
  });

  it('respects WhatsApp length caps: ≤3 buttons (title ≤20), ≤10 rows (title ≤24)', () => {
    for (const action of SCREENING_ACTIONS) {
      const q = screeningQuestionFor(action)!;
      if (q.kind === 'buttons') {
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
