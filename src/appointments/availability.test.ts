import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SLOT_OPTIONS,
  availableSlots,
  isWithinMeetingHours,
  OFFER_SLOT_COUNT,
  overlaps,
  pickOfferSlots,
  type BusyBlock,
  type SlotOptions,
  pickEarliestSlots,
  EARLIEST_PER_DAY,
} from './availability.js';

const TZ = 'Asia/Jerusalem';
const OPTIONS: SlotOptions = { ...DEFAULT_SLOT_OPTIONS, timeZone: TZ };

/** Sunday 2026-08-23, 06:00 UTC = 09:00 Jerusalem. */
const NOW = new Date('2026-08-23T06:00:00Z');

const at = (iso: string): Date => new Date(iso);
const block = (start: string, end: string): BusyBlock => ({
  start: at(start),
  end: at(end),
});

describe('overlaps', () => {
  it('detects a clash', () => {
    expect(
      overlaps(
        { start: at('2026-08-24T09:00:00Z'), end: at('2026-08-24T09:45:00Z') },
        block('2026-08-24T09:30:00Z', '2026-08-24T10:30:00Z'),
      ),
    ).toBe(true);
  });

  it('allows a meeting that starts exactly when another ends', () => {
    expect(
      overlaps(
        { start: at('2026-08-24T10:00:00Z'), end: at('2026-08-24T10:45:00Z') },
        block('2026-08-24T09:00:00Z', '2026-08-24T10:00:00Z'),
      ),
    ).toBe(false);
  });
});

describe('availableSlots', () => {
  it('offers slots when the calendar is empty', () => {
    expect(availableSlots([], OPTIONS, NOW).length).toBeGreaterThan(0);
  });

  it('keeps every slot inside meeting hours', () => {
    for (const slot of availableSlots([], OPTIONS, NOW)) {
      expect(isWithinMeetingHours(slot.start, TZ)).toBe(true);
    }
  });

  it("never offers a meeting before 08:30, Lidor's stated start", () => {
    // Messaging may begin at 08:00; a consultation may not.
    for (const slot of availableSlots([], OPTIONS, NOW)) {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(slot.start);
      expect(local >= '08:30').toBe(true);
    }
  });

  it('never offers a meeting that would run past closing', () => {
    // Both ends are checked: a 19:30 start would otherwise be offered and run
    // past the 20:00 close.
    for (const slot of availableSlots([], OPTIONS, NOW)) {
      const lastMinute = new Date(slot.end.getTime() - 60_000);
      expect(isWithinMeetingHours(lastMinute, TZ)).toBe(true);
    }
  });

  it('never offers a slot on Shabbat', () => {
    const saturdays = availableSlots([], OPTIONS, NOW).filter((slot) => {
      const day = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        weekday: 'short',
      }).format(slot.start);
      return day === 'Sat';
    });

    expect(saturdays).toEqual([]);
  });

  it('respects the lead time, so nothing is offered imminently', () => {
    const earliest = availableSlots([], OPTIONS, NOW)[0]!;

    expect(earliest.start.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + OPTIONS.leadTimeMs,
    );
  });

  it('excludes a slot that clashes with an existing commitment', () => {
    const free = availableSlots([], OPTIONS, NOW);
    const target = free[0]!;

    const withBusy = availableSlots(
      [{ start: target.start, end: target.end }],
      OPTIONS,
      NOW,
    );

    expect(withBusy.some((s) => s.start.getTime() === target.start.getTime())).toBe(
      false,
    );
  });

  it('excludes a slot merely overlapped by a longer commitment', () => {
    const free = availableSlots([], OPTIONS, NOW);
    const target = free[0]!;
    const overlapping = {
      start: new Date(target.start.getTime() - 30 * 60 * 1000),
      end: new Date(target.start.getTime() + 15 * 60 * 1000),
    };

    const withBusy = availableSlots([overlapping], OPTIONS, NOW);

    expect(withBusy.some((s) => s.start.getTime() === target.start.getTime())).toBe(
      false,
    );
  });

  it('returns nothing when the whole horizon is booked', () => {
    const wall = [{ start: NOW, end: new Date(NOW.getTime() + OPTIONS.horizonMs) }];

    expect(availableSlots(wall, OPTIONS, NOW)).toEqual([]);
  });

  it('offers start times on the half-hour grid', () => {
    for (const slot of availableSlots([], OPTIONS, NOW).slice(0, 5)) {
      expect([0, 30]).toContain(slot.start.getUTCMinutes());
    }
  });
});

const localTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
const localDay = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(d);

