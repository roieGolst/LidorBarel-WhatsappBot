import { describeToday, localDate, localParts } from '../domain/localTime.js';
import type { ListRow } from '../whatsapp/channel.js';
import type { Slot } from './availability.js';

/**
 * Turning slots into something a person can read and tap.
 *
 * A tapped list row comes back as its **title text**, so the label is not
 * cosmetic — it is the identifier the choice is matched on. Changing a label
 * format without changing the matcher silently breaks booking.
 */

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;

/** `יום ראשון 10:00` — the day name a caller would actually say. */
export function formatSlot(slot: Slot, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(slot.start);

  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    value('weekday'),
  );
  const day = HEBREW_DAYS[weekdayIndex === -1 ? 0 : weekdayIndex];
  const hour = value('hour') === '24' ? '00' : value('hour');

  return `יום ${day} ${hour}:${value('minute')}`;
}

/** The date, for the row's secondary line — so two "יום ראשון" cannot be confused. */
export function formatDate(slot: Slot, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone,
    day: 'numeric',
    month: 'long',
  }).format(slot.start);
}

export const SLOT_OFFER_BODY =
  'מעולה! 📅 אלה הזמנים הפנויים הקרובים של לידור — מה מתאים לך?';

/** The offer to a high-priority lead who did not ask: a suggestion, not a "great!". */
export const SLOT_SUGGEST_BODY =
  'תודה על הפרטים! 🙏 העברתי אותם ללידור. כדי לחסוך לך זמן, אפשר לקבוע כבר עכשיו שיחת ייעוץ איתו 📅 אלה הזמנים הפנויים הקרובים — ואם אף אחד לא מתאים, פשוט תכתוב לי.';

/** The list sent again after answering a question about the times. */
export const SLOT_REOFFER_BODY =
  'אלה המועדים הפנויים הקרובים של לידור — אפשר לבחור כאן 👇';

/** A tapped time that is no longer on offer (a stale list, or the slot went). */
export const STALE_SLOT_MESSAGE =
  'המועד הזה כבר לא זמין 🙏 אלה המועדים הפנויים של לידור עכשיו:';

/** The lead turned the offered times down: the honest handoff, no re-offer. */
export const SLOTS_DECLINED_MESSAGE =
  'בסדר גמור 🙏 העברתי את הפרטים ללידור והוא יחזור אליך לתאם מועד שנוח לך.';

/** A time tapped after the meeting was already booked. */
export function alreadyBookedMessage(slot: Slot | undefined, timeZone: string): string {
  const when = slot
    ? ` ל${formatSlot(slot, timeZone)} (${formatDate(slot, timeZone)})`
    : '';
  return `הפגישה שלך עם לידור כבר קבועה${when} ✅ אם משהו משתנה — פשוט תכתוב לי כאן.`;
}

export const SLOT_OFFER_BUTTON = 'בחירת מועד';

/**
 * Offered to a lead with a meeting booked who asks for a meeting again: the one
 * they have, and new times to move it to. Nothing changes until they pick one.
 */
export function rescheduleOfferBody(current: Slot, timeZone: string): string {
  return (
    `הפגישה שלך עם לידור קבועה ל${formatSlot(current, timeZone)} ` +
    `(${formatDate(current, timeZone)}) ✅ רוצה להזיז אותה? אלה המועדים הפנויים — ` +
    'בחירה תעביר את הפגישה למועד החדש, ובלי בחירה היא נשארת כמו שהיא.'
  );
}

/** Sent when a lead with a meeting turns the new times down: nothing moved. */
export function rescheduleKeptMessage(current: Slot, timeZone: string): string {
  return `אין בעיה, הפגישה נשארת ל${formatSlot(current, timeZone)} ✅ נתראה!`;
}

/** The confirmation when an existing consultation was moved. */
export function rescheduleConfirmation(slot: Slot, timeZone: string): string {
  return (
    `הפגישה הועברה ל${formatSlot(slot, timeZone)} (${formatDate(slot, timeZone)}) ✅ ` +
    'לידור יתקשר אליך בשעה החדשה.'
  );
}

/**
 * Sent instead of a third written reply in a row while times are on offer:
 * twice the writer answered and twice the person did not pick, which live was
 * the start of a loop. The list, and a plain ask to tap.
 */
