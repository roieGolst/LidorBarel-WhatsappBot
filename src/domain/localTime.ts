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
