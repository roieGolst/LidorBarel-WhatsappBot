import { describeToday } from '../domain/localTime.js';
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
function formatDate(slot: Slot, timeZone: string): string {
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