export const SLOT_PICK_FROM_LIST_MESSAGE =
  'כדי שאקבע לך את הפגישה — בחר/י בבקשה את המועד מהרשימה 👇';

/** Sent when Lidor has nothing free in the horizon. */
export const NO_SLOTS_MESSAGE =
  'העברתי את הפרטים ללידור והוא יחזור אליך בהקדם לתאם מועד שנוח לך 🙏';

/** Sent when the chosen slot was taken between the offer and the tap. */
export const SLOT_TAKEN_MESSAGE =
  'אוי, המועד הזה בדיוק נתפס 🙏 אלה המועדים שנשארו פנויים:';

/** Confirmation once the meeting is in Lidor's calendar. */
export function bookingConfirmation(slot: Slot, timeZone: string): string {
  return (
    `מצוין, קבעתי! ✅ נתראה ב${formatSlot(slot, timeZone)} ` +
    `(${formatDate(slot, timeZone)}).\n\n` +
    'לידור יחזור אליך לפני הפגישה. אם משהו משתנה — פשוט תכתוב לי כאן.'
  );
}

/**
 * Slots as list rows.
 *
 * WhatsApp caps a row title at 24 characters, which the day-and-time format
 * stays inside comfortably; the date goes in the description so two slots on
 * the same weekday a week apart are distinguishable.
 */
export function slotListRows(slots: readonly Slot[], timeZone: string): ListRow[] {
  return slots.map((slot, index) => ({
    id: `slot:${index}`,
    title: formatSlot(slot, timeZone),
    description: formatDate(slot, timeZone),
  }));
}

/**
 * Resolves a reply to one of the offered slots.
 *
 * Matches on the label rather than the row id because a person may equally type
 * "יום שני 10:00" as tap it, and the two must behave the same. Deliberately
 * exact on the formatted label: a fuzzy match risks booking a different time
 * from the one they meant, which is worse than asking again.
 */
export function matchSlot(
  text: string,
  slots: readonly Slot[],
  timeZone: string,
): Slot | undefined {
  const normalized = text.trim();
  return slots.find((slot) => formatSlot(slot, timeZone) === normalized);
}

/**
 * Whether a message is a slot label — the text a tapped time row echoes back.
 *
 * Checked on every message, not only in the booking stage: a person can tap a
 * row from an OLD list at any point, and that must read as "they want this
 * time", never be handed to the classifier as a fresh property answer.
 */
export function isSlotLabel(text: string): boolean {
  return /^יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת) \d{2}:\d{2}$/.test(text.trim());
}

/**
 * Resolving a time chosen in WORDS against the standing offer, in code.
 *
 * The classifier is asked to do this too (`chosenOfferedTime`), but live it
 * missed "הכי מוקדם היום", then "כן", then "אישרתי כבר!!" — and the writer,
 * left to answer, proposed the time and asked for a confirmation it could not
 * act on, four times in a row. The common phrasings are not ambiguous and must
 * not depend on a model: the earliest/latest, an hour, an ordinal, a day, a
 * part of the day, and any of those narrowed to today or tomorrow. Anything
 * this cannot resolve *uniquely* returns undefined and is left to the model;
 * guessing wrong here books a meeting nobody chose.
 */

const DAY_WORDS: Record<string, number> = {
  ראשון: 0,
  שני: 1,
  שלישי: 2,
  רביעי: 3,
  חמישי: 4,
  שישי: 5,
  שבת: 6,
};

/** "השני", "השלישי" … — a position in the list, not a weekday. */
const ORDINALS: Record<string, number> = {
  הראשון: 1,
  הראשונה: 1,
  השני: 2,
  השנייה: 2,
  השניה: 2,
  השלישי: 3,
  השלישית: 3,
  הרביעי: 4,
  הרביעית: 4,
  החמישי: 5,
  החמישית: 5,
  השישי: 6,
  השישית: 6,
};

/** Local "HH:MM" of a slot, the same text the person sees. */
function localTime(slot: Slot, timeZone: string): string {
  return formatSlot(slot, timeZone).slice(-5);
}

function weekday(slot: Slot, timeZone: string): number {
  return localParts(slot.start, timeZone).weekday;
}

