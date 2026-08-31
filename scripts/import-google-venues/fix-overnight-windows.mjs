#!/usr/bin/env node
// Strip or correct happy-hour windows that cross midnight / end before start.
//
// Product rule (owner, 31 Aug 2026): there are no overnight happy hours. A
// window like 21:00–02:00 or 19:00–18:00 is always bad data. Ending at midnight
// (`endTime === '00:00'`) is kept — that means "until midnight", same evening.
//
// When evidence clearly gives a same-day window, this script applies it.
// Otherwise the bad window is removed. If nothing usable remains, the listing
// becomes an honest stub (hasHappyHourData: false) rather than publishing a guess.
//
// Usage:
//   node scripts/import-google-venues/fix-overnight-windows.mjs           # report
//   node scripts/import-google-venues/fix-overnight-windows.mjs --apply   # write

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import {
  isClock,
  minutesOfDay,
  isOvernightOrSwappedWindow,
  applyPrimaryFromWindows,
} from './lib/schedule-windows.mjs';

const apply = process.argv.includes('--apply');
const venues = readJson(HAPPY_HOURS_PATH, []);

/** Evidence-backed same-day replacements, keyed by venue id. */
const FIXES = new Map([
  // Stored 19:00–18:00; own page quotes Mon–Fri 4:00 PM–6:00 PM.
  [93, {
    action: 'replace-all',
    windows: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '16:00', endTime: '18:00', kind: 'happy_hour' }],
    why: 'venue quote: Happy Hour Mon - Fri: 4:00 PM-6:00 PM',
  }],
  // Pitcher specials are "9PM - Close", not until 2am; Sunday karaoke overnight is not HH.
  [468, {
    action: 'patch-windows',
    patch(windows) {
      return windows
        .map((w) => {
          if (w.startTime === '21:00' && w.endTime === '02:00' && (w.label || '').toLowerCase().includes('pitcher')) {
            return { ...w, endTime: '23:59' };
          }
          if (w.startTime === '21:00' && w.endTime === '02:00') return null; // karaoke overnight
          return w;
        })
        .filter(Boolean);
    },
    why: 'pitcher specials are 9pm–close; karaoke 9pm–2am is not happy hour',
  }],
]);

function windowIsBad(w) {
  if (!isClock(w?.startTime) || !isClock(w?.endTime)) return false;
  if (isOvernightOrSwappedWindow(w.startTime, w.endTime)) return true;
  // "Until midnight" that spans 8+ hours is operating hours, not HH.
  if (w.endTime === '00:00' && !w.allDay) {
    const dur = minutesOfDay('00:00') + 24 * 60 - minutesOfDay(w.startTime);
    if (dur >= 8 * 60) return true;
  }
  return false;
}

function toStub(venue) {
  delete venue.startTime;
  delete venue.endTime;
  delete venue.days;
  delete venue.windows;
  delete venue.allDay;
  venue.hasHappyHourData = false;
  venue.deals = [];
  venue.dealTypes = [];
  delete venue.dealsUnknown;
  if (venue.listingStatus !== 'unlisted') venue.listingStatus = 'unlisted';
  venue.seoHidden = true;
}

const report = { fixed: [], clearedWindow: [], stubbed: [], untouchedMidnight: [] };

