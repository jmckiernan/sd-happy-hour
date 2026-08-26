#!/usr/bin/env node
// Grid-search Google Places across San Diego County for restaurant/bar candidates.
//
// Usage:
//   GOOGLE_PLACES_API_KEY=... npm run import:venues:discover
//   npm run import:venues:discover -- --limit=5   # smoke test (5 grid cells)

import { COUNTY_BOUNDS, DATA_DIR, SEARCH_TYPES, CANDIDATES_PATH } from './lib/constants.mjs';
import { nearbySearch, placeIdKey, displayName } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

function gridCenters(step = 0.045, radiusMeters = 2800) {
  const centers = [];
  for (let lat = COUNTY_BOUNDS.minLat + step / 2; lat <= COUNTY_BOUNDS.maxLat; lat += step) {
    for (let lng = COUNTY_BOUNDS.minLng + step / 2; lng <= COUNTY_BOUNDS.maxLng; lng += step) {
      centers.push({ lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), radiusMeters });
    }
  }
  return centers;
}

/** Populated areas for cheap smoke tests (avoid empty county-edge grid cells). */
const SMOKE_CENTERS = [
  { lat: 32.7157, lng: -117.1611, radiusMeters: 2800 },
  { lat: 32.7340, lng: -117.1290, radiusMeters: 2800 },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const smoke = process.argv.includes('--smoke');
  const centers = smoke ? SMOKE_CENTERS : gridCenters();
  const limitedCenters = options.limit ? centers.slice(0, options.limit) : centers;
  const existing = readJson(CANDIDATES_PATH, { places: {}, meta: {} });
  const places = existing.places || {};

  console.log(`Discovering across ${limitedCenters.length} grid cells × ${SEARCH_TYPES.length} types...`);

  let requests = 0;
  for (const center of limitedCenters) {
    for (const includedType of SEARCH_TYPES) {
      requests += 1;
      try {
        const results = await nearbySearch({ ...center, includedType });
        for (const place of results) {
          const id = placeIdKey(place);
          if (!id) continue;
          places[id] = {
            id,
            displayName: displayName(place),
            location: place.location,
            rating: place.rating ?? null,
            userRatingCount: place.userRatingCount ?? 0,
            businessStatus: place.businessStatus || 'OPERATIONAL',
            primaryType: place.primaryType || includedType,
            discoveredAt: places[id]?.discoveredAt || new Date().toISOString(),
          };
        }
      } catch (error) {
        console.warn(`Search failed at ${center.lat},${center.lng} (${includedType}):`, error.message);
      }
      if (requests % 20 === 0) {
        writeJson(CANDIDATES_PATH, {
          meta: {
            updatedAt: new Date().toISOString(),
            requests,
            placeCount: Object.keys(places).length,
          },
          places,
        });
        console.log(`  … ${Object.keys(places).length} unique places after ${requests} requests`);
      }
    }
  }

  writeJson(CANDIDATES_PATH, {
    meta: {
      updatedAt: new Date().toISOString(),
      requests,
      placeCount: Object.keys(places).length,
      gridCells: limitedCenters.length,
      types: SEARCH_TYPES,
    },
    places,
  });

  console.log(`Done. ${Object.keys(places).length} unique candidates saved to ${DATA_DIR}/candidates.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
