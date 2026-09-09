/**
 * Reading a wall clock in a given timezone.
 *
 * Extracted because two different rules depend on it — when the bot may *send*
 * a message, and when Lidor may *meet* someone — and a timezone bug fixed in one
 * copy but not the other is the kind of defect nobody finds until a message goes
 * out on Shabbat.
 */

/** Local weekday (0 = Sunday) and time of day, in the given timezone. */
export interface LocalParts {
  weekday: number;
  hour: number;
  minute: number;
  /** Minutes since local midnight — the form most opening-hours checks want. */
  minutesOfDay: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(at);

  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '0';

  // `hour12: false` renders midnight as 24 in some environments.
  const rawHour = Number(value('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(value('minute'));

  return {
    weekday: WEEKDAYS[value('weekday')] ?? 0,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

/** An opening window for one weekday, in minutes since local midnight. */
export interface OpeningWindow {
  open: number;
  close: number;
}

/** Whether an instant falls inside the given weekly opening hours. */
export function isWithinHours(
  at: Date,
  timeZone: string,
  hours: Readonly<Record<number, OpeningWindow | null>>,
): boolean {
  const { weekday, minutesOfDay } = localParts(at, timeZone);
  const window = hours[weekday];
  if (!window) return false;
  return minutesOfDay >= window.open && minutesOfDay < window.close;
}

/** Convenience for writing hour tables readably. */
export const hm = (hour: number, minute = 0): number => hour * 60 + minute;

/** The local calendar date (`YYYY-MM-DD`) of an instant in the given timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const HEBREW_WEEKDAYS = [
  'ראשון',
  'שני',
  'שלישי',
  'רביעי',
  'חמישי',
  'שישי',
  'שבת',
] as const;

/** `יום שלישי, 2026-09-08` — today, as a line the classifier can date things from. */
export function describeToday(at: Date, timeZone: string): string {
  const { weekday } = localParts(at, timeZone);
  return `יום ${HEBREW_WEEKDAYS[weekday] ?? 'ראשון'}, ${localDate(at, timeZone)}`;
}

/**
 * The instant at which a local date reaches a wall-clock time in a timezone.
 *
 * Two passes: read the zone's offset at a first guess, correct by it, then read
 * again — so a date on which the offset changes (a DST switch) still lands on
 * the requested wall-clock time rather than an hour off.
 */
export function atLocalTime(date: string, minutesOfDay: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(year, month - 1, day, 0, minutesOfDay);

  const offsetAt = (instant: Date): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(instant);
    const value = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value);
    const hour = value('hour') === 24 ? 0 : value('hour');
    const asUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      hour,
      value('minute'),
    );
    return asUtc - instant.getTime();
  };

  const first = new Date(wanted - offsetAt(new Date(wanted)));
  return new Date(wanted - offsetAt(first));
}
