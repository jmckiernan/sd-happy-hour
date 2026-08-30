#!/usr/bin/env node
// Find catalog venues outside San Diego County and unlist them.
//
// The search grid is a rectangle (`COUNTY_BOUNDS`) that overlaps Orange and
// Riverside counties, so San Clemente and Temecula venues were imported and
// published on a San Diego site. County comes from Google's own
// `administrative_area_level_2`, with a city-name fallback for the cached
// places Google returned without one.
//
// Unlisted rather than deleted: the venue page stays reachable and claimable,
// but it leaves browse, the map, and the sitemap.
//
// Usage:
//   npm run audit:county            # dry run
//   npm run audit:county -- --apply

import { HAPPY_HOURS_PATH, ENRICHED_PATH } from './lib/constants.mjs';
import { readJson, writeJson, parseArgs } from './lib/io.mjs';
import { classifyCounty, SAN_DIEGO_COUNTY } from './lib/county.mjs';

function main() {
  const options = parseArgs(process.argv.slice(2));
  const apply = process.argv.includes('--apply');
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const enriched = readJson(ENRICHED_PATH, { places: {} }).places || {};

  const byPlaceId = new Map();
  for (const place of Object.values(enriched)) {
    const key = place.googlePlaceId || place.id;
    if (key) byPlaceId.set(key, place);
  }

  const offenders = [];
  for (const venue of venues) {
    const place = venue.placeId ? byPlaceId.get(venue.placeId) : null;
    const verdict = classifyCounty(place, venue.address);
    if (verdict.inCounty) continue;
    offenders.push({ venue, ...verdict });
  }

  if (!offenders.length) {
    console.log(`All ${venues.length} venues are in ${SAN_DIEGO_COUNTY}.`);
    return;
  }

  const byCounty = {};
  const byBasis = {};
  for (const row of offenders) {
    const label = row.county || 'unknown (matched by city)';
    byCounty[label] = (byCounty[label] || 0) + 1;
    byBasis[row.basis] = (byBasis[row.basis] || 0) + 1;
  }

  console.log(`${offenders.length} of ${venues.length} venues are outside ${SAN_DIEGO_COUNTY}:`);
  for (const [county, count] of Object.entries(byCounty)) console.log(`  ${county}: ${count}`);
  console.log(`  determined by: ${Object.entries(byBasis).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  const published = offenders.filter((row) => row.venue.listingStatus === 'published');
  console.log(`\n${published.length} of them are currently published:`);
  for (const row of published.slice(0, options.limit || 60)) {
    console.log(`  ${row.venue.id} ${row.venue.name} — ${row.venue.address}`);
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to unlist them.');
    return;
  }

  let changed = 0;
  for (const row of offenders) {
    if (row.venue.listingStatus !== 'published') continue;
    row.venue.listingStatus = 'unlisted';
    row.venue.seoHidden = true;
    row.venue.unlistedReason = 'outside_san_diego_county';
    changed += 1;
  }
  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`\nUnlisted ${changed} out-of-county venues.`);
}

main();