/** Minutes past local midnight. */
function minutesOfDay(slot: Slot, timeZone: string): number {
  return localParts(slot.start, timeZone).minutesOfDay;
}

/** Strips punctuation and emoji, keeps letters, digits, ':' and spaces. */
function words(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}:\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function resolveSlotChoice(
  text: string,
  slots: readonly Slot[],
  timeZone: string,
  now: Date = new Date(),
): Slot | undefined {
  if (slots.length === 0) return undefined;
  // A question ("יש משהו ב-19:00?") or a no ("לא, 19:00 לא מתאים") is never a
  // choice, however many times it names. Those go to the model.
  if (text.includes('?') || /(^|\s)(לא|אין|בלי|לא מתאים)(\s|$)/.test(text))
    return undefined;
  const t = ` ${words(text)} `;
  const ordered = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());

  // A position in the list ("השני", "אופציה 2", a bare "2") is absolute: it
  // refers to the rows as shown, before any day narrowing.
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (t.includes(` ${word} `)) return ordered[index - 1];
  }
  const numbered = /^ (?:(?:אופציה|מספר|option|number) )?(\d{1,2}) $/.exec(t);
  if (numbered) return ordered[Number(numbered[1]) - 1];

  // Narrow by day: today, tomorrow, a weekday ("ביום רביעי", "ברביעי",
  // "רביעי"). "שני"/"שלישי" alone are weekdays here — the ordinals were
  // handled above by their definite article.
  let candidates = ordered;
  const todayKey = localDate(now, timeZone);
  const tomorrowKey = localDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  const wantsToday = t.includes(' היום ');
  const wantsTomorrow = t.includes(' מחר ');
  if (wantsToday && !wantsTomorrow) {
    candidates = candidates.filter((s) => localDate(s.start, timeZone) === todayKey);
  } else if (wantsTomorrow && !wantsToday) {
    candidates = candidates.filter((s) => localDate(s.start, timeZone) === tomorrowKey);
  } else {
    // A bare day name counts only in a two-word message ("רביעי 19:00",
    // "חמישי בבוקר"): in a sentence, "ראשון" is as likely "first" as Sunday.
    const short = t.trim().split(' ').length <= 2;
    const named = Object.entries(DAY_WORDS).filter(
      ([day]) =>
        t.includes(` יום ${day} `) ||
        t.includes(` ב${day} `) ||
        (short && t.includes(` ${day} `)),
    );
    if (named.length === 1) {
      const day = named[0]![1];
      candidates = candidates.filter((s) => weekday(s, timeZone) === day);
    } else if (named.length > 1) {
      return undefined;
    }
  }
  // Part of the day, on top of any day narrowing.
  if (t.includes(' בוקר ') || t.includes(' בבוקר ')) {
    candidates = candidates.filter((s) => minutesOfDay(s, timeZone) < 12 * 60);
  } else if (t.includes(' צהריים ') || t.includes(' בצהריים ')) {
    candidates = candidates.filter((s) => {
      const m = minutesOfDay(s, timeZone);
      return m >= 12 * 60 && m < 16 * 60;
    });
  } else if (t.includes(' ערב ') || t.includes(' בערב ') || t.includes(' אחה"צ ')) {
    candidates = candidates.filter((s) => minutesOfDay(s, timeZone) >= 16 * 60);
  }
  if (candidates.length === 0) return undefined;

  // An hour: "19:00", "ב-19:00", "בשעה 19", "ב-19".
  const clock = /(?:^| )(?:ב-?|בשעה )?(\d{1,2}):(\d{2})(?= |$)/.exec(t);
  const hourOnly = /(?:^| )(?:ב-|בשעה )(\d{1,2})(?= |$)/.exec(t);
  const wanted = clock
    ? `${clock[1]!.padStart(2, '0')}:${clock[2]}`
    : hourOnly
      ? `${hourOnly[1]!.padStart(2, '0')}:00`
      : undefined;
  if (wanted) {
    const at = candidates.filter((s) => localTime(s, timeZone) === wanted);
    return at.length === 1 ? at[0] : undefined;
  }

  // The earliest / the latest of what is left.
  if (
    / (הכי מוקדם|המוקדם ביותר|המוקדם|מוקדם|הכי קרוב|הקרוב ביותר|earliest|first) /.test(t)
  ) {
    return candidates[0];
  }
  if (/ (הכי מאוחר|המאוחר ביותר|המאוחר|האחרון|latest|last) /.test(t)) {
    return candidates[candidates.length - 1];
  }

  // A day (or a part of a day) that leaves exactly one time is a choice.
  const narrowed = candidates.length < ordered.length;
  return narrowed && candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The one offered time the bot's own last message talked about, if exactly
 * one — so a "כן" to "…19:00 היום, רוצה שאשריין?" books 19:00 rather than
 * being answered with the same question again. Two times mentioned, or none,
 * is undefined: a yes to that is not a choice.
 */
