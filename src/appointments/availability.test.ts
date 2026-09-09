import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SLOT_OPTIONS,
  availableSlots,
  isWithinMeetingHours,
  overlaps,
  spreadAcrossDays,
  type BusyBlock,
  type SlotOptions,
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

  it('offers whole-hour start times', () => {
    for (const slot of availableSlots([], OPTIONS, NOW).slice(0, 5)) {
      expect(slot.start.getUTCMinutes()).toBe(0);
    }
  });
});

describe('spreadAcrossDays', () => {
  it('picks one slot per day so a bad day does not stall the offer', () => {
    const slots = availableSlots([], OPTIONS, NOW);

    const picked = spreadAcrossDays(slots, 3, TZ);

    const days = picked.map((s) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(
        s.start,
      ),
    );
    expect(new Set(days).size).toBe(3);
  });

  it('returns the earliest slot of each day', () => {
    const slots = availableSlots([], OPTIONS, NOW);

    const picked = spreadAcrossDays(slots, 3, TZ);

    expect(picked[0]).toEqual(slots[0]);
  });

  it('falls back to same-day slots when free days run out', () => {
    // A busy week should still produce an offer rather than silence.
    const oneDayOnly: SlotOptions = { ...OPTIONS, horizonMs: 8 * 60 * 60 * 1000 };
    const slots = availableSlots([], oneDayOnly, NOW);

    const picked = spreadAcrossDays(slots, 3, TZ);

    expect(picked.length).toBeGreaterThan(1);
  });

  it('returns nothing when there is nothing free', () => {
    expect(spreadAcrossDays([], 3, TZ)).toEqual([]);
  });
});
