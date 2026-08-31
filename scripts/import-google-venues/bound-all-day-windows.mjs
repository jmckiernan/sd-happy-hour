#!/usr/bin/env node
// Give "all day" happy-hour windows the bounds of the venue's service day.
//
// An all-day window used to be stored as 00:00–23:59, which the open-now check
// read literally and reported happy hour as live at 3am. All day describes the
// venue's service day, so the window has to say when that day starts and ends:
// the venue's own hours when we have them, otherwise a conservative default.
//
// Usage:
//   npm run fix:all-day-windows              # dry run, reports what would change
//   npm run fix:all-day-windows -- --apply

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const DEFAULT_SERVICE_DAY = { startTime: '11:00', endTime: '22:00' };
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clock(value) {
  return CLOCK.test(String(value || '')) ? String(value) : null;
}

/** True when a window claims to be all day but stores the calendar day. */
export function isUnboundedAllDayWindow(window) {
  if (!window?.allDay) return false;
  return window.startTime === '00:00' && (window.endTime === '23:59' || window.endTime === '00:00');
}

export function boundAllDayWindow(window, hours = {}) {
  if (!isUnboundedAllDayWindow(window)) return window;
  return {
    ...window,
    startTime: clock(hours.openTime) || DEFAULT_SERVICE_DAY.startTime,
    endTime: clock(hours.closeTime) || DEFAULT_SERVICE_DAY.endTime,
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const changed = [];

  for (const venue of venues) {
    if (!Array.isArray(venue.windows)) continue;
    const before = JSON.stringify(venue.windows);
    const windows = venue.windows.map((window) => boundAllDayWindow(window, venue));
    if (JSON.stringify(windows) === before) continue;
    venue.windows = windows;
    const fromOwnHours = Boolean(clock(venue.openTime) && clock(venue.closeTime));
    changed.push({ venue, fromOwnHours });
  }

  console.log(`${changed.length} listing(s) with an unbounded all-day window.`);
  for (const { venue, fromOwnHours } of changed) {
    const window = venue.windows.find((entry) => entry.allDay);
    console.log(
      `  → ${venue.name} (${venue.id}): ${window.startTime}–${window.endTime}` +
      ` ${fromOwnHours ? "from the venue's own hours" : 'from the default service day'}`
    );
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to write.');
    return;
  }
  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`\nWrote ${HAPPY_HOURS_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
