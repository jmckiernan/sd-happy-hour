#!/usr/bin/env node
// Give "all day" happy-hour windows the bounds of the venue's service day.
//
// An all-day window used to be stored as 00:00–23:59, which the open-now check
// read literally and reported happy hour as live at 3am. All day describes the
// venue's service day, so the window has to say when that day starts and ends:
// real operating hours when we have them (catalog open/close, or Google
// atmosphere `regularOpeningHours`), otherwise a conservative default.
//
// Primary listing clocks (days / startTime / endTime) mirror the canonical
// windows for older UI. Bounding windows alone left those fields on
// 00:00–23:59, so venue pages still printed a calendar day. This script keeps
// them in sync whenever it touches a listing.
//
// Usage:
//   npm run fix:all-day-windows              # dry run, reports what would change
//   npm run fix:all-day-windows -- --apply

import { DAY_NAMES, HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { applyPrimaryFromWindows } from './lib/schedule-windows.mjs';
import {
  operatingWindowsFromPeriods,
  regularOpeningPeriods,
  representativeVenueHours,
  uniformHoursForDays,
} from './lib/operating-hours.mjs';
import { ATMOSPHERE_PATH } from './backfill-atmosphere.mjs';

import {
  isUnboundedAllDayWindow,
  isDefaultServiceDayWindow,
  boundAllDayWindow,
} from '../../src/lib/sanDiegoTime.ts';

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clock(value) {
  return CLOCK.test(String(value || '')) ? String(value) : null;
}

/** Primary still naming the whole calendar day — what the venue page prints. */
export function isUnboundedPrimaryClock(venue) {
  return venue?.startTime === '00:00' && (venue?.endTime === '23:59' || venue?.endTime === '00:00');
}

function unionWindowDays(windows = []) {
  const seen = new Set();
  for (const window of windows) {
    for (const day of window.days || []) seen.add(day);
  }
  return DAY_NAMES.filter((day) => seen.has(day));
}

function allDayNeedsRealHours(window) {
  return isUnboundedAllDayWindow(window) || isDefaultServiceDayWindow(window);
}

/**
 * Rewrite an all-day window using Google regular hours for its days.
 * Splits into one window per distinct open–close range when days differ.
 */
function bindAllDayToOperatingHours(window, periods) {
  if (!periods.length) return [window];
  const days = window.days?.length ? window.days : [];
  const grouped = operatingWindowsFromPeriods(periods, { forHappyHour: true, days });
  if (!grouped.length) return [window];

  const uniform = uniformHoursForDays(periods, days, { forHappyHour: true });
  if (uniform) {
    return [boundAllDayWindow(window, uniform)];
  }

  return grouped.map((range) => ({
    ...window,
    days: range.days,
    startTime: range.startTime,
    endTime: range.endTime,
  }));
}

export { isUnboundedAllDayWindow, isDefaultServiceDayWindow, boundAllDayWindow };

function main() {
  const apply = process.argv.includes('--apply');
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const atmosphere = readJson(ATMOSPHERE_PATH, { places: {} });
  const places = atmosphere.places || {};
  const changed = [];

  for (const venue of venues) {
    if (!Array.isArray(venue.windows) || !venue.windows.length) continue;

    const needsWindowFix = venue.windows.some((window) => window.allDay && allDayNeedsRealHours(window));
    const needsPrimaryFix = isUnboundedPrimaryClock(venue);
    if (!needsWindowFix && !needsPrimaryFix) continue;

    const place = venue.placeId ? places[venue.placeId] : null;
    const periods = place ? regularOpeningPeriods(place) : [];
    // Prefer hours for the days the all-day promotion actually covers.
    const allDayDays = [
      ...new Set(
        venue.windows
          .filter((window) => window.allDay && allDayNeedsRealHours(window))
          .flatMap((window) => window.days || [])
      ),
    ];
    const fromAtmosphere = periods.length
      ? representativeVenueHours(periods, allDayDays.length ? allDayDays : null)
      : null;

    const beforeOpen = venue.openTime;
    const beforeClose = venue.closeTime;
    let setVenueHours = false;
    // Flat open/close is a single pair — only fill it when the listing's lead
    // clocks were the calendar-day lie (Punch Bowl / Common Theory class).
    // Other venues may have a side all-day special whose day-hours would be a
    // misleading "Venue Hours" line under a timed weekday happy hour.
    if (
      needsPrimaryFix &&
      fromAtmosphere &&
      !(clock(venue.openTime) && clock(venue.closeTime))
    ) {
      venue.openTime = fromAtmosphere.openTime;
      venue.closeTime = fromAtmosphere.closeTime;
      setVenueHours = true;
    }

    const hours = {
      openTime: clock(venue.openTime),
      closeTime: clock(venue.closeTime),
    };

    const beforeWindows = JSON.stringify(venue.windows);
    const nextWindows = [];
    for (const window of venue.windows) {
      if (!window.allDay) {
        nextWindows.push(window);
        continue;
      }
      if (periods.length && allDayNeedsRealHours(window)) {
        nextWindows.push(...bindAllDayToOperatingHours(window, periods));
        continue;
      }
      nextWindows.push(boundAllDayWindow(window, hours));
    }

    const windowsChanged = JSON.stringify(nextWindows) !== beforeWindows;
    const primary = applyPrimaryFromWindows(nextWindows, {});
    const shouldSyncPrimary =
      Boolean(primary.startTime) &&
      (needsPrimaryFix || (windowsChanged && isUnboundedPrimaryClock({ startTime: venue.startTime, endTime: venue.endTime })));

    // Only rewrite primary clocks when they were the calendar-day lie. Timed
    // happy hours that share a listing with a separate all-day special keep
    // their existing primary lead.
    if (!windowsChanged && !shouldSyncPrimary && !setVenueHours) continue;

    venue.windows = nextWindows;
    if (shouldSyncPrimary) {
      venue.startTime = primary.startTime;
      venue.endTime = primary.endTime;
      // Lead window may be one day-group after a split; keep every day that
      // still has a happy-hour window so chips / filters do not shrink.
      const days = unionWindowDays(nextWindows);
      if (days.length) venue.days = days;
    }

    const fromOwnHours = Boolean(hours.openTime && hours.closeTime);
    changed.push({
      venue,
      fromOwnHours,
      fromAtmosphere: Boolean(periods.length),
      windowsChanged,
      primarySynced: shouldSyncPrimary,
      setVenueHours,
      beforeOpen,
      beforeClose,
    });
  }

  console.log(`${changed.length} listing(s) with all-day / primary clock updates.`);
  for (const row of changed) {
    const { venue, fromOwnHours, fromAtmosphere, windowsChanged, primarySynced, setVenueHours } = row;
    const parts = [];
    if (setVenueHours) {
      parts.push(`venue hours ${venue.openTime}–${venue.closeTime}`);
    }
    if (windowsChanged) {
      const allDay = venue.windows.filter((entry) => entry.allDay);
      const summary = allDay
        .map((w) => `${w.startTime}–${w.endTime} (${(w.days || []).join(',')})`)
        .join(' | ');
      const source = fromAtmosphere
        ? 'from Google regular hours'
        : fromOwnHours
          ? "from the venue's own hours"
          : 'from the default service day';
      parts.push(`windows ${summary} ${source}`);
    }
    if (primarySynced) {
      parts.push(`primary ${venue.startTime}–${venue.endTime}`);
    }
    console.log(`  → ${venue.name} (${venue.id}): ${parts.join('; ')}`);
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to write.');
    return;
  }
  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`\nWrote ${HAPPY_HOURS_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