for (const venue of venues) {
  const fix = FIXES.get(venue.id);
  let windows = Array.isArray(venue.windows) ? venue.windows.map((w) => ({ ...w })) : null;
  const hadWindowsArray = Boolean(windows);
  if (!windows) {
    if (isClock(venue.startTime) && isClock(venue.endTime) && venue.days?.length) {
      windows = [{ days: [...venue.days], startTime: venue.startTime, endTime: venue.endTime }];
    } else {
      windows = [];
    }
  }

  const beforeBad = windows.filter(windowIsBad);
  if (!beforeBad.length && !fix) {
    // Track legitimate until-midnight for the report.
    for (const w of windows) {
      if (w.endTime === '00:00') {
        report.untouchedMidnight.push({ id: venue.id, name: venue.name, w: `${w.startTime}-${w.endTime}` });
      }
    }
    continue;
  }

  let after = windows;
  let why = '';

  if (fix?.action === 'replace-all') {
    after = fix.windows;
    why = fix.why;
  } else if (fix?.action === 'patch-windows') {
    after = fix.patch(windows);
    why = fix.why;
  } else {
    // Tipsy Crow: all-day specials with operating hours ending at 2am → same-day close.
    after = windows.map((w) => {
      if (w.allDay && isOvernightOrSwappedWindow(w.startTime, w.endTime)) {
        return { ...w, endTime: '23:59' };
      }
      return w;
    }).filter((w) => !windowIsBad(w));
    why = beforeBad.every((w) => w.allDay)
      ? 'all-day overnight end truncated to 23:59 (no overnight HH)'
      : 'removed end-before-start / overnight window(s); no clear same-day replacement';
  }

  const stillBad = after.filter(windowIsBad);
  if (stillBad.length) {
    throw new Error(`${venue.id} ${venue.name}: fix left bad windows ${stillBad.map((w) => `${w.startTime}-${w.endTime}`).join(', ')}`);
  }

  const primary = applyPrimaryFromWindows(after, {});
  const entry = {
    id: venue.id,
    name: venue.name,
    listingStatus: venue.listingStatus,
    before: beforeBad.map((w) => `${w.startTime}-${w.endTime}`),
    after: after.map((w) => `${w.startTime}-${w.endTime}${w.allDay ? ' allDay' : ''}`),
    why,
  };

  if (!after.length) {
    report.stubbed.push(entry);
    if (apply) toStub(venue);
    continue;
  }

  if (fix) report.fixed.push(entry);
  else report.clearedWindow.push(entry);

  if (apply) {
    venue.windows = after;
    venue.startTime = primary.startTime;
    venue.endTime = primary.endTime;
    venue.days = primary.days;
    if (after.some((w) => w.allDay) && after.every((w) => w.allDay)) venue.allDay = true;
    else delete venue.allDay;
    // Flat-only rows that never had windows keep the array once corrected.
    if (!hadWindowsArray && after.length === 1 && !after[0].allDay && !after[0].kind && !after[0].label) {
      // Leave windows in place; primary fields stay in sync.
    }
    venue.hasHappyHourData = true;
  }
}

function printGroup(title, list) {
  console.log(`\n${title} (${list.length})`);
  for (const row of list) {
    console.log(`  ${row.id} ${row.name}`);
    if (row.before) console.log(`    before: ${row.before.join(' | ')}`);
    if (row.after) console.log(`    after:  ${row.after.join(' | ') || '(none → stub)'}`);
    if (row.w) console.log(`    keep:   ${row.w}`);
    if (row.why) console.log(`    why:    ${row.why}`);
  }
}

console.log(`Catalog: ${venues.length} listings.`);
printGroup('FIXED from evidence', report.fixed);
printGroup('CLEARED bad window(s), kept remaining', report.clearedWindow);
printGroup('STUBBED (no usable window left)', report.stubbed);
printGroup('Until-midnight kept (00:00 sentinel)', report.untouchedMidnight.slice(0, 5));
if (report.untouchedMidnight.length > 5) {
  console.log(`  … and ${report.untouchedMidnight.length - 5} more`);
}

const touched = report.fixed.length + report.clearedWindow.length + report.stubbed.length;
console.log(`\nCohort touched: ${touched} venue(s). Until-midnight kept: ${report.untouchedMidnight.length}.`);

if (!apply) {
  console.log('Report only — pass --apply to write.');
  process.exit(0);
}

writeJson(HAPPY_HOURS_PATH, venues);
console.log(`Wrote ${HAPPY_HOURS_PATH}`);
