import {
  hm,
  isWithinHours,
  localDate,
  localParts,
  type OpeningWindow,
} from '../domain/localTime.js';

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
  // Half-hour grid: 08:30 — the opening time Lidor asked for — is otherwise
  // never offered, because on an hourly grid the first candidate is 09:00.
  stepMs: 30 * 60 * 1000,
  horizonMs: 7 * 24 * 60 * 60 * 1000,
  leadTimeMs: 3 * 60 * 60 * 1000,
};

/** How many times an offer lists — two days of morning / midday / evening. */
export const OFFER_SLOT_COUNT = 6;

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

  // Start on the first grid boundary at or after the lead time, so offered
  // times read as "14:00" / "14:30" rather than "13:47" — and never before the
  // lead time (rounding down to the hour and stepping once did, on a half-hour
  // grid).
  const earliest = now.getTime() + options.leadTimeMs;
  const first = Math.ceil(earliest / options.stepMs) * options.stepMs;

  for (let t = first; t < horizonEnd; t += options.stepMs) {
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
 * A day's three parts and the time a person most likely means by each. An
 * offer picks the free slot nearest the anchor in each part, so it reads
 * "09:00 / 13:00 / 18:00" rather than three consecutive half-hours.
 */
const DAY_PARTS: readonly { from: number; to: number; anchor: number }[] = [
  { from: hm(0), to: hm(12), anchor: hm(9) },
  { from: hm(12), to: hm(16), anchor: hm(13) },
  { from: hm(16), to: hm(24), anchor: hm(18) },
];

/**
 * Picks the slots to offer: morning, midday and evening on each of the next
 * free days, until `count` are found.
 *
 * Earlier this took the earliest slot of each day, which meant every offer
 * beyond today read "09:00, 09:00, 09:00" — and someone free only in the
 * evening had nothing to choose. Variety within a day matters as much as
 * variety across days. A day that is busy in one part simply contributes
 * fewer; a week with fewer free slots than wanted is filled from whatever is
 * left, so a busy calendar still produces an offer rather than silence.
 */
export function pickOfferSlots(
  slots: readonly Slot[],
  count: number,
  timeZone: string,
): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const day = localDate(slot.start, timeZone);
    const list = byDay.get(day);
    if (list) list.push(slot);
    else byDay.set(day, [slot]);
  }

  const picked: Slot[] = [];
  for (const daySlots of byDay.values()) {
    for (const part of DAY_PARTS) {
      const inPart = daySlots.filter((slot) => {
        const minutes = localParts(slot.start, timeZone).minutesOfDay;
        return minutes >= part.from && minutes < part.to;
      });
      const nearest = inPart.reduce<Slot | undefined>((best, slot) => {
        const distance = Math.abs(
          localParts(slot.start, timeZone).minutesOfDay - part.anchor,
        );
        const bestDistance = best
          ? Math.abs(localParts(best.start, timeZone).minutesOfDay - part.anchor)
          : Infinity;
        return distance < bestDistance ? slot : best;
      }, undefined);
      if (nearest) picked.push(nearest);
      if (picked.length === count) return picked;
    }
  }

  // Fewer free parts than slots wanted — fill from whatever is free.
  for (const slot of slots) {
    if (picked.length === count) break;
    if (!picked.includes(slot)) picked.push(slot);
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}
