#!/usr/bin/env node
// Fetch Google Place Details for discovered candidates and apply rating filters.
//
// Usage:
//   GOOGLE_PLACES_API_KEY=... npm run import:venues:enrich
//   npm run import:venues:enrich -- --limit=20

import { MIN_RATING, MIN_REVIEWS, ENRICHED_PATH, CANDIDATES_PATH } from './lib/constants.mjs';
import { placeDetails, placeIdKey, displayName } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = readJson(CANDIDATES_PATH);
  if (!candidates?.places) {
    console.error('No candidates found. Run npm run import:venues:discover first.');
    process.exit(1);
  }

  const existing = readJson(ENRICHED_PATH, { places: {}, meta: {} });
  const enriched = existing.places || {};
  const ids = Object.keys(candidates.places)
    .sort((a, b) => (candidates.places[b].userRatingCount || 0) - (candidates.places[a].userRatingCount || 0));
  const todo = options.limit ? ids.slice(0, options.limit) : ids;

  console.log(`Enriching ${todo.length} candidates (rating ≥ ${MIN_RATING}, reviews ≥ ${MIN_REVIEWS})...`);

  let fetched = 0;
  let passed = 0;
  for (const id of todo) {
    if (options.resume && enriched[id]?.detailsFetchedAt) continue;
    fetched += 1;
    try {
      const details = await placeDetails(id);
      const rating = details.rating ?? 0;
      const reviews = details.userRatingCount ?? 0;
      const status = details.businessStatus || 'OPERATIONAL';
      const qualified = status === 'OPERATIONAL' && rating >= MIN_RATING && reviews >= MIN_REVIEWS;
      if (qualified) passed += 1;
      enriched[id] = {
        ...details,
        googlePlaceId: placeIdKey(details),
        displayName: displayName(details),
        qualified,
        detailsFetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.warn(`Details failed for ${id}:`, error.message);
      enriched[id] = {
        ...(enriched[id] || candidates.places[id]),
        googlePlaceId: id,
        qualified: false,
        detailsError: error.message,
        detailsFetchedAt: new Date().toISOString(),
      };
    }

    if (fetched % 25 === 0) {
      writeJson(ENRICHED_PATH, {
        meta: { updatedAt: new Date().toISOString(), fetched, passedFilter: passed },
        places: enriched,
      });
      console.log(`  … enriched ${fetched}, ${passed} passed quality filter`);
    }
  }

  const qualifiedCount = Object.values(enriched).filter((place) => place.qualified).length;
  writeJson(ENRICHED_PATH, {
    meta: {
      updatedAt: new Date().toISOString(),
      total: Object.keys(enriched).length,
      qualified: qualifiedCount,
      minRating: MIN_RATING,
      minReviews: MIN_REVIEWS,
    },
    places: enriched,
  });

  console.log(`Done. ${qualifiedCount} qualified venues in ${ENRICHED_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
