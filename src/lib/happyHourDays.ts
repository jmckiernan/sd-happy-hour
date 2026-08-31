/**
 * Which weekdays a happy hour runs on.
 *
 * Its own module rather than part of lib/venues.ts because the venue page's
 * client script needs it, and lib/venues.ts imports the whole venue dataset —
 * pulling that into a browser bundle would ship megabytes of JSON to read a
 * seven-element array.
 */

export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export interface DayBearingSchedule {
  days?: readonly string[] | null;
  windows?: readonly { days?: readonly string[] | null }[] | null;
}

/**
 * `windows` is the canonical schedule and `days` is the older primary-window
 * mirror of it, so a venue with an extra period (an all-day Monday on top of a
 * Tue–Fri afternoon) has that day in `windows` and not in `days`. Every surface
 * that highlights days has to agree on this, or the prose and the day chips
 * contradict each other on the same screen.
 */
export function happyHourDayNames(schedule: DayBearingSchedule): string[] {
  const named = new Set<string>();
  for (const window of schedule.windows || []) {
    for (const day of window?.days || []) named.add(day);
  }
  for (const day of schedule.days || []) named.add(day);
  return WEEKDAY_NAMES.filter((day) => named.has(day));
}
