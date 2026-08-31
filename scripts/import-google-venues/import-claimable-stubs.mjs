#!/usr/bin/env node
// Give every qualifying San Diego County venue a page its owner can claim,
// whether or not we found a happy hour for it.
//
// The happy-hour pipeline only ever merged venues it could substantiate a
// window for, so an owner searching the restaurant dashboard for a spot we
// know about but have no deal for found nothing to claim. This backfills those
// as unlisted stubs: a page exists and the claim search finds it, but it stays
// off browse surfaces and out of the sitemap until there is a happy hour.
//
// Costs nothing to run — every place here was already enriched.
//
// Usage:
//   npm run import:stubs -- --dry-run
//   npm run import:stubs

import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH, ENRICHED_PATH, ROOT_DIR } from './lib/constants.mjs';
import { normalizeStubVenue, stripImportMeta } from './lib/normalize.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { classifyCounty } from './lib/county.mjs';
import { isCorporateFastFood } from './lib/chain-blocklist.mjs';
import { createVenueIdAllocator } from './lib/venue-ids.mjs';

const MIN_RATING = 4.0;
const MIN_REVIEWS = 10;

function placeIdOf(record) {
  return record.googlePlaceId || String(record.id || '').replace(/^places\//, '');
}

/** Same place, listed twice? Google ids differ across a re-listing, so a
 * street address at the same name is treated as the venue we already have. */
function addressKey(name, address) {
  return `${name}|${String(address || '').split(',')[0]}`
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const enriched = readJson(ENRICHED_PATH)?.places || {};
  const existing = readJson(HAPPY_HOURS_PATH, []);

  const knownIds = new Set(existing.map((venue) => venue.placeId).filter(Boolean));
  const knownAddresses = new Set(existing.map((venue) => addressKey(venue.name, venue.address)));

  const skipped = { belowBar: 0, outOfCounty: 0, fastFood: 0, alreadyListed: 0, unusable: 0 };
  const venueIds = createVenueIdAllocator(existing);
  const stubs = [];

  for (const record of Object.values(enriched)) {
    if ((record.rating || 0) < MIN_RATING || (record.userRatingCount || 0) < MIN_REVIEWS) {
      skipped.belowBar += 1;
      continue;
    }
    if (!classifyCounty(record).inCounty) {
      skipped.outOfCounty += 1;
      continue;
    }

    const placeId = placeIdOf(record);
    const name = record.displayName?.text || record.displayName || record.name || '';
    // A franchise never claims its own listing, so a stub for one is dead weight.
    if (isCorporateFastFood(name)) {
      skipped.fastFood += 1;
      continue;
    }
    if (knownIds.has(placeId) || knownAddresses.has(addressKey(name, record.formattedAddress))) {
      skipped.alreadyListed += 1;
      continue;
    }

    const stub = normalizeStubVenue(record, venueIds.peek());
    if (!stub) {
      skipped.unusable += 1;
      continue;
    }
    stub.placeId = placeId;

    // Two enriched records can share a storefront; keep the first.
    knownIds.add(placeId);
    knownAddresses.add(addressKey(stub.name, stub.address));
    stubs.push(stub);
    venueIds.take();
  }

  console.log(`Enriched places: ${Object.keys(enriched).length}`);
  console.log(`  below ${MIN_RATING}★/${MIN_REVIEWS} reviews: ${skipped.belowBar}`);
  console.log(`  outside San Diego County: ${skipped.outOfCounty}`);
  console.log(`  corporate fast food: ${skipped.fastFood}`);
  console.log(`  already in the catalog: ${skipped.alreadyListed}`);
  console.log(`  missing address or coordinates: ${skipped.unusable}`);
  console.log(`Claimable stubs: ${stubs.length}`);

  if (options.dryRun) {
    console.log('\nDry run. Sample:');
    for (const stub of stubs.slice(0, 8)) {
      console.log(`  - ${stub.name} (${stub.neighborhood}) · ${stub.address}`);
    }
    return;
  }

  writeJson(HAPPY_HOURS_PATH, [...existing, ...stubs.map(stripImportMeta)]);
  console.log(`Wrote ${existing.length + stubs.length} listings to ${HAPPY_HOURS_PATH}.`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed after import. Review happy-hours.json and fix errors.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
