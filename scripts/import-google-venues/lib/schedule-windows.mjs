import { DAY_NAMES } from './constants.mjs';
import { daysFromRangeText, isGappedSubrange } from './day-ranges.mjs';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClock(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

export function minutesOfDay(clock) {
  const [h, m] = String(clock).split(':').map(Number);
  return h * 60 + m;
}

/** Duration in minutes. Overnight windows (end <= start) wrap past midnight. */
export function windowDurationMinutes(startTime, endTime) {
  if (!isClock(startTime) || !isClock(endTime)) return null;
  const start = minutesOfDay(startTime);
  const end = minutesOfDay(endTime);
  if (end === start) return 0;
  return end > start ? end - start : end + 24 * 60 - start;
}

export function isLateNightStart(startTime) {
  if (!isClock(startTime)) return false;
  return minutesOfDay(startTime) >= 20 * 60;
}

/**
 * Reject windows that are almost certainly operating hours or parser junk.
 * Overnight happy hour (22:00–01:00) is allowed; 02:00–08:00 and 11-hour
 * spans are not.
 */
export function isPlausibleHappyHourWindow(window) {
  if (!window || !Array.isArray(window.days) || !window.days.length) return false;
  if (window.days.some((day) => !DAY_NAMES.includes(day))) return false;
  if (window.allDay) return true;
  if (!isClock(window.startTime) || !isClock(window.endTime)) return false;

  const duration = windowDurationMinutes(window.startTime, window.endTime);
  if (duration == null || duration < 30) return false;
  if (duration >= 8 * 60) return false;

  const start = minutesOfDay(window.startTime);
  if (start < 11 * 60 && !isLateNightStart(window.startTime)) return false;

  return true;
}

export function normalizeWindow(raw) {
  if (!raw) return null;
  const days = Array.isArray(raw.days) ? DAY_NAMES.filter((day) => raw.days.includes(day)) : [];
  const allDay = raw.allDay === true || /all\s*day/i.test(String(raw.label || ''));
  const window = {
    days,
    startTime: isClock(raw.startTime) ? raw.startTime : (allDay ? '11:00' : raw.startTime),
    endTime: isClock(raw.endTime) ? raw.endTime : (allDay ? '23:00' : raw.endTime),
    kind: ['happy_hour', 'late_night', 'weekly_special'].includes(raw.kind) ? raw.kind : (allDay ? 'weekly_special' : 'happy_hour'),
    ...(allDay ? { allDay: true } : {}),
    ...(raw.startsAtOpen === true ? { startsAtOpen: true } : {}),
    ...(raw.label ? { label: String(raw.label).slice(0, 80) } : {}),
    ...(raw.location ? { location: String(raw.location).slice(0, 120) } : {}),
  };
  if (!isPlausibleHappyHourWindow(window)) return null;
  if (!window.allDay && isLateNightStart(window.startTime) && window.kind === 'happy_hour') {
    window.kind = 'late_night';
  }
  return window;
}

/**
 * "All day Monday, Tue–Fri 3–6" often arrives as all-day Mon–Fri plus a
 * timed Tue–Fri window. Days that already have a shorter timed window
 * are not all-day.
 */
export function narrowAllDayWindows(windows = []) {
  const timedDays = new Set(
    windows.filter((window) => !window.allDay).flatMap((window) => window.days || [])
  );
  if (!timedDays.size) return windows;
  const next = [];
  for (const window of windows) {
    if (!window.allDay) {
      next.push(window);
      continue;
    }
    const days = window.days.filter((day) => !timedDays.has(day));
    if (!days.length) continue;
    next.push({ ...window, days });
  }
  return next;
}

/**
 * Same clock on Mon–Thu / Fri / Sat / Sun is one window, not four UI lines.
 * Kind and allDay stay distinct (afternoon HH vs late-night).
 */
export function mergeSameHoursWindows(windows = []) {
  const groups = new Map();
  for (const window of windows) {
    const clock = window.allDay ? 'allday' : `${window.startTime}-${window.endTime}`;
    const key = `${clock}|${window.kind || 'happy_hour'}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...window, days: [...(window.days || [])] });
      continue;
    }
    existing.days = DAY_NAMES.filter((day) => existing.days.includes(day) || (window.days || []).includes(day));
    if (window.location && !existing.location) existing.location = window.location;
    if (window.label && (!existing.label || window.label.length > existing.label.length)) {
      existing.label = window.label;
    }
  }
  return [...groups.values()];
}

export function normalizeWindows(rawWindows = []) {
  const seen = new Set();
  const windows = [];
  for (const raw of rawWindows) {
    const window = normalizeWindow(raw);
    if (!window) continue;
    const key = `${window.allDay ? 'allday' : `${window.startTime}-${window.endTime}`}-${window.days.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push(window);
  }
  return mergeSameHoursWindows(narrowAllDayWindows(windows));
}

/** "OPEN–7PM" is until 19:00, not 23:59. */
export function endTimeFromOpenUntilQuote(text) {
  const match = String(text || '').match(/\bopen\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const pm = /^p/i.test(match[3]);
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * "OPEN–7PM" fixes the end of the window and says the start is whenever the
 * doors open. startTime stays populated so time-of-day filtering still works,
 * but `startsAtOpen` keeps us from printing a start time the venue never
 * published — the board and listing say "Open until 7 PM" instead.
 */
/** Assumed length of an "open until X" window when the venue's opening time is unknown. */
const OPEN_START_LEAD_MINUTES = 4 * 60;
const EARLIEST_ASSUMED_OPEN = 11 * 60;

function clockFromMinutes(minutes) {
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isOpenUntilEnd(endTime, openUntilEnd) {
  return endTime === openUntilEnd || endTime === '23:59' || endTime === '00:00';
}

/**
 * A source that says "OPEN–7PM" gives no start time, and models fill that gap
 * with 00:00 — which then looks like operating hours and gets the whole window
 * thrown away as implausible. Repair those windows *before* normalization: keep
 * a bounded start so time-of-day filtering works, and flag `startsAtOpen` so
 * nothing ever displays it.
 *
 * Runs on raw model windows, so it must not assume normalized shapes.
 */
export function repairOpenStartWindows(rawWindows = [], evidence = []) {
  const openUntilEnd = endTimeFromOpenUntilQuote((evidence || []).map((row) => row.quote).join(' '));
  if (!openUntilEnd) return rawWindows;

  const assumedStart = clockFromMinutes(
    Math.max(EARLIEST_ASSUMED_OPEN, minutesOfDay(openUntilEnd) - OPEN_START_LEAD_MINUTES)
  );

  return (rawWindows || []).map((window) => {
    if (!window || window.allDay === true) return window;
    if (!isOpenUntilEnd(window.endTime, openUntilEnd)) return window;
    const startUsable = isClock(window.startTime)
      && isPlausibleHappyHourWindow({ ...window, endTime: openUntilEnd, days: window.days || [] });
    return {
      ...window,
      endTime: openUntilEnd,
      startTime: startUsable ? window.startTime : assumedStart,
      startsAtOpen: true,
    };
  });
}

/**
 * When the evidence quote states a day range in the venue's own words
 * ("SUNDAY - THURSDAY"), that range beats the model's day list.
 *
 * Models transcribe a range into an enumeration and sometimes drop an interior
 * day, which silently hides a venue's happy hour on that day. Only interior
 * days are filled, and only when the model's own days sit inside the quoted
 * range and reach both of its ends — so a genuinely intermittent schedule
 * ("Mon, Wed, Fri") is never widened into something the venue didn't say.
 */
export function repairDaysFromEvidence(windows = [], evidence = []) {
  const quoted = (evidence || [])
    .filter((row) => !row?.field || row.field === 'times')
    .map((row) => daysFromRangeText(String(row?.quote || '')))
    .filter((days) => Array.isArray(days) && days.length >= 3);
  if (!quoted.length) return windows;

  return (windows || []).map((window) => {
    for (const range of quoted) {
      if (isGappedSubrange(window?.days, range)) return { ...window, days: [...range] };
    }
    return window;
  });
}

export function applyOpenUntilFromQuotes(windows = [], evidence = []) {
  const endTime = endTimeFromOpenUntilQuote((evidence || []).map((row) => row.quote).join(' '));
  if (!endTime) return windows;
  return windows.map((window) => {
    if (window.allDay) return window;
    if (window.endTime === '23:59' || window.endTime === '00:00') {
      return { ...window, endTime, startsAtOpen: true };
    }
    if (window.endTime === endTime) {
      return { ...window, startsAtOpen: true };
    }
    return window;
  });
}

export function windowsEqual(a = [], b = []) {
  const key = (windows) =>
    JSON.stringify(
      windows.map((w) => ({
        startTime: w.startTime,
        endTime: w.endTime,
        days: [...(w.days || [])],
        allDay: Boolean(w.allDay),
      }))
    );
  return key(a) === key(b);
}

/** Primary listing fields stay populated for older UI; windows is canonical. */
export function applyPrimaryFromWindows(windows, fallback = {}) {
  const primary = windows.find((window) => !window.allDay) || windows[0] || null;
  if (!primary) {
    return {
      startTime: fallback.startTime,
      endTime: fallback.endTime,
      days: fallback.days,
    };
  }
  return {
    startTime: primary.startTime,
    endTime: primary.endTime,
    days: primary.days,
  };
}
