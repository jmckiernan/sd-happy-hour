/**
 * Shared wall-clock logic for venue schedules and merchant-entered local
 * datetimes. All recurring happy-hour rules are interpreted in San Diego,
 * regardless of the server or visitor's own timezone.
 */

export const SD_TIME_ZONE = 'America/Los_Angeles';

export type InstantInput = Date | number | string;

export interface SanDiegoParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: number;
  minute: number;
  second: number;
}

export type SanDiegoDateTimeDisambiguation = 'earlier' | 'later' | 'reject';

export interface ParseSanDiegoLocalDateTimeOptions {
  /**
   * A fall-back clock time occurs twice. Ambiguous input is rejected by
   * default; tightly controlled schedule code may explicitly pick the first
   * or second occurrence. Spring-forward times that never occur are always
   * rejected.
   */
  disambiguation?: SanDiegoDateTimeDisambiguation;
}

export interface SanDiegoDayBounds {
  dateKey: string;
  start: Date;
  /** Exclusive start of the following San Diego calendar day. */
  end: Date;
}

export interface HappyHourWindow {
  days: readonly string[];
  startTime: string;
  endTime: string;
  kind?: 'happy_hour' | 'late_night' | 'weekly_special';
  label?: string;
  allDay?: boolean;
}

export interface HappyHourSchedule {
  id: number;
  days: readonly string[];
  startTime: string;
  endTime: string;
  /** Canonical schedule when a venue has more than one period. */
  windows?: HappyHourWindow[];
}

export interface HappyHourOccurrence {
  venueId: number;
  /** San Diego-local date on which this occurrence starts (YYYY-MM-DD). */
  dateKey: string;
  weekday: string;
  startTime: string;
  endTime: string;
  startsAt: Date;
  endsAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const OFFSET_AWARE_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const sanDiegoFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: SD_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isRealUtcCalendarDate(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function dateKeyFromParts(parts: Pick<SanDiegoParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_KEY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealUtcCalendarDate(year, month, day)) return null;
  return { year, month, day };
}

function addCalendarDays(dateKey: string, amount: number): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new RangeError(`Invalid calendar date: ${dateKey}`);
  const value = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + amount));
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

/**
 * Parse an absolute instant. Offsetless strings deliberately return null:
 * `new Date('2026-08-21T17:00')` would silently use the machine's timezone,
 * which is never a safe interpretation for this product.
 */
export function parseInstant(value: InstantInput | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value !== 'string' || !OFFSET_AWARE_DATE_TIME.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getSanDiegoParts(value: InstantInput = new Date()): SanDiegoParts {
  const instant = parseInstant(value);
  if (!instant) throw new RangeError('Expected a valid absolute instant.');

  const parts = sanDiegoFormatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';

  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    weekday: read('weekday'),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
  };
}

function timeZoneOffsetMilliseconds(instant: Date): number {
  const parts = getSanDiegoParts(instant);
  const renderedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const instantWithoutMilliseconds = Math.trunc(instant.getTime() / 1000) * 1000;
  return renderedAsUtc - instantWithoutMilliseconds;
}

function sameWallClock(
  instant: Date,
  expected: Omit<SanDiegoParts, 'weekday'>
): boolean {
  const actual = getSanDiegoParts(instant);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second
  );
}

/**
 * Convert an offsetless San Diego wall time (`YYYY-MM-DDTHH:mm[:ss]`) to an
 * absolute instant without ever handing that offsetless value to `new Date`.
 */
export function parseSanDiegoLocalDateTime(
  value: string,
  options: ParseSanDiegoLocalDateTimeOptions = {}
): Date | null {
  const match = LOCAL_DATE_TIME.exec(String(value || '').trim());
  if (!match) return null;

  const expected = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
  };
  if (
    !isRealUtcCalendarDate(expected.year, expected.month, expected.day) ||
    expected.hour > 23 ||
    expected.minute > 59 ||
    expected.second > 59
  ) {
    return null;
  }

  const wallClockAsUtc = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second
  );

  // Around a DST transition two offsets can be relevant. Sample nearby days
  // (plus seasonal points) to discover both, then keep only instants that
  // render back to the requested San Diego wall clock.
  const offsetSamples = [-370, -2, -1, 0, 1, 2, 370];
  const offsets = new Set(
    offsetSamples.map((days) => timeZoneOffsetMilliseconds(new Date(wallClockAsUtc + days * DAY_MS)))
  );
  const candidates = [...offsets]
    .map((offset) => new Date(wallClockAsUtc - offset))
    .filter((candidate) => sameWallClock(candidate, expected))
    .sort((left, right) => left.getTime() - right.getTime())
    .filter((candidate, index, all) => index === 0 || candidate.getTime() !== all[index - 1].getTime());

  // A nonexistent spring-forward wall time has no matching instant.
  if (!candidates.length) return null;
  if (candidates.length > 1 && (options.disambiguation ?? 'reject') === 'reject') return null;
  if (options.disambiguation === 'later') return candidates[candidates.length - 1];
  return candidates[0];
}

