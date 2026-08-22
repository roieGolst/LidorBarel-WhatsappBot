import { resolve } from 'node:path';
import type { ConversationStage } from '../db/repositories/conversations.js';
import type { ListRow, ReplyButton } from '../whatsapp/channel.js';
import type { KnownFacts, TurnAction } from './decide.js';

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

/**
 * Welcome (spec §2), the first thing a new conversation receives. The spec text,
 * plus a note that answers can be tapped OR typed freely (the questions come with
 * buttons, but every one is also answerable in the person's own words — see
 * `screeningAnswerFor` and the classifier), and the control words they can type at
 * any point (restart / back / stop) — Roie's addition so they always know how to
 * change an answer, go back, or end.
 */
export const WELCOME_MESSAGE =
  'היי! 👋 תודה שהשארת פרטים לגבי הנכס.\n\n' +
  'כדי שנוכל להעריך את שווי הנכס ולהתקדם לקביעת שיחה, אשאל אותך כמה שאלות קצרות. שנתחיל?\n\n' +
  'אפשר לבחור מהכפתורים או פשוט לענות במילים שלך — מה שנוח לך 🙂\n\n' +
  'בכל שלב אפשר לכתוב:\n' +
  '*התחל מחדש* – כדי להתחיל מההתחלה\n' +
  '*חזור* – כדי לתקן את התשובה האחרונה\n' +
  '*עצור* – כדי לסיים את השיחה';

/**
 * Mandatory, model-free replies for the guard rails. Each is sent instead of an
 * AI turn when a limit is hit, so they must stay clean and on-voice on their own.
 */
export const THROTTLE_MESSAGE =
  'קיבלתי את כל הפרטים, תודה! 🙏 יש לי מספיק כדי להעביר את זה ללידור — הוא יעבור על הכול ויחזור אליך בהקדם. אין צורך לשלוח הודעות נוספות בינתיים.';
export const QUOTA_HANDOFF_MESSAGE =
  'תודה על כל הפרטים! אני מעביר אותך עכשיו ללידור, שימשיך איתך אישית ויחזור אליך בהקדם.';
export const EXPIRED_MESSAGE =
  'עברו כמה ימים מאז ששוחחנו, אז סגרתי את השיחה הזו. אפשר לכתוב לנו שוב בכל עת כדי להתחיל מחדש 🙏';
export const ABUSE_WARNING_MESSAGE =
  'אני כאן כדי לעזור לך עם הנכס בלבד. נשמור על השיחה עניינית 🙂';
/** Redirect for a benign but off-topic message (a recipe, a shopping list). */
export const OFF_TOPIC_REDIRECT_MESSAGE =
  'אני כאן כדי לעזור לך עם הנכס בלבד. נשמור על השיחה עניינית 🙂';
export const ABUSE_BAN_MESSAGE = 'לא נוכל להמשיך בשיחה הזו. כל טוב.';
/**
 * Sent when the lead sends media the bot can't process — a voice note, an audio
 * clip, a document, or a sticker. Friendly, and points them to the ways it CAN
 * help: plain text or the menu buttons. (Photos are handled separately — they
 * are useful property media and are acknowledged, not refused.)
 */
export const UNSUPPORTED_MEDIA_MESSAGE =
  'סליחה, אני לא יכול לעבד הודעות מהסוג הזה 🙏 אפשר לכתוב לי בטקסט או לבחור מהכפתורים, ואשמח לעזור.';
export const STOP_MESSAGE =
  'סגרתי את השיחה. אפשר לכתוב לנו שוב בכל עת כדי להתחיל מחדש 🙏';

/**
 * Sent when all four questions are answered. Deliberately canned (not
 * model-written) so it never promises a specific callback time — it only says the
 * details are on their way to Lidor — and it leaves the conversation OPEN,
 * inviting more property details that get appended to the lead.
 */
export const QUALIFIED_HANDOFF_MESSAGE =
  'תודה על הפרטים! אני מעביר אותם ללידור עכשיו — הוא יחזור אליך בהקדם לשיחת הערכה ולבניית תוכנית מכירה מותאמת. 👍 בינתיים, אפשר להשאיר כאן פרטים נוספים על הנכס שיעזרו למקד את השיחה עם לידור, ואני אעביר לו גם אותם.';

/** Talk-to-a-human / book-a-meeting handoff — canned, no callback-time promise. */
export const HANDOFF_TO_HUMAN_MESSAGE =
  'מעולה, אני מעביר אותך ללידור עם כל הפרטים. הוא יחזור אליך בהקדם.';

