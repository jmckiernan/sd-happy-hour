#!/usr/bin/env node
// Offers transcribed by hand off a venue's own happy-hour block.
//
// `recover-empty-listings.mjs` proposes what the regex extractor can read, and
// on a handful of sites it reads the wrong block: it returned the neighbouring
// weekly special while the happy-hour list sat two lines above it, or it
// returned the whole list run together as one 90-character chip. The offers are
// plainly there and legible, so they are transcribed here instead, the same way
// the previous pass transcribed the last three menu flyers.
//
// The rules this file is written under:
//
//   * Each chip is quoted from the page, not summarised. Capitalisation is
//     normalised and nothing else; no price, item or day is changed.
//   * `sourceQuote` is the venue's own happy-hour block, verbatim and whole,
//     so a reader can check every chip against it without visiting the site.
//   * Where the block lists more than the six-chip cap, chips are a subset of
//     it in the venue's own words. A subset is not a summary.
//
// Usage:
//   node scripts/import-google-venues/transcribe-window-only-offers.mjs
//   node scripts/import-google-venues/transcribe-window-only-offers.mjs --apply

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { inferDealTypes } from './lib/normalize.mjs';

const TRANSCRIPTIONS = [
  {
    id: 660,
    name: 'Mina Lounge',
    sourceUrl: 'http://www.minalounge.com/',
    observedAt: '2026-08-31',
    sourceQuote: 'HAPPY HOUR MONDAY - FRIDAY 12-5pm $10 OFF ALL HOOKAHS 20% OFF WINE BOTTLES '
      + '$4 TEA $5 COFFEE DRINKS $7 WELL SHOTS $7 RED OR WHITE SANGRIA $7 DRAFT BEER $7 HOUSE WINE',
    deals: [
      '$10 off all hookahs',
      '20% off wine bottles',
      '$7 draft beer',
      '$7 house wine',
      '$7 well shots',
      '$4 tea',
    ],
  },
  {
    id: 670,
    name: 'Shanghai Bun Chinese Tapas Bar',
    sourceUrl: 'https://www.shanghaibunsd.com/promotion/',
    observedAt: '2026-08-31',
    sourceQuote: 'Happy Hour 3PM – 6PM Monday-Friday * Minimum one beverage purchase required. '
      + "$2 Off All Draft Beer $6 Well Drinks / House Wine $8 Tito's / Hornitos "
      + '$9 Jack Daniels / Jameson $4-6 Popular Chinese Tapas $5 Bottle of Selected Wine',
    deals: [
      '$2 off all draft beer',
      '$6 well drinks / house wine',
      '$4-6 popular Chinese tapas',
      "$8 Tito's / Hornitos",
      '$9 Jack Daniels / Jameson',
      '$5 bottle of selected wine',
    ],
  },
];

const apply = process.argv.includes('--apply');
const venues = readJson(HAPPY_HOURS_PATH, []);
const byId = new Map(venues.map((venue) => [venue.id, venue]));
let written = 0;

for (const row of TRANSCRIPTIONS) {
  const venue = byId.get(row.id);
  if (!venue) {
    console.log(`  ! ${row.name} (${row.id}) is no longer in the catalog`);
    continue;
  }
  if ((venue.deals || []).length) {
    console.log(`  · ${venue.name} (${venue.id}) already has offers — left alone`);
    continue;
  }
  console.log(`  ${apply ? '+' : '?'} ${venue.name} (${venue.id}) ${row.deals.join(' · ')}`);
  if (!apply) continue;

  venue.deals = row.deals;
  venue.dealsUnknown = false;
  venue.dealTypes = inferDealTypes(row.deals, venue);
  venue.hhSources = {
    ...(venue.hhSources || {}),
    deals: {
      source: 'website_hh_page',
      url: row.sourceUrl,
      observedAt: row.observedAt,
      evidence: [{ url: row.sourceUrl, quote: row.sourceQuote, field: 'deals' }],
    },
  };
  written += 1;
}

if (!apply) {
  console.log('\nReport only — pass --apply to write.');
  process.exit(0);
}

writeJson(HAPPY_HOURS_PATH, venues);
console.log(`\nTranscribed offers onto ${written} listing(s) in ${HAPPY_HOURS_PATH}`);
