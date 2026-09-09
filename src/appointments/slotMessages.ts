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
