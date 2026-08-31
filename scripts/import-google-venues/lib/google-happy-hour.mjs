/**
 * Read structured happy-hour data out of cached Google Places records.
 *
 * Google exposes happy hour as `regularSecondaryOpeningHours` with
 * `secondaryHoursType: 'HAPPY_HOUR'`. The `periods` array is authoritative and
 * already structured; `weekdayDescriptions` is only used for display.
 */

import { DAY_NAMES } from './constants.mjs';

/** Google numbers days 0=Sunday..6=Saturday. */
const GOOGLE_DAY_ORDER = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function findHappyHourBlock(place) {
  const blocks = place?.regularSecondaryOpeningHours;
  if (!Array.isArray(blocks)) return null;
  return (
    blocks.find((block) => (block?.secondaryHoursType || block?.type) === 'HAPPY_HOUR') || null
  );
}

function toClock(hour, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Collapse Google periods into distinct time windows, each with the days it runs.
 * A period that closes at midnight on the following calendar day (10pm–12am)
 * keeps its opening day and endTime `00:00`. Periods that continue past
 * midnight into the morning (10pm–1am) are dropped — this product does not
 * publish overnight happy hours.
 */
export function windowsFromPeriods(periods = []) {
  const byRange = new Map();

  for (const period of periods) {
    const open = period?.open;
    const close = period?.close;
    if (!open || typeof open.day !== 'number' || typeof open.hour !== 'number') continue;

    const day = GOOGLE_DAY_ORDER[open.day];
    if (!day) continue;

    const start = toClock(open.hour, open.minute || 0);
    // A missing close means Google reported an open-ended window; skip it rather
    // than inventing an end time.
    if (!close || typeof close.hour !== 'number') continue;
    const end = toClock(close.hour, close.minute || 0);
    const startMins = open.hour * 60 + (open.minute || 0);
    const endMins = close.hour * 60 + (close.minute || 0);
    const crossesMidnight = typeof close.day === 'number' && close.day !== open.day;
    // Until midnight is fine; anything later the next morning is not.
    if (crossesMidnight && !(end === '00:00' || endMins === 0)) continue;
    if (!crossesMidnight && endMins < startMins && end !== '00:00') continue;

    const key = `${start}-${end}`;
    if (!byRange.has(key)) byRange.set(key, { startTime: start, endTime: end, days: new Set() });
    byRange.get(key).days.add(day);
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

function minutesOfDay(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

/**
 * The window a listing should lead with: the one running on the most days,
 * preferring afternoon/early-evening over late-night when days tie.
 */
export function pickPrimaryWindow(windows = []) {
  if (!windows.length) return null;
  const timed = windows.filter((window) => !window.allDay);
  const pool = timed.length ? timed : windows;
  const scored = pool.map((window) => {
    const start = minutesOfDay(window.startTime);
    // Afternoon starts (2pm–7pm) are the canonical happy hour slot.
    const isClassicSlot = start >= 14 * 60 && start <= 19 * 60;
    return { window, dayCount: window.days.length, isClassicSlot, start };
  });

  scored.sort((a, b) => {
    if (a.isClassicSlot !== b.isClassicSlot) return a.isClassicSlot ? -1 : 1;
    if (b.dayCount !== a.dayCount) return b.dayCount - a.dayCount;
    return a.start - b.start;
  });

  return scored[0].window;
}

/** Extract normalized happy-hour timing from a cached Google place record. */
export function happyHourFromPlace(place) {
  const block = findHappyHourBlock(place);
  if (!block) return null;

  const windows = windowsFromPeriods(block.periods);
  if (!windows.length) return null;

  const primary = pickPrimaryWindow(windows);
  if (!primary) return null;

  return {
    startTime: primary.startTime,
    endTime: primary.endTime,
    days: primary.days,
    windows,
    weekdayDescriptions: block.weekdayDescriptions || [],
    sourceUrl: place.googleMapsUri || null,
    placeId: place.googlePlaceId || place.id || null,
  };
}

export function normalizeMatchKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function streetNumber(address) {
  return String(address || '').match(/^\s*(\d+)/)?.[1] || null;
}

/**
 * Index cached places by normalized name so venues can be matched without an
 * ID. Our venue records predate storing a Place ID.
 */
export function indexPlacesByName(places = []) {
  const index = new Map();
  for (const place of places) {
    const key = normalizeMatchKey(place?.displayName);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(place);
  }
  return index;
}

/**
 * Match a venue to a cached place. Name must match exactly (normalized); when a
 * brand has several locations the street number disambiguates. Ambiguous
 * multi-location matches without an address match are rejected so chain data
 * never leaks between locations.
 */
export function matchVenueToPlace(venue, index) {
  const candidates = index.get(normalizeMatchKey(venue?.name));
  if (!candidates?.length) return { place: null, reason: 'no_name_match' };
  if (candidates.length === 1) return { place: candidates[0], reason: 'name' };

  const number = streetNumber(venue?.address);
  if (number) {
    const byAddress = candidates.filter((place) => streetNumber(place.formattedAddress) === number);
    if (byAddress.length === 1) return { place: byAddress[0], reason: 'name_and_address' };
  }

  return { place: null, reason: 'ambiguous_multi_location' };
}
