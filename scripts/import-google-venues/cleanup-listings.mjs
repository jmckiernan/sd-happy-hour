#!/usr/bin/env node
// Clean deal text in happy-hours.json: decode entities, dedupe, replace placeholders.
//
// Usage: npm run import:venues:cleanup

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { finalizeDeals, needsDealRefresh } from './lib/deals.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const venues = readJson(HAPPY_HOURS_PATH, []);
let cleaned = 0;
let fallback = 0;

for (const venue of venues) {
  const before = venue.deals?.join('|') || '';
  venue.deals = finalizeDeals(venue.deals || []);
  const after = venue.deals.join('|');
  if (before !== after) cleaned += 1;
  if (venue.deals.length === 1 && venue.deals[0] === 'Happy hour') fallback += 1;
}

writeJson(HAPPY_HOURS_PATH, venues);
console.log(`Cleaned deals on ${cleaned}/${venues.length} venues (${fallback} now use the "Happy hour" fallback).`);

const stillNeedRefresh = venues.filter((venue) => needsDealRefresh(venue.deals));
console.log(`${stillNeedRefresh.length} venues may benefit from npm run import:venues:refresh-deals.`);