export function slotMentionedIn(
  botText: string,
  slots: readonly Slot[],
  timeZone: string,
  now: Date = new Date(),
): Slot | undefined {
  const t = ` ${words(botText)} `;
  const times = [...t.matchAll(/(?:^| )(?:ב-?|בשעה )?(\d{1,2}):(\d{2})(?= |$)/g)].map(
    (m) => `${m[1]!.padStart(2, '0')}:${m[2]}`,
  );
  const distinct = [...new Set(times)];
  if (distinct.length !== 1) return undefined;
  const at = slots.filter((s) => localTime(s, timeZone) === distinct[0]);
  if (at.length === 1) return at[0];
  if (at.length === 0) return undefined;
  // The same hour on several days: the message's own day words decide. The
  // bot's text is a question by nature, so the question guard is lifted.
  return resolveSlotChoice(botText.replace(/\?/g, ''), at, timeZone, now);
}

/**
 * A short acceptance of what was just proposed — "כן", "אישרתי כבר!!",
 * "סגור", "מתאים לי". Only for messages that are nothing but that: a sentence
 * that merely contains a yes is not an acceptance.
 */
export function acceptsProposedTime(text: string): boolean {
  if (text.includes('?')) return false;
  const t = words(text);
  if (t.length === 0 || t.split(' ').length > 5) return false;
  return /^(כן|אישרתי|אישור|מאשר|מאשרת|סגור|סגרנו|מתאים|בסדר|יאללה|בטח|מעולה|אוקיי|אוקי|טוב|קבע|תקבע|שריין|תשריין|yes|ok|okay|confirm|confirmed)( .*)?$/.test(
    t,
  );
}

/** Whether two offers are the same times. */
export function sameSlots(a: readonly Slot[], b: readonly Slot[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.start.getTime() === b[i]!.start.getTime())
  );
}

/**
 * What the reply-writer needs to know about the standing offer: the times, in
 * the words the person saw, and what today is — so "אין מוקדם יותר היום?" can
 * be answered truthfully from the calendar rather than deflected.
 */
export function offeredTimesContext(
  slots: readonly Slot[],
  timeZone: string,
  now: Date,
): string {
  const listed = slots
    .map(
      (slot, i) =>
        `${i + 1}) ${formatSlot(slot, timeZone)} (${formatDate(slot, timeZone)})`,
    )
    .join('; ');
  return (
    `Today is ${describeToday(now, timeZone)}. ` +
    `Lidor's free times currently offered, earliest first: ${listed}. ` +
    'The first is the earliest time Lidor has free — nothing earlier is available, ' +
    'and no other times may be suggested.'
  );
}

/**
 * The standing offer as the classifier needs it: numbered, in the words the
 * person saw, so a choice made in words ("הכי מוקדם", "13:30") can be resolved
 * to one of these numbers and booked.
 */
export function numberedOfferedTimes(slots: readonly Slot[], timeZone: string): string {
  return slots.map((slot, i) => `${i + 1}) ${formatSlot(slot, timeZone)}`).join('; ');
}

/** Restores slots from what was stored on the offer. */
export function parseStoredSlots(raw: unknown): Slot[] {
  if (!Array.isArray(raw)) return [];
  const slots: Slot[] = [];
  for (const entry of raw as { start?: unknown; end?: unknown }[]) {
    if (typeof entry?.start !== 'string' || typeof entry?.end !== 'string') continue;
    const start = new Date(entry.start);
    const end = new Date(entry.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    slots.push({ start, end });
  }
  return slots;
}
