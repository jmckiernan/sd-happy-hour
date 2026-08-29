#!/usr/bin/env node
// Report which listings still lack a structured happy-hour menu (`hhMenu`).
//
// The goal is a transcribed menu for every venue that publishes one, so this
// splits the catalog into work to do vs. legitimately menu-less listings
// (times only, no offers published anywhere). Read-only.
//
// Usage:
//   npm run menus:audit
//   npm run menus:audit -- --list=missing        # ids, for --venue=
//   npm run menus:audit -- --list=missing --ids-only

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson } from './lib/io.mjs';
import { classifyMenuCoverage, MENU_COVERAGE_BUCKETS } from './lib/menu-coverage.mjs';

function parseAuditArgs(argv) {
  const options = { list: null, idsOnly: false, limit: 0 };
  for (const arg of argv) {
    if (arg.startsWith('--list=')) options.list = arg.slice(7);
    else if (arg === '--ids-only') options.idsOnly = true;
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8)) || 0;
  }
  return options;
}

function main() {
  const options = parseAuditArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const buckets = new Map(MENU_COVERAGE_BUCKETS.map((bucket) => [bucket, []]));

  for (const venue of venues) {
    buckets.get(classifyMenuCoverage(venue)).push(venue);
  }

  if (options.list) {
    const wanted = options.list === 'missing'
      ? ['no_menu', 'thin_menu', 'flyer_only']
      : options.list.split(',').map((part) => part.trim());
    let ids = wanted.flatMap((bucket) => (buckets.get(bucket) || []).map((venue) => venue.id));
    if (options.limit) ids = ids.slice(0, options.limit);
    if (options.idsOnly) {
      console.log(ids.join(','));
      return;
    }
    for (const bucket of wanted) {
      for (const venue of buckets.get(bucket) || []) {
        console.log(`${venue.id}\t${bucket}\t${venue.name} (${venue.neighborhood})`);
      }
    }
    console.log(`\n${ids.length} listing(s). Pass to --venue=`);
    return;
  }

  const total = venues.length;
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`${total} listings\n`);
  const labels = {
    good_menu: 'Transcribed menu (4+ items)',
    thin_menu: 'Menu present but thin (<4 items, or built from deal chips)',
    flyer_only: 'Scraped flyer, no structured menu',
    no_menu: 'Has offers published, but no menu extracted',
    times_only: 'Times only, no offers anywhere (nothing to transcribe)',
    unlisted: 'Unlisted / not public',
  };
  for (const bucket of MENU_COVERAGE_BUCKETS) {
    const rows = buckets.get(bucket);
    console.log(`  ${String(rows.length).padStart(4)}  ${pct(rows.length).padStart(6)}  ${labels[bucket]}`);
  }

  const work = ['no_menu', 'thin_menu', 'flyer_only'].reduce((n, bucket) => n + buckets.get(bucket).length, 0);
  console.log(`\nRe-scrape candidates: ${work}`);
  console.log('  npm run menus:audit -- --list=missing --ids-only');
}

main();
