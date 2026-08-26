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

async function main() {
  const withHappyHour = readJson(WITH_HH_PATH);
  if (!withHappyHour?.places) {
    console.error('No happy hour data. Run npm run import:venues:extract first.');
    process.exit(1);
  }

  const existing = readJson(HAPPY_HOURS_PATH, []);
  let nextId = existing.reduce((max, venue) => Math.max(max, venue.id || 0), 0) + 1;

  const candidates = Object.values(withHappyHour.places)
    .filter((place) => place.hasHappyHour && place.happyHour)
    .sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));

  const { kept, skipped } = dedupeRecords(candidates, existing);
  const capped = kept.slice(0, MAX_IMPORT);

  const staging = [];
  const rejected = [];

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
  });

  console.log(`Staged ${staging.length} venues → ${STAGING_PATH}`);
  console.log(`  Skipped as duplicates of existing: ${skipped.length}`);
  console.log(`  Rejected during normalization: ${rejected.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
