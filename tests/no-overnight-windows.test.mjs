#!/usr/bin/env node
// Catalog must not contain overnight or end-before-start happy hour windows.
// Ending at midnight (endTime === '00:00') is the until-midnight sentinel and is allowed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOvernightOrSwappedWindow, isPlausibleHappyHourWindow } from '../scripts/import-google-venues/lib/schedule-windows.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const venues = JSON.parse(fs.readFileSync(path.join(root, 'public/data/happy-hours.json'), 'utf8'));

const offenders = [];
for (const venue of venues) {
  const windows = Array.isArray(venue.windows) && venue.windows.length
    ? venue.windows
    : (venue.startTime && venue.endTime
      ? [{ days: venue.days || ['Monday'], startTime: venue.startTime, endTime: venue.endTime, allDay: venue.allDay }]
      : []);
  for (const w of windows) {
    if (!w.startTime || !w.endTime) continue;
    if (isOvernightOrSwappedWindow(w.startTime, w.endTime)) {
      offenders.push(`${venue.id} ${venue.name}: ${w.startTime}-${w.endTime}`);
    }
  }
}

assert.equal(offenders.length, 0, `overnight/swapped windows still in catalog:\n${offenders.join('\n')}`);

assert.equal(isPlausibleHappyHourWindow({ days: ['Friday'], startTime: '22:00', endTime: '02:00' }), false);
assert.equal(isPlausibleHappyHourWindow({ days: ['Friday'], startTime: '19:00', endTime: '18:00' }), false);
assert.equal(isPlausibleHappyHourWindow({ days: ['Friday'], startTime: '22:00', endTime: '00:00' }), true);

console.log(`ok - no overnight windows across ${venues.length} listings`);