/**
 * Sent when a lead asks to book a meeting (or otherwise shows clear intent to
 * proceed). Brief and decisive, focused on scheduling the call, while making
 * clear a few quick details come first. The screening question follows it.
 */
export const BOOKING_LEADIN_MESSAGE =
  'מעולה, נתקדם לקביעת פגישה עם לידור 📅 רק אאסוף כמה פרטים קצרים על הנכס כדי שהשיחה תהיה ממוקדת, ואז אעביר את הפרטים ללידור שיצור איתך קשר.';

/**
 * Acknowledges extra details a qualified lead sent. Short and natural — it does
 * NOT read the details back (they are already saved to the lead), and never
 * promises a callback time.
 */
export const ADDITIONAL_INFO_ACK_MESSAGE =
  'מעולה, קיבלתי — אעביר את זה ללידור יחד עם שאר הפרטים. אם יש עוד משהו שחשוב שיידע, אני כאן.';

/**
 * Asked once, after the screening questions. It doubles as the seriousness check
 * and as a way to collect the property details that help Lidor prepare — the
 * answer's substance both reveals a genuine seller and is saved to the lead.
 */
export const INTENT_QUESTION =
  'כדי שלידור יגיע לשיחה מוכן — תוכל/י לשתף כמה פרטים על הנכס? למשל כתובת מדויקת, מספר חדרים, קומה, מצב הנכס, ומחיר משוער שחשבת עליו. 🙂';

/**
 * Asked when a lead who has ALREADY completed the flow taps "check fit" or
 * "book a meeting" again. Their details are with Lidor, so re-running the whole
 * questionnaire would be a step backwards — the bot confirms first and only an
 * explicit yes restarts it (see `confirmation.ts` / `confirm_restart`).
 */
export const RESTART_CONFIRM_MESSAGE =
  'כבר אספתי את כל הפרטים שצריך והם אצל לידור 🙂 בטוח שתרצה שנתחיל את התהליך מחדש?';

/** Sent when the person declines the restart — nothing changes, no pressure. */
export const RESTART_DECLINED_MESSAGE =
  'מעולה, אז משאיר הכול כמו שהוא. הפרטים אצל לידור והוא יחזור אליך בהקדם 🙏';

/**
 * A lead who is mainly price-checking, not seriously selling. We do NOT forward
 * them to Lidor; we leave the door open for when they are ready.
 */
export const LOW_INTENT_MESSAGE =
  'תודה על השיתוף! כשתרגיש שהזמן מתאים להתקדם, נשמח ללוות אותך. אפשר לחזור אליי בכל שלב.';

/**
 * The intro clip sent after the welcome (spec §2). Resolved from the app's
 * working directory; the channel uploads it to Meta once and caches the id.
 */
export const INTRO_VIDEO_PATH = resolve(process.cwd(), 'assets/intro_video.mp4');

/**
 * The opening menu (spec §8), sent after the intro clip as an interactive LIST —
 * WhatsApp renders it as a single "כל האפשרויות" button that opens a clean
 * bottom-sheet of the options, each with a short description. A list (not reply
 * buttons) is used so all the options fit and read elegantly; the two actions
 * that move a lead forward — a fit check and booking — come first. Booking runs
 * the same screening flow (a call is booked only after a few quick details), so
 * there is no separate "talk to a human" shortcut.
 */
export const MAIN_MENU = {
  body: 'אשמח לעזור לך למכור את הנכס במחיר הטוב ביותר 🏠\nאיך תרצה להתחיל?',
  buttonLabel: 'כל האפשרויות',
  rows: [
    {
      id: 'menu:check_fit',
      title: 'בדיקת התאמה',
      description: 'נבדוק יחד אם הנכס מתאים ונתחיל בהערכה',
    },
    {
      id: 'menu:book_meeting',
      title: 'קביעת פגישה',
      description: 'לתאם שיחה אישית עם לידור',
    },
    {
      id: 'menu:testimonials',
      title: 'המלצות',
      description: 'לקוחות שכבר מכרו עם לידור',
    },
    {
      id: 'menu:learn_more',
      title: 'מידע עלי',
      description: 'מי זה לידור ואיך הוא עובד',
    },
  ],
} as const;

