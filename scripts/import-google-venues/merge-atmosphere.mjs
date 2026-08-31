#!/usr/bin/env node
// Fold the bought Atmosphere responses into the published catalog.
//
// The capture run (backfill-atmosphere.mjs) deliberately landed raw responses
// in their own store so a long paid job could not lose a concurrent write to
// the catalog. This is the other half: read that store, map the fields we have
// decided to publish, and write them onto the matching catalog rows.
//
// Only the amenity keys are touched. Everything else on a row belongs to other
// parts of the pipeline, and this script runs in a tree several agents share.
//
// Usage:
//   node scripts/import-google-venues/merge-atmosphere.mjs --dry-run
//   node scripts/import-google-venues/merge-atmosphere.mjs

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { atmosphereAmenities } from './lib/normalize.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { ATMOSPHERE_PATH } from './backfill-atmosphere.mjs';

/** Every amenity key this script owns, so a re-run replaces rather than merges. */
const OWNED_KEYS = [
  'outdoorSeating', 'allowsDogs', 'reservable', 'liveMusic', 'restroom',
  'goodForGroups', 'goodForWatchingSports', 'servesVegetarianFood',
  'parkingOptions', 'paymentOptions', 'accessibilityOptions',
  'priceLevel', 'priceRange',
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  const store = readJson(ATMOSPHERE_PATH, { places: {} });
  const rows = readJson(HAPPY_HOURS_PATH);
  if (!Array.isArray(rows)) {
    console.error(`Expected an array of venues at ${HAPPY_HOURS_PATH}`);
    process.exit(1);
  }

  let matched = 0;
  let unmatched = 0;
  const fieldCounts = new Map();

  const updated = rows.map((row) => {
    // Five venues are listed twice under one place id. Both rows read the same
    // response, which is why the capture deduplicated and this does not.
    const captured = row.placeId ? store.places[row.placeId] : null;
    if (!captured) {
      if (row.placeId) unmatched += 1;
      return row;
    }
    matched += 1;

    const amenities = atmosphereAmenities(captured);
    for (const key of Object.keys(amenities)) {
      fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
    }

    // Strip first, then reapply. A key Google stopped answering has to
    // disappear rather than linger as a stale claim from an earlier run.
    const next = { ...row };
    for (const key of OWNED_KEYS) delete next[key];
    return { ...next, ...amenities };
  });

  console.log(`Catalog rows:      ${rows.length}`);
  console.log(`  matched:         ${matched}`);
  console.log(`  placeId, no data:${unmatched}`);
  console.log('\nFields written:');
  for (const [field, count] of [...fieldCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${((count / rows.length) * 100).toFixed(1).padStart(5)}%  ${field}`);
  }

  if (options.dryRun) {
    console.log('\nDry run: catalog not written.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, updated);
  console.log(`\nWrote ${HAPPY_HOURS_PATH}`);
}

main();