describe('the candidate grid', () => {
  it('starts on the first half-hour at or after the lead time, never before it', () => {
    // 09:00 local + 3 h lead = 12:00 → 12:00 is the first candidate.
    const slots = availableSlots([], OPTIONS, NOW);
    expect(localTime(slots[0]!.start)).toBe('12:00');
    // 09:20 + 3 h = 12:20 → 12:30, not 12:00 (the old round-down-then-step).
    const later = availableSlots([], OPTIONS, new Date('2026-08-23T06:20:00Z'));
    expect(localTime(later[0]!.start)).toBe('12:30');
  });

  it('offers the 08:30 opening Lidor asked for', () => {
    const slots = availableSlots([], OPTIONS, NOW);
    const tomorrow = slots.filter((s) => localDay(s.start) === '2026-08-24');
    expect(localTime(tomorrow[0]!.start)).toBe('08:30');
  });
});

describe('pickEarliestSlots', () => {
  it('offers the soonest free times, capped per day so the list spans two days', () => {
    // 09:00 local, 3h lead time → the first candidate on the half-hour grid is
    // 12:00. A ready-now lead is shown that, not a 18:00 "evening option".
    const slots = availableSlots([], OPTIONS, NOW);

    const picked = pickEarliestSlots(slots, OFFER_SLOT_COUNT, TZ);

    expect(picked.map((s) => `${localDay(s.start)} ${localTime(s.start)}`)).toEqual([
      '2026-08-23 12:00',
      '2026-08-23 12:30',
      '2026-08-23 13:00',
      '2026-08-24 08:30',
      '2026-08-24 09:00',
      '2026-08-24 09:30',
    ]);
    expect(EARLIEST_PER_DAY).toBe(3);
  });

  it('skips past a taken slot to the next free one', () => {
    const busy = [block('2026-08-23T09:00:00Z', '2026-08-23T10:00:00Z')]; // 12:00–13:00 local
    const slots = availableSlots(busy, OPTIONS, NOW);

    const picked = pickEarliestSlots(slots, 2, TZ);

    expect(picked.map((s) => localTime(s.start))).toEqual(['13:00', '13:30']);
  });

  it('returns what there is when fewer are free than wanted', () => {
    expect(pickEarliestSlots([], OFFER_SLOT_COUNT, TZ)).toEqual([]);
  });
});

describe('pickOfferSlots', () => {
  it('offers morning, midday and evening — not the earliest half-hour three times', () => {
    // The live offer read "09:00 / 09:00 / 19:00": one per day, earliest first,
    // so someone free only in the evening had nothing to pick.
    const slots = availableSlots([], OPTIONS, NOW);

    const picked = pickOfferSlots(slots, OFFER_SLOT_COUNT, TZ);

    expect(picked).toHaveLength(6);
    // Today from 12:00: midday + evening; tomorrow: all three; then the next
    // morning. Anchored on 09:00 / 13:00 / 18:00.
    expect(picked.map((s) => `${localDay(s.start)} ${localTime(s.start)}`)).toEqual([
      '2026-08-23 13:00',
      '2026-08-23 18:00',
      '2026-08-24 09:00',
      '2026-08-24 13:00',
      '2026-08-24 18:00',
      '2026-08-25 09:00',
    ]);
  });

  it('picks the free slot nearest the anchor when the anchor itself is taken', () => {
    const busy = [block('2026-08-24T05:30:00Z', '2026-08-24T07:00:00Z')]; // 08:30–10:00 local
    const slots = availableSlots(busy, OPTIONS, NOW);

    const picked = pickOfferSlots(slots, OFFER_SLOT_COUNT, TZ);
    const tomorrowMorning = picked.find(
      (s) => localDay(s.start) === '2026-08-24' && localTime(s.start) < '12:00',
    );

    expect(localTime(tomorrowMorning!.start)).toBe('10:00');
  });

  it('is in chronological order', () => {
    const picked = pickOfferSlots(availableSlots([], OPTIONS, NOW), OFFER_SLOT_COUNT, TZ);
    const times = picked.map((s) => s.start.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('fills from whatever is free when the week has fewer parts than wanted', () => {
    // A busy week should still produce an offer rather than silence.
    const oneDayOnly: SlotOptions = { ...OPTIONS, horizonMs: 8 * 60 * 60 * 1000 };
    const slots = availableSlots([], oneDayOnly, NOW);

    const picked = pickOfferSlots(slots, OFFER_SLOT_COUNT, TZ);

    expect(picked.length).toBeGreaterThan(2);
    expect(picked.length).toBeLessThanOrEqual(OFFER_SLOT_COUNT);
  });

  it('returns nothing when there is nothing free', () => {
    expect(pickOfferSlots([], OFFER_SLOT_COUNT, TZ)).toEqual([]);
  });
});
