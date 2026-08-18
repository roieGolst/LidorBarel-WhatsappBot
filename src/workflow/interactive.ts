import { resolve } from 'node:path';
import type { ListRow, ReplyButton } from '../whatsapp/channel.js';
import type { TurnAction } from './decide.js';

/**
 * The spec's opening sequence (§2) and buttons-first screening (§8), as data.
 *
 * The four screening questions are fixed spec text with fixed options, so they
 * are sent deterministically — the exact question, the exact buttons — rather
 * than phrased by the model. That guarantees the wording and the option set are
 * on-spec and costs no tokens; the LLM is still used for everything that genuinely
 * needs judgement (FAQs, objections, clarifications, the handoff).
 *
 * Button/list `title`s are what the person taps, and WhatsApp echoes the chosen
 * title back as the inbound message text (see `payload.ts`), so each title is
 * kept both within Meta's length caps (button ≤ 20, list row ≤ 24) and worded so
 * the classifier maps it onto the right screening enum.
 */

/** Verbatim welcome (spec §2), the first thing a new conversation receives. */
export const WELCOME_MESSAGE =
  'היי! 👋 תודה שהשארת פרטים לגבי הנכס שלך. אני רק רוצה להכיר אותו קצת כדי שנוכל לתת לך הערכת שווי כמה שיותר מדויקת ולהבין מה פוטנציאל המכירה שלו. נתחיל בכמה שאלות קצרות?';

/**
 * The intro clip sent after the welcome (spec §2). Resolved from the app's
 * working directory; the channel uploads it to Meta once and caches the id.
 */
export const INTRO_VIDEO_PATH = resolve(process.cwd(), 'assets/intro_video.mp4');

/**
 * The opening main menu (spec §8 `main_buttons`, conversation_style
 * hybrid_buttons_first). After the welcome + video, the person is shown these
 * five choices and picks how to start — `check_fit` begins the screening, the
 * rest branch elsewhere. Five options exceed WhatsApp's 3-button cap, so it is a
 * list. `talk_to_human` is last so the primary paths sit at the top.
 */
export const MAIN_MENU = {
  body: 'איך תרצה להתחיל? אפשר לבדוק התאמה מהירה, לשמוע פרטים, או לדבר איתנו ישירות.',
  buttonLabel: 'בחירת אפשרות',
  rows: [
    { id: 'menu:check_fit', title: '✅ בדיקת התאמה' },
    { id: 'menu:learn_more', title: 'ℹ️ לשמוע פרטים' },
    { id: 'menu:book_meeting', title: '📅 קביעת פגישה' },
    { id: 'menu:testimonials', title: '⭐ המלצות' },
    { id: 'menu:talk_to_human', title: '👤 דברו איתי' },
  ],
} as const;

/** A main-menu choice, resolved from the tapped row (or typed text). */
export type MainMenuChoice =
  'check_fit' | 'learn_more' | 'book_meeting' | 'testimonials' | 'talk_to_human';

/**
 * Maps a message to a main-menu choice, or `undefined` if it is not one.
 *
 * A tapped row echoes its title verbatim, so matching the distinctive Hebrew
 * phrase (ignoring the leading emoji) catches both taps and someone typing the
 * same words.
 */
export function mainMenuChoiceFor(text: string): MainMenuChoice | undefined {
  const t = text.trim();
  if (t.includes('בדיקת התאמה')) return 'check_fit';
  if (t.includes('לשמוע פרטים')) return 'learn_more';
  if (t.includes('קביעת פגישה')) return 'book_meeting';
  if (t.includes('המלצות')) return 'testimonials';
  if (t.includes('דברו איתי')) return 'talk_to_human';
  return undefined;
}

/** A screening question rendered as one of WhatsApp's two interactive shapes. */
export type ScreeningQuestion =
  | { kind: 'buttons'; body: string; buttons: ReplyButton[] }
  | { kind: 'list'; body: string; buttonLabel: string; rows: ListRow[] };

/**
 * The interactive question for each screening action. Only the four `ask_*`
 * actions are here; every other action is free-form text from the generator.
 * Three options fit reply buttons; four need a list.
 */
const SCREENING_QUESTIONS: Partial<Record<TurnAction, ScreeningQuestion>> = {
  // Q1 — sell intent (direct-message leads only).
  ask_sell_intent: {
    kind: 'buttons',
    body: 'האם חשבת למכור את הדירה, או רק לקבל הערכת מחיר?',
    buttons: [
      { id: 'sell_intent:ready', title: 'כן, רוצה למכור' },
      { id: 'sell_intent:not_sure', title: 'מתלבט, רוצה מחיר' },
      { id: 'sell_intent:not_selling', title: 'לא מעוניין למכור' },
    ],
  },
  // Q2 — neighborhood (four options → list).
  ask_neighborhood: {
    kind: 'list',
    body: 'באיזו שכונה נמצא הנכס?',
    buttonLabel: 'בחירת שכונה',
    rows: [
      { id: 'neighborhood:neve_zeev', title: 'שכונת נווה זאב' },
      { id: 'neighborhood:nahal_ashan', title: 'שכונת נחל עשן' },
      { id: 'neighborhood:ramot', title: 'שכונת רמות' },
      {
        id: 'neighborhood:alef_tet',
        title: 'שכונות א׳–ט׳',
        description: 'א׳, ב׳, ג׳, ד׳, ה׳, ו׳, ט׳',
      },
    ],
  },
  // Q3 — timeline (four options → list).
  ask_timeline: {
    kind: 'list',
    body: 'אם תקבל הצעה שמתאימה לציפיות שלך, תוך כמה זמן תרצה למכור?',
    buttonLabel: 'בחירת זמן',
    rows: [
      { id: 'timeline:immediate', title: 'מיד' },
      { id: 'timeline:within_month', title: 'בחודש הקרוב' },
      { id: 'timeline:still_checking', title: 'בחודשים הקרובים' },
      { id: 'timeline:no_urgency', title: 'אין לי דחיפות' },
    ],
  },
  // Q4 — currently marketed (three options → buttons).
  ask_currently_marketed: {
    kind: 'buttons',
    body: 'האם הנכס משווק כרגע?',
    buttons: [
      { id: 'marketed:no', title: 'לא' },
      { id: 'marketed:privately', title: 'כן, באופן פרטי' },
      { id: 'marketed:with_agent', title: 'כן, עם מתווך' },
    ],
  },
};

/** The interactive question for an action, or `undefined` if it isn't a screen. */
export function screeningQuestionFor(action: TurnAction): ScreeningQuestion | undefined {
  return SCREENING_QUESTIONS[action];
}

/** The plain-text body of a screening question — the text stored for the turn. */
export function screeningBody(question: ScreeningQuestion): string {
  return question.body;
}
