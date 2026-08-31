#!/usr/bin/env node
// Fetch Google Place Details for discovered candidates and apply rating filters.
//
// Usage:
//   GOOGLE_PLACES_API_KEY=... npm run import:venues:enrich
//   npm run import:venues:enrich -- --limit=20

import { MIN_RATING, MIN_REVIEWS, ENRICHED_PATH, CANDIDATES_PATH } from './lib/constants.mjs';
import { placeDetails, placeIdKey, displayName } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { classifyCounty } from './lib/county.mjs';
import { isBlockedChain } from './lib/chain-blocklist.mjs';
import { isExcludedCategory } from './lib/category-rules.mjs';

/**
 * Re-apply the quality bar to details we already hold.
 *
 * `qualified` is computed when details are fetched, so lowering the rating or
 * review minimum leaves thousands of cached places stamped with the old
 * verdict. Recomputing costs nothing — the Places calls are already paid for.
 */
function requalify() {
  const store = readJson(ENRICHED_PATH, { places: {}, meta: {} });
  const places = store.places || {};
  let changed = 0;

  for (const place of Object.values(places)) {
    const status = place.businessStatus || 'OPERATIONAL';
    const county = classifyCounty(place);
    const qualified =
      status === 'OPERATIONAL' &&
      (place.rating ?? 0) >= MIN_RATING &&
      (place.userRatingCount ?? 0) >= MIN_REVIEWS &&
      county.inCounty;
    if (qualified !== place.qualified) changed += 1;
    place.qualified = qualified;
    place.county = county.county;
  }

  const total = Object.values(places).filter((place) => place.qualified).length;
  writeJson(ENRICHED_PATH, { ...store, places });
  console.log(`Requalified ${Object.keys(places).length} cached places against ${MIN_RATING}★ / ${MIN_REVIEWS} reviews.`);
  console.log(`  ${changed} verdicts changed; ${total} now qualified.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes('--requalify')) {
    requalify();
    return;
  }
  const candidates = readJson(CANDIDATES_PATH);
  if (!candidates?.places) {
    console.error('No candidates found. Run npm run import:venues:discover first.');
    process.exit(1);
  }

  const existing = readJson(ENRICHED_PATH, { places: {}, meta: {} });
  const enriched = existing.places || {};
  // Discovery already returns rating and review count, so a candidate that
  // cannot clear the bar never needs a details call — and details are the
  // priciest SKU we touch. Skipping them here is the difference between paying
  // for every place Google mentions and paying only for plausible ones.
  const ids = Object.keys(candidates.places)
    .filter((id) => {
      const place = candidates.places[id];
      if ((place.businessStatus || 'OPERATIONAL') !== 'OPERATIONAL') return false;
      // Discovery returns the name, so we can drop the McDonald's and Starbucks
      // of the world before paying for details we would only throw away.
      if (isBlockedChain(displayName(place))) return false;
      // Discovery returns primaryType too, so the 7-Elevens and grocery stores
      // cost nothing to recognise either. A brand list never catches the long
      // tail of one-off convenience stores; the category does.
      if (isExcludedCategory(place.primaryType, displayName(place))) return false;
      if (place.rating == null && place.userRatingCount == null) return true;
      return (place.rating ?? 0) >= MIN_RATING && (place.userRatingCount ?? 0) >= MIN_REVIEWS;
    })
    .sort((a, b) => (candidates.places[b].userRatingCount || 0) - (candidates.places[a].userRatingCount || 0));

  const prefiltered = Object.keys(candidates.places).length - ids.length;
  if (prefiltered) console.log(`Skipping ${prefiltered} candidates below ${MIN_RATING}★ / ${MIN_REVIEWS} reviews before paying for details.`);
  const todo = options.limit ? ids.slice(0, options.limit) : ids;

  console.log(`Enriching ${todo.length} candidates (rating ≥ ${MIN_RATING}, reviews ≥ ${MIN_REVIEWS})...`);

  let fetched = 0;
  let passed = 0;
  let outOfCounty = 0;
  for (const id of todo) {
    if (options.resume && enriched[id]?.detailsFetchedAt) continue;
    fetched += 1;
    try {
      const details = await placeDetails(id);
      const rating = details.rating ?? 0;
      const reviews = details.userRatingCount ?? 0;
      const status = details.businessStatus || 'OPERATIONAL';
      // The search grid is a rectangle that overlaps Orange and Riverside
      // counties; Google's own county component is what actually decides.
      const county = classifyCounty(details);
      if (!county.inCounty) outOfCounty += 1;
      const qualified = status === 'OPERATIONAL'
        && rating >= MIN_RATING
        && reviews >= MIN_REVIEWS
        && county.inCounty;
      if (qualified) passed += 1;
      enriched[id] = {
        ...details,
        googlePlaceId: placeIdKey(details),
        displayName: displayName(details),
        county: county.county,
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
      rejectedOutOfCounty: outOfCounty,
    },
    places: enriched,
  });

  console.log(`Done. ${qualifiedCount} qualified venues in ${ENRICHED_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
