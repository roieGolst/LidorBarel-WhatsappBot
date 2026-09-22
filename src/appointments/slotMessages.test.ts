import { describe, expect, it } from 'vitest';
import {
  alreadyBookedMessage,
  bookingConfirmation,
  formatSlot,
  isSlotLabel,
  matchSlot,
  offeredTimesContext,
  parseStoredSlots,
  sameSlots,
  slotListRows,
  numberedOfferedTimes,
} from './slotMessages.js';
import { findBannedTerms } from '../workflow/validate.js';
import {
  NO_SLOTS_MESSAGE,
  SLOT_OFFER_BODY,
  SLOT_REOFFER_BODY,
  SLOT_SUGGEST_BODY,
  SLOT_TAKEN_MESSAGE,
  SLOTS_DECLINED_MESSAGE,
  STALE_SLOT_MESSAGE,
} from './slotMessages.js';

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

describe('isSlotLabel', () => {
  it('recognises the text a tapped time row echoes back', () => {
    expect(isSlotLabel('יום ראשון 10:00')).toBe(true);
    expect(isSlotLabel(formatSlot(MONDAY_14, TZ))).toBe(true);
    expect(isSlotLabel(' יום חמישי 09:00 ')).toBe(true);
  });

  it('does not mistake a sentence about a day for a tap', () => {
    expect(isSlotLabel('יום ראשון לא מתאים לי')).toBe(false);
    expect(isSlotLabel('אין מוקדם יותר היום?')).toBe(false);
    expect(isSlotLabel('10:00')).toBe(false);
  });
});

describe('sameSlots', () => {
  it('compares the times offered, in order', () => {
    expect(sameSlots([SUNDAY_10, MONDAY_14], [SUNDAY_10, MONDAY_14])).toBe(true);
    expect(sameSlots([SUNDAY_10, MONDAY_14], [MONDAY_14, SUNDAY_10])).toBe(false);
    expect(sameSlots([SUNDAY_10], [SUNDAY_10, MONDAY_14])).toBe(false);
  });
});

describe('offeredTimesContext', () => {
  it('tells the reply-writer the times in the words the person saw, and the date', () => {
    const context = offeredTimesContext(
      [SUNDAY_10, MONDAY_14],
      TZ,
      new Date('2026-08-22T10:00:00Z'), // Saturday
    );
    expect(context).toContain('Today is יום שבת, 2026-08-22');
    expect(context).toContain('1) יום ראשון 10:00 (23 באוגוסט)');
    expect(context).toContain('2) יום שני 14:00 (24 באוגוסט)');
    expect(context).toContain('nothing earlier is available');
  });
});

describe('the booking-stage lines', () => {
  it.each([
    ['re-offer', SLOT_REOFFER_BODY],
    ['suggestion', SLOT_SUGGEST_BODY],
    ['stale slot', STALE_SLOT_MESSAGE],
    ['declined', SLOTS_DECLINED_MESSAGE],
    ['already booked', alreadyBookedMessage(SUNDAY_10, TZ)],
    ['already booked, time unknown', alreadyBookedMessage(undefined, TZ)],
  ])('%s passes the voice rules', (_name, text) => {
    expect(findBannedTerms(text)).toEqual([]);
    expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('names the booked time back', () => {
    expect(alreadyBookedMessage(SUNDAY_10, TZ)).toContain('יום ראשון 10:00');
  });
});

describe('numberedOfferedTimes', () => {
  it('numbers the offer in the exact words the person saw', () => {
    const slots = [
      { start: new Date('2026-09-22T10:30:00Z'), end: new Date('2026-09-22T11:15:00Z') },
      { start: new Date('2026-09-22T14:00:00Z'), end: new Date('2026-09-22T14:45:00Z') },
    ];
    expect(numberedOfferedTimes(slots, TZ)).toBe(
      '1) יום שלישי 13:30; 2) יום שלישי 17:00',
    );
  });
});
