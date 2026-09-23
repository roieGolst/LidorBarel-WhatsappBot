import type { Contact } from '../db/repositories/contacts.js';
import type { KnownFacts } from '../workflow/decide.js';
import type { Slot } from './availability.js';
import { formatDate, formatSlot } from './slotMessages.js';

/**
 * What the activity item says about the person it is for.
 *
 * The item's name is what Monday's calendar integration uses as the event title
 * — the one line Lidor sees in his calendar. "פגישת ייעוץ" alone (the original
 * name) told him nothing; this mirrors the "פגישת ייעוץ עם <name>" that Monday's
 * own Emails & Activities automation produces, so bot-made and hand-made
 * entries read alike. The rest goes into the item's update (`meetingNote`).
 */

/** The activity item's name — and so the calendar event's title. */
export function activityItemName(kind: string, contact: Pick<Contact, 'name'>): string {
  const name = contact.name?.trim();
  return name ? `${kind} עם ${name}` : kind;
}

// For Lidor, not the customer, so a CRM register rather than the bot's voice.
const SELL_INTENT: Record<string, string> = {
  ready: 'מוכן למכור',
  not_sure: 'מתלבט, רוצה הערכת מחיר',
  not_selling: 'לא מעוניין למכור',
};
const TIMELINE: Record<string, string> = {
  immediate: 'מיידי',
  within_month: 'בחודש הקרוב',
  still_checking: 'בחודשים הקרובים',
  no_urgency: 'אין דחיפות',
};
const MARKETED: Record<string, string> = {
  no: 'לא משווק',
  privately: 'משווק באופן פרטי',
  with_agent: 'משווק דרך מתווך אחר',
};

export interface ActivityNoteInput {
  contact: Pick<Contact, 'name' | 'phone'>;
  facts: KnownFacts;
  /** The lead's priority score as last projected, if scored. */
  priorityScore: number | null;
}

/**
 * The body of `תיאור חופשי` on an activity item: who, how to reach them, what
 * they answered, what they said about the property — everything the bot knows
 * that Lidor would otherwise open the lead to find. The column is mapped into
 * the calendar event's description, so this is what he reads before the call.
 * A `text` column holds one line, hence " | " rather than line breaks.
 * Deterministic — assembled from the stored answers, no model call.
 */
export function activityNote(headline: string, input: ActivityNoteInput): string {
  const { contact, facts } = input;
  const parts: string[] = [
    headline,
    `${contact.name?.trim() ? `${contact.name.trim()} · ` : ''}${contact.phone}`,
  ];

  const answers = [
    facts.neighborhood ? `שכונה: ${facts.neighborhood}` : undefined,
    facts.sellIntent
      ? `מוכנות: ${SELL_INTENT[facts.sellIntent] ?? facts.sellIntent}`
      : undefined,
    facts.timeline ? `מועד: ${TIMELINE[facts.timeline] ?? facts.timeline}` : undefined,
    facts.currentlyMarketed
      ? `שיווק: ${MARKETED[facts.currentlyMarketed] ?? facts.currentlyMarketed}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  if (answers.length > 0) parts.push(answers.join(' · '));

  if (input.priorityScore !== null) parts.push(`ציון רצינות: ${input.priorityScore}`);
  if (facts.additionalNotes) parts.push(`פרטי הנכס: ${facts.additionalNotes}`);
  if (facts.bookingIntent) parts.push('ביקש/ה פגישה ביוזמתו/ה');

  return parts.join(' | ');
}

export interface MeetingNoteInput extends ActivityNoteInput {
  slot: Slot;
  timeZone: string;
  /** True when an existing consultation was moved to this time. */
  rescheduled: boolean;
}

/** The note on a booked (or moved) consultation. */
export function meetingNote(input: MeetingNoteInput): string {
  const when = `${formatSlot(input.slot, input.timeZone)} (${formatDate(input.slot, input.timeZone)})`;
  return activityNote(
    input.rescheduled
      ? `הפגישה הועברה דרך הבוט ל${when}`
      : `פגישת ייעוץ נקבעה דרך הבוט ל${when}`,
    input,
  );
}

/** The note on the exclusivity-callback reminder. */
export function callbackNote(
  input: ActivityNoteInput & { exclusivityEndsOn: string },
): string {
  return activityNote(
    `תזכורת מהבוט: הבלעדיות אצל המתווך הנוכחי מסתיימת ב-${input.exclusivityEndsOn} — לחזור ללקוח`,
    input,
  );
}
