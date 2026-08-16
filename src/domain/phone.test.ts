import { describe, expect, it } from 'vitest';
import {
  formatPhoneForDisplay,
  InvalidPhoneNumberError,
  isE164,
  normalizePhone,
  tryNormalizePhone,
  type E164,
} from './phone.js';

/**
 * Lidor's own number, which appears in the specification, used as the running
 * example so the expected E.164 form is easy to verify by eye.
 */
const CANONICAL = '+972533374203';

describe('normalizePhone', () => {
  // The core property: every way this number can arrive must collapse to one
  // string. If any of these disagree we create duplicate contacts and can miss
  // an opt-out recorded against a different spelling.
  it.each([
    ['local, no separators', '0533374203'],
    ['local, hyphenated', '053-337-4203'],
    ['local, spaced', '053 337 4203'],
    ['local, mixed separators', '053-337 4203'],
    ['international with plus', '+972533374203'],
    ['international, spaced', '+972 53 337 4203'],
    ['international, hyphenated', '+972-53-337-4203'],
    ['international without plus (WhatsApp webhook form)', '972533374203'],
    ['00 international prefix', '00972533374203'],
    ['leading and trailing whitespace', '  0533374203  '],
    ['parenthesised area code', '(053) 337-4203'],
  ])('normalizes %s to the same E.164 value', (_label, input) => {
    expect(normalizePhone(input)).toBe(CANONICAL);
  });

  // Numbers pasted from Hebrew forms and spreadsheets routinely carry RTL marks
  // and zero-width characters. They are invisible, so a mismatch caused by one
  // is close to impossible to diagnose from the data.
  it.each([
    ['left-to-right mark', '‎0533374203'],
    ['right-to-left mark', '‏0533374203'],
    ['zero-width space', '05​33374203'],
    ['non-breaking space', '053 337 4203'],
    ['RTL embedding marks', '‫0533374203‬'],
  ])('strips %s', (_label, input) => {
    expect(normalizePhone(input)).toBe(CANONICAL);
  });

  it('is idempotent', () => {
    const once = normalizePhone('053-337-4203');
    expect(normalizePhone(once)).toBe(once);
  });

  it('handles other Israeli mobile prefixes', () => {
    expect(normalizePhone('0501234567')).toBe('+972501234567');
    expect(normalizePhone('0521234567')).toBe('+972521234567');
    expect(normalizePhone('0581234567')).toBe('+972581234567');
  });

  it('handles Beer Sheva landlines', () => {
    expect(normalizePhone('086412345')).toBe('+97286412345');
  });

  it('accepts a valid non-Israeli number in international form', () => {
    expect(normalizePhone('+14155552671')).toBe('+14155552671');
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['letters', 'not a phone'],
    ['too short', '053'],
    ['too long', '05333742039999999'],
    ['invalid Israeli prefix', '0993374203'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizePhone(input)).toThrow(InvalidPhoneNumberError);
  });

  // Phone numbers are personal data. An exception that embeds one ends up in
  // logs and error trackers, where it should not be.
  it('never includes the offending number in the error message', () => {
    let error: unknown;
    try {
      normalizePhone('0993374203');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InvalidPhoneNumberError);
    expect((error as Error).message).not.toContain('0993374203');
  });
});

describe('tryNormalizePhone', () => {
  it('returns the normalized number for valid input', () => {
    expect(tryNormalizePhone('053-337-4203')).toBe(CANONICAL);
  });

  it.each([
    ['invalid input', 'garbage'],
    ['null', null],
    ['undefined', undefined],
  ])('returns undefined for %s', (_label, input) => {
    expect(tryNormalizePhone(input)).toBeUndefined();
  });
});

describe('isE164', () => {
  it('accepts well-formed E.164', () => {
    expect(isE164(CANONICAL)).toBe(true);
  });

  it.each([
    ['missing plus', '972533374203'],
    ['local format', '0533374203'],
    ['leading zero after plus', '+0972533374203'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(isE164(input)).toBe(false);
  });
});

describe('formatPhoneForDisplay', () => {
  it('renders Israeli numbers in national form', () => {
    expect(formatPhoneForDisplay(CANONICAL as E164)).toBe('053-337-4203');
  });

  it('renders non-Israeli numbers in international form', () => {
    expect(formatPhoneForDisplay('+14155552671' as E164)).toBe('+1 415 555 2671');
  });

  it('returns the input unchanged rather than throwing on unparseable values', () => {
    expect(formatPhoneForDisplay('garbage' as E164)).toBe('garbage');
  });
});
