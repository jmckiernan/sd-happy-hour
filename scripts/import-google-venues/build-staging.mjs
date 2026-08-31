#!/usr/bin/env node
// Rank happy-hour venues and build import staging JSON.
//
// Usage:
//   npm run import:venues:stage

import { MAX_IMPORT, STAGING_PATH, WITH_HH_PATH, HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { dedupeRecords } from './lib/dedupe.mjs';
import { normalizeVenue } from './lib/normalize.mjs';
import { displayName } from './lib/google-places.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { classifyCounty } from './lib/county.mjs';
import { isCorporateFastFood } from './lib/chain-blocklist.mjs';

async function main() {
  const withHappyHour = readJson(WITH_HH_PATH);
  if (!withHappyHour?.places) {
    console.error('No happy hour data. Run npm run import:venues:extract first.');
    process.exit(1);
  }

  const existing = readJson(HAPPY_HOURS_PATH, []);
  let nextId = existing.reduce((max, venue) => Math.max(max, venue.id || 0), 0) + 1;

  // Also checked at enrich time, but the cache predates that filter and still
  // marks Orange and Riverside County places as qualified, so staging would
  // happily re-add the venues audit:county just unlisted.
  const candidates = Object.values(withHappyHour.places)
    .filter((place) => place.hasHappyHour && place.happyHour)
    .filter((place) => classifyCounty(place).inCounty)
    // A "happy hour" on one of these is always a misread — a Starbucks reached
    // the live site with a 09:00 window before this filter existed.
    .filter((place) => !isCorporateFastFood(displayName(place)))
    .sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));

  const { kept, upgrades, skipped } = dedupeRecords(candidates, existing);
  const capped = kept.slice(0, MAX_IMPORT);

  const staging = [];
  const rejected = [];
  const stagedUpgrades = [];

  // A stub already on the site that we have now found a happy hour for. Only
  // the happy-hour fields move across; the venue keeps its id, so anything
  // already pointing at that page — including a pending claim — still resolves.
  for (const { record, venue } of upgrades) {
    // The candidate filter above tests the Google display name; a stub carrying
    // the brand under a different catalog name would otherwise be published.
    if (isCorporateFastFood(venue.name)) {
      rejected.push({ name: venue.name, reason: 'corporate-fast-food' });
      continue;
    }
    const normalized = normalizeVenue(record, venue.id);
    if (!normalized) {
      rejected.push({ name: displayName(record), reason: 'normalization-failed' });
      continue;
    }
    stagedUpgrades.push({
      id: venue.id,
      name: venue.name,
      days: normalized.days,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      deals: normalized.deals,
      dealsUnknown: normalized.dealsUnknown,
      dealTypes: normalized.dealTypes,
      hasHappyHourData: true,
      listingStatus: normalized.listingStatus,
      seoHidden: normalized.seoHidden,
      sourceUrl: normalized.sourceUrl,
      website: venue.website || normalized.website,
      confidence: normalized._import.happyHourConfidence,
      source: normalized._import.happyHourSource,
    });
  }

  for (const record of capped) {
    const normalized = normalizeVenue(record, nextId);
    if (!normalized) {
      rejected.push({ name: displayName(record), reason: 'normalization-failed' });
      continue;
    }
    staging.push(normalized);
    nextId += 1;
  }

  writeJson(STAGING_PATH, {
    meta: {
      builtAt: new Date().toISOString(),
      maxImport: MAX_IMPORT,
      candidateCount: candidates.length,
      dedupedCount: kept.length,
      stagedCount: staging.length,
      upgradeCount: stagedUpgrades.length,
      skippedExisting: skipped.length,
      rejected: rejected.length,
      byConfidence: {
        high: staging.filter((venue) => venue._import.happyHourConfidence === 'high').length,
        medium: staging.filter((venue) => venue._import.happyHourConfidence === 'medium').length,
        low: staging.filter((venue) => venue._import.happyHourConfidence === 'low').length,
      },
      bySource: {
        google: staging.filter((venue) => venue._import.happyHourSource === 'google').length,
        website: staging.filter((venue) => venue._import.happyHourSource === 'website').length,
      },
    },
    skipped,
    rejected,
    venues: staging,
    upgrades: stagedUpgrades,
  });

  console.log(`Staged ${staging.length} new venues → ${STAGING_PATH}`);
  console.log(`  Upgrades to existing claimable stubs: ${stagedUpgrades.length}`);
  console.log(`  Skipped as duplicates of existing: ${skipped.length}`);
  console.log(`  Rejected during normalization: ${rejected.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
