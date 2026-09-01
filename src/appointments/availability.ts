import { hm, isWithinHours, type OpeningWindow } from '../domain/localTime.js';

/**
 * Finding times Lidor is actually free.
 *
 * Availability is read from the **פעילות board**, not from Google. Monday keeps
 * that board bidirectionally synced with his calendar, so it already mirrors
 * every relevant commitment — and reading it costs no Google credentials, no
 * OAuth, and no second integration to keep alive. See `docs/MONDAY-MAPPING.md`.
 *
 * The one risk that arrangement carries is sync lag: an event created in Google
 * seconds ago may not be on the board yet. Slots are therefore re-checked
 * immediately before booking (`booking.ts`) rather than trusted from when they
 * were offered.
 */

/**
 * When Lidor will take a consultation call — his stated default availability.
 *
 * Deliberately **not** the messaging hours in `outreach/followUpPolicy.ts`.
 * Sending a follow-up at 08:00 is fine; putting a client in his diary at 08:00
 * is not, and he asked for 08:30. Two rules for two different questions.
 *
 * Friday still closes early. He gave 08:30–20:00 as the general window, but a
 * 20:00 finish on a Friday runs into Shabbat, so Friday keeps the spec's early
 * close and Saturday is never offered.
 */
const MEETING_HOURS: Record<number, OpeningWindow | null> = {
  0: { open: hm(8, 30), close: hm(20) }, // Sunday
  1: { open: hm(8, 30), close: hm(20) },
  2: { open: hm(8, 30), close: hm(20) },
  3: { open: hm(8, 30), close: hm(20) },
  4: { open: hm(8, 30), close: hm(20) }, // Thursday
  5: { open: hm(8, 30), close: hm(14) }, // Friday
  6: null, // Saturday — Shabbat. Never.
};

/** Whether a consultation may take place at this instant. */
export function isWithinMeetingHours(at: Date, timeZone: string): boolean {
  return isWithinHours(at, timeZone, MEETING_HOURS);
}

export interface Slot {
  start: Date;
  end: Date;
}

/** A commitment already in Lidor's calendar. */
export interface BusyBlock {
  start: Date;
  end: Date;
}

export interface SlotOptions {
  /** How long a consultation runs. */
  durationMs: number;
  /** Gap between candidate start times. */
  stepMs: number;
  /** How far ahead to look. */
  horizonMs: number;
  /**
   * How soon the earliest slot may be.
   *
   * Offering a meeting in ten minutes reads as desperate and is unlikely to be
   * kept; it also leaves no room for the lead to reply before it starts.
   */
  leadTimeMs: number;
  timeZone: string;
}

export const DEFAULT_SLOT_OPTIONS: Omit<SlotOptions, 'timeZone'> = {
  durationMs: 45 * 60 * 1000,
  stepMs: 60 * 60 * 1000,
  horizonMs: 7 * 24 * 60 * 60 * 1000,
  leadTimeMs: 3 * 60 * 60 * 1000,
};

/** Whether two intervals overlap at all. */
export function overlaps(a: Slot, b: BusyBlock): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Candidate slots that sit wholly inside business hours and clash with nothing.
 *
 * Both ends are checked against meeting hours, not just the start: a 19:30 slot
 * on a Thursday would otherwise be offered and run past closing.
 */
export function availableSlots(
  busy: readonly BusyBlock[],
  options: SlotOptions,
  now: Date = new Date(),
): Slot[] {
  const slots: Slot[] = [];
  const horizonEnd = now.getTime() + options.horizonMs;

  // Start from the next whole hour after the lead time, so offered times read as
  // "14:00" rather than "13:47".
  const first = new Date(now.getTime() + options.leadTimeMs);
  first.setMinutes(0, 0, 0);
  first.setTime(first.getTime() + options.stepMs);

  for (let t = first.getTime(); t < horizonEnd; t += options.stepMs) {
    const start = new Date(t);
    const end = new Date(t + options.durationMs);

    if (!isWithinMeetingHours(start, options.timeZone)) continue;
    // The closing check uses the last minute the meeting occupies; the end
    // instant itself may legitimately fall on the boundary. Without this a 19:30
    // start would be offered and run past the 20:00 close.
    if (!isWithinMeetingHours(new Date(end.getTime() - 60_000), options.timeZone)) {
      continue;
    }

    const slot = { start, end };
    if (busy.some((block) => overlaps(slot, block))) continue;

    slots.push(slot);
  }

  return slots;
}

/**
 * Picks the slots to offer, spread across different days.
 *
 * Three consecutive hours on one afternoon is a worse offer than three
 * mornings across three days: if that afternoon does not suit, the lead has
 * nothing to choose and the conversation stalls. One per day, earliest first.
 */
export function spreadAcrossDays(
  slots: readonly Slot[],
  count: number,
  timeZone: string,
): Slot[] {
  const seen = new Set<string>();
  const picked: Slot[] = [];

  for (const slot of slots) {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(slot.start);

    if (seen.has(day)) continue;
    seen.add(day);
    picked.push(slot);
    if (picked.length === count) break;
  }

  // Fewer free days than slots wanted — fall back to filling from whatever is
  // free, so a busy week still produces an offer rather than silence.
  if (picked.length < count) {
    for (const slot of slots) {
      if (picked.includes(slot)) continue;
      picked.push(slot);
      if (picked.length === count) break;
    }
  }

  return picked;
}
