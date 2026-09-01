import { describe, expect, it } from 'vitest';
import {
  bookingConfirmation,
  formatSlot,
  matchSlot,
  parseStoredSlots,
  slotListRows,
} from './slotMessages.js';
import { findBannedTerms } from '../workflow/validate.js';
import { NO_SLOTS_MESSAGE, SLOT_OFFER_BODY, SLOT_TAKEN_MESSAGE } from './slotMessages.js';

const TZ = 'Asia/Jerusalem';
const slot = (startIso: string, endIso: string) => ({
  start: new Date(startIso),
  end: new Date(endIso),
});

// Sunday 2026-08-23, 07:00Z = 10:00 Jerusalem.
const SUNDAY_10 = slot('2026-08-23T07:00:00Z', '2026-08-23T07:45:00Z');
const MONDAY_14 = slot('2026-08-24T11:00:00Z', '2026-08-24T11:45:00Z');

describe('formatSlot', () => {
  it('names the day in Hebrew and the local time', () => {
    expect(formatSlot(SUNDAY_10, TZ)).toBe('יום ראשון 10:00');
    expect(formatSlot(MONDAY_14, TZ)).toBe('יום שני 14:00');
  });

  it('renders in Israel time, not the server timezone', () => {
    // 07:00Z is 10:00 in Jerusalem; a server reading UTC would say 07:00.
    expect(formatSlot(SUNDAY_10, TZ)).toContain('10:00');
  });
});

describe('slotListRows', () => {
  it("stays within WhatsApp's 24-character title limit", () => {
    for (const row of slotListRows([SUNDAY_10, MONDAY_14], TZ)) {
      expect(row.title.length).toBeLessThanOrEqual(24);
    }
  });

  it('distinguishes the same weekday in different weeks by date', () => {
    const nextSunday = slot('2026-08-30T07:00:00Z', '2026-08-30T07:45:00Z');

    const rows = slotListRows([SUNDAY_10, nextSunday], TZ);

    expect(rows[0]?.title).toBe(rows[1]?.title);
    expect(rows[0]?.description).not.toBe(rows[1]?.description);
  });
});

describe('matchSlot', () => {
  it('resolves a tapped row back to its slot', () => {
    // A tapped row returns its title text, so the label is the identifier.
    const tapped = formatSlot(MONDAY_14, TZ);

    expect(matchSlot(tapped, [SUNDAY_10, MONDAY_14], TZ)).toBe(MONDAY_14);
  });

  it('resolves the same text typed by hand', () => {
    expect(matchSlot('  יום ראשון 10:00 ', [SUNDAY_10, MONDAY_14], TZ)).toBe(SUNDAY_10);
  });

  it('does not guess at anything else', () => {
    // Booking a different time from the one they meant is worse than asking again.
    expect(matchSlot('מתי שנוח לך', [SUNDAY_10, MONDAY_14], TZ)).toBeUndefined();
    expect(matchSlot('יום ראשון', [SUNDAY_10], TZ)).toBeUndefined();
  });
});

describe('parseStoredSlots', () => {
  it('round-trips what recordOffer stores', () => {
    const stored = [
      { start: SUNDAY_10.start.toISOString(), end: SUNDAY_10.end.toISOString() },
    ];

    expect(parseStoredSlots(stored)).toEqual([SUNDAY_10]);
  });

  it('survives a malformed or empty record', () => {
    expect(parseStoredSlots(null)).toEqual([]);
    expect(parseStoredSlots([{ start: 'nonsense', end: 'nonsense' }])).toEqual([]);
    expect(parseStoredSlots([{ start: 1 }])).toEqual([]);
  });
});

describe('wording', () => {
  it.each([SLOT_OFFER_BODY, NO_SLOTS_MESSAGE, SLOT_TAKEN_MESSAGE])(
    'uses no banned term: %s',
    (message) => {
      expect(findBannedTerms(message)).toEqual([]);
    },
  );

  it('confirms with the day, time and date', () => {
    const confirmation = bookingConfirmation(SUNDAY_10, TZ);

    expect(confirmation).toContain('יום ראשון 10:00');
    expect(findBannedTerms(confirmation)).toEqual([]);
  });
});