/** A main-menu choice, resolved from the tapped row (or typed text). */
export type MainMenuChoice = 'check_fit' | 'learn_more' | 'book_meeting' | 'testimonials';

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
  if (t.includes('קביעת פגישה')) return 'book_meeting';
  if (t.includes('המלצות')) return 'testimonials';
  // "מידע עלי" is the menu label; "לשמוע פרטים" is the older wording, still honored.
  if (t.includes('מידע עלי') || t.includes('לשמוע פרטים')) return 'learn_more';
  return undefined;
}

/**
 * A screening question rendered as plain text or one of WhatsApp's two
 * interactive shapes.
 */
export type ScreeningQuestion =
  | { kind: 'text'; body: string }
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
  // Q2 — neighborhood. An OPEN question rather than a list: Be'er Sheva has ~30
  // neighborhoods (more than a WhatsApp list's 10-row cap), and an "other" row
  // just loops. The person types the neighborhood — or a full address — and it is
  // parsed and matched against the full list (see domain/neighborhoods.ts).
  ask_neighborhood: {
    kind: 'text',
    body: 'באיזו שכונה נמצא הנכס? אפשר לכתוב שם שכונה, ואם נוח יותר — כתובת מלאה.',
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

/** The screening stage where each interactive question is being collected. */
const STAGE_TO_SCREENING_ACTION: Partial<Record<ConversationStage, TurnAction>> = {
  screening_sell_intent: 'ask_sell_intent',
  screening_timeline: 'ask_timeline',
  screening_currently_marketed: 'ask_currently_marketed',
};

/**
 * The `KnownFacts` field each option-id prefix fills. Button/list ids are authored
 * as `<prefix>:<value>` where `<value>` is exactly the enum token (see
 * SCREENING_QUESTIONS), so a matched option maps straight onto the fact.
 */
const OPTION_PREFIX_FIELD = {
  sell_intent: 'sellIntent',
  timeline: 'timeline',
  marketed: 'currentlyMarketed',
} as const;

/**
 * Deterministically resolves a screening answer from the message, when it is an
 * EXACT match for one of the pending question's options.
 *
 * WhatsApp echoes a tapped button/list row back as its title text (see
 * `payload.ts`), and a person may also just type that same word. Either way the
 * answer to a fixed-option question is unambiguous — so it is mapped to the enum
 * here, deterministically, rather than left to the classifier. That closes a real
 * gap: a terse "לא" answering Q4 was sometimes missed by the model, which then
 * re-asked the very same question. Returns the fact to merge, or `undefined` when
 * the stage has no fixed options (Q2 is free-text) or the text is not an option.
 */
export function screeningAnswerFor(
  stage: ConversationStage,
  text: string,
): Partial<KnownFacts> | undefined {
  const action = STAGE_TO_SCREENING_ACTION[stage];
  if (!action) return undefined;
  const question = SCREENING_QUESTIONS[action];
  if (!question || question.kind === 'text') return undefined;

  const options = question.kind === 'buttons' ? question.buttons : question.rows;
  const trimmed = text.trim();
  const match = options.find((option) => option.title.trim() === trimmed);
  if (!match) return undefined;

  const [prefix, value] = match.id.split(':');
  const field = OPTION_PREFIX_FIELD[prefix as keyof typeof OPTION_PREFIX_FIELD];
  if (!field || !value) return undefined;
  return { [field]: value };
}

/** The plain-text body of a screening question — the text stored for the turn. */
export function screeningBody(question: ScreeningQuestion): string {
  return question.body;
}

/**
 * Fixed, model-free replies for actions whose wording should never vary — closes
 * and the intent check. Canned so they read naturally, stay short, keep correct
 * Hebrew grammar, and never promise a callback time. Everything else is written
 * by the model.
 */
const CANNED_REPLIES: Partial<Record<TurnAction, string>> = {
  proceed_qualified: QUALIFIED_HANDOFF_MESSAGE,
  handoff_to_human: HANDOFF_TO_HUMAN_MESSAGE,
  acknowledge_additional_info: ADDITIONAL_INFO_ACK_MESSAGE,
  // `ask_intent` is intentionally NOT here: it is model-written and
  // context-aware (see generate.ts), so it acknowledges what the seller already
  // shared and asks only for what is missing, rather than a blind fixed script.
  low_intent_hold: LOW_INTENT_MESSAGE,
  stay_on_topic: OFF_TOPIC_REDIRECT_MESSAGE,
  // The restart confirmation must be exact — it gates redoing the whole flow.
  confirm_restart: RESTART_CONFIRM_MESSAGE,
};

/** The canned reply for an action, or `undefined` if the action is model-written. */
export function cannedReplyFor(action: TurnAction): string | undefined {
  return CANNED_REPLIES[action];
}
