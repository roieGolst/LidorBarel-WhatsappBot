import { describe, expect, it } from 'vitest';
import { atLocalTime, describeToday, hm, localDate } from './localTime.js';

const TZ = 'Asia/Jerusalem';

describe('atLocalTime', () => {
  it('resolves a wall-clock time on a date in the zone', () => {
    // Israel summer time is UTC+3.
    expect(atLocalTime('2026-09-09', hm(10), TZ).toISOString()).toBe(
      '2026-09-09T07:00:00.000Z',
    );
    // Winter is UTC+2.
    expect(atLocalTime('2026-12-09', hm(10), TZ).toISOString()).toBe(
      '2026-12-09T08:00:00.000Z',
    );
  });

  it('holds the wall-clock time across the DST switch', () => {
    // Israel moves clocks back on 2026-10-25 at 02:00.
    expect(atLocalTime('2026-10-25', hm(10), TZ).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
    expect(atLocalTime('2026-10-24', hm(10), TZ).toISOString()).toBe(
      '2026-10-24T07:00:00.000Z',
    );
  });
});

describe('localDate / describeToday', () => {
  it('reads the local calendar date, not the UTC one', () => {
    // 22:30Z on the 8th is already the 9th in Israel.
    const at = new Date('2026-09-08T22:30:00Z');
    expect(localDate(at, TZ)).toBe('2026-09-09');
    expect(describeToday(at, TZ)).toBe('יום רביעי, 2026-09-09');
  });
});