export function getSanDiegoDateKey(value: InstantInput = new Date()): string {
  return dateKeyFromParts(getSanDiegoParts(value));
}

export function getSanDiegoMonthKey(value: InstantInput = new Date()): string {
  const parts = getSanDiegoParts(value);
  return `${parts.year}-${pad(parts.month)}`;
}

export function getSanDiegoDayBounds(value: InstantInput = new Date()): SanDiegoDayBounds {
  let dateKey: string;
  if (typeof value === 'string' && DATE_KEY.test(value.trim())) {
    dateKey = value.trim();
    if (!parseDateKey(dateKey)) throw new RangeError(`Invalid calendar date: ${dateKey}`);
  } else {
    dateKey = getSanDiegoDateKey(value);
  }

  const start = parseSanDiegoLocalDateTime(`${dateKey}T00:00`);
  const nextDateKey = addCalendarDays(dateKey, 1);
  const end = parseSanDiegoLocalDateTime(`${nextDateKey}T00:00`);
  if (!start || !end) throw new RangeError(`Could not resolve San Diego day bounds for ${dateKey}.`);
  return { dateKey, start, end };
}

function weekdayForDateKey(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return '';
  return WEEKDAYS[new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()];
}

function clockMinutes(value: string): number | null {
  const match = CLOCK_TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function scheduleWindows(schedule: HappyHourSchedule): HappyHourWindow[] {
  if (Array.isArray(schedule.windows) && schedule.windows.length) return [...schedule.windows];
  return [{ days: schedule.days, startTime: schedule.startTime, endTime: schedule.endTime }];
}

/** Build one occurrence from the San Diego-local date on which it starts.
 * Overnight windows (22:00–01:00) close on the following calendar day. */
export function getHappyHourOccurrenceForDate(
  schedule: HappyHourSchedule,
  dateKey: string
): HappyHourOccurrence | null {
  const weekday = weekdayForDateKey(dateKey);
  const startMinutes = clockMinutes(schedule.startTime);
  const endMinutes = clockMinutes(schedule.endTime);
  if (
    !weekday ||
    !schedule.days.includes(weekday) ||
    startMinutes == null ||
    endMinutes == null ||
    endMinutes === startMinutes
  ) {
    return null;
  }

  const startsAt = parseSanDiegoLocalDateTime(`${dateKey}T${schedule.startTime}`, {
    disambiguation: 'earlier',
  });
  const endDateKey = endMinutes < startMinutes ? addCalendarDays(dateKey, 1) : dateKey;
  const endsAt = parseSanDiegoLocalDateTime(`${endDateKey}T${schedule.endTime}`, {
    disambiguation: 'later',
  });
  if (!startsAt || !endsAt || endsAt.getTime() <= startsAt.getTime()) return null;

  return {
    venueId: schedule.id,
    dateKey,
    weekday,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    startsAt,
    endsAt,
  };
}

function occurrenceContains(occurrence: HappyHourOccurrence | null, instant: Date): boolean {
  return Boolean(
    occurrence
    && instant.getTime() >= occurrence.startsAt.getTime()
    && instant.getTime() < occurrence.endsAt.getTime()
  );
}

export function getActiveHappyHourOccurrence(
  schedule: HappyHourSchedule,
  now: InstantInput = new Date()
): HappyHourOccurrence | null {
  const instant = parseInstant(now);
  if (!instant) throw new RangeError('Expected a valid absolute instant.');
  const today = getSanDiegoDateKey(instant);
  const yesterday = addCalendarDays(today, -1);

  for (const window of scheduleWindows(schedule)) {
    if (window.allDay) {
      const weekday = weekdayForDateKey(today);
      if (window.days.includes(weekday)) {
        const bounds = getSanDiegoDayBounds(today);
        const occurrence = {
          venueId: schedule.id,
          dateKey: today,
          weekday,
          startTime: '00:00',
          endTime: '23:59',
          startsAt: bounds.start,
          endsAt: bounds.end,
        };
        if (occurrenceContains(occurrence, instant)) return occurrence;
      }
      continue;
    }
    const slice = {
      ...schedule,
      days: window.days,
      startTime: window.startTime,
      endTime: window.endTime,
    };
    const todayOccurrence = getHappyHourOccurrenceForDate(slice, today);
    if (occurrenceContains(todayOccurrence, instant)) return todayOccurrence;
    const overnight = getHappyHourOccurrenceForDate(slice, yesterday);
    if (occurrenceContains(overnight, instant)) return overnight;
  }
  return null;
}

export function isHappyHourActive(schedule: HappyHourSchedule, now: InstantInput = new Date()): boolean {
  return getActiveHappyHourOccurrence(schedule, now) !== null;
}
