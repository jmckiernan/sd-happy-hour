/**
 * Venue operating hours from Google Places `regularOpeningHours`.
 *
 * Distinct from happy-hour secondary hours: these describe when the doors are
 * open. All-day happy hour is "while we're open that day", so bounding an
 * all-day window needs these clocks — not a calendar day and not an invented
 * default when the real hours are sitting in the atmosphere cache.
 */

import { DAY_NAMES } from './constants.mjs';

const GOOGLE_DAY_ORDER = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function toClock(hour, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Happy-hour windows may end at midnight (`00:00`) but not later the next
 * morning. Venue `openTime`/`closeTime` may keep a real 1am/2am close.
 */
export function closeClockForHappyHour(open, close) {
  if (!open || !close || typeof close.hour !== 'number') return null;
  const end = toClock(close.hour, close.minute || 0);
  const crossesMidnight = typeof close.day === 'number' && close.day !== open.day;
  if (!crossesMidnight) return end;
  // Next-calendar-day midnight → until-midnight sentinel.
  if (end === '00:00' || (close.hour === 0 && (close.minute || 0) === 0)) return '00:00';
  // Past midnight (1am, 2am, …) → truncate to midnight for HH product rules.
  return '00:00';
}

function periodClocks(period, { forHappyHour = false } = {}) {
  const open = period?.open;
  const close = period?.close;
  if (!open || typeof open.day !== 'number' || typeof open.hour !== 'number') return null;
  if (!close || typeof close.hour !== 'number') return null;
  const day = GOOGLE_DAY_ORDER[open.day];
  if (!day) return null;
  const startTime = toClock(open.hour, open.minute || 0);
  const endTime = forHappyHour
    ? closeClockForHappyHour(open, close)
    : toClock(close.hour, close.minute || 0);
  if (!endTime) return null;
  return { day, startTime, endTime };
}

/**
 * Collapse regular-hours periods into day-grouped windows.
 * @param {object[]} periods Google `regularOpeningHours.periods`
 * @param {{ forHappyHour?: boolean, days?: string[] }} [options]
 */
export function operatingWindowsFromPeriods(periods = [], options = {}) {
  const allow = options.days?.length ? new Set(options.days) : null;
  const byRange = new Map();

  for (const period of periods) {
    const clocks = periodClocks(period, { forHappyHour: Boolean(options.forHappyHour) });
    if (!clocks) continue;
    if (allow && !allow.has(clocks.day)) continue;
    const key = `${clocks.startTime}-${clocks.endTime}`;
    if (!byRange.has(key)) {
      byRange.set(key, { startTime: clocks.startTime, endTime: clocks.endTime, days: new Set() });
    }
    byRange.get(key).days.add(clocks.day);
  }

  return [...byRange.values()]
    .map((window) => ({
      startTime: window.startTime,
      endTime: window.endTime,
      days: DAY_NAMES.filter((day) => window.days.has(day)),
    }))
    .filter((window) => window.days.length)
    .sort((a, b) => b.days.length - a.days.length || a.startTime.localeCompare(b.startTime));
}

/** Flat open/close when every requested day shares one range; otherwise null. */
export function uniformHoursForDays(periods = [], days = [], options = {}) {
  const windows = operatingWindowsFromPeriods(periods, { ...options, days });
  if (windows.length !== 1) return null;
  const covered = new Set(windows[0].days);
  if (days.some((day) => !covered.has(day))) return null;
  return { openTime: windows[0].startTime, closeTime: windows[0].endTime };
}

/**
 * Best single open/close pair for the catalog's flat `openTime`/`closeTime`
 * fields: the schedule that covers the most days (real close, including 1am).
 */
export function representativeVenueHours(periods = [], days = null) {
  const windows = operatingWindowsFromPeriods(periods, {
    forHappyHour: false,
    ...(days?.length ? { days } : {}),
  });
  if (!windows.length) return null;
  return { openTime: windows[0].startTime, closeTime: windows[0].endTime };
}

export function regularOpeningPeriods(place) {
  const periods = place?.regularOpeningHours?.periods;
  return Array.isArray(periods) ? periods : [];
}
