#!/usr/bin/env node
// Discover venues by subdividing only where Google truncates.
//
// Nearby Search returns at most 20 results, ranked by popularity. The fixed
// grid asks 529 circles of 2.8km, and every dense one comes back with exactly
// 20 — Gaslamp, North Park and Pacific Beach all cap on restaurants, bars and
// cafes, and even rural Ramona caps on restaurants. So the catalog is really
// "the ~20 most popular per type per circle", which is precisely the wrong
// bias: it drops the small independents most likely to run a good happy hour.
//
// A uniformly smaller radius would fix it and cost a fortune, because most of
// the county is empty and would be searched at the same fine resolution as the
// Gaslamp. Instead: a full response (20 results) is evidence of truncation, so
// split that square into four and search again. A short response proves the
// area is exhausted, so stop. Cost then tracks venue density rather than area.
//
// Usage:
//   npm run discover:adaptive -- --max-calls=200      # probe, cheap
//   npm run discover:adaptive -- --max-calls=4000
//   npm run discover:adaptive -- --min-radius=150
//
// --max-calls is a hard budget. Places calls are billed and this recurses.

import { COUNTY_BOUNDS, SEARCH_TYPES, CANDIDATES_PATH } from './lib/constants.mjs';
import { nearbySearch, placeIdKey, displayName } from './lib/google-places.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const PAGE_SIZE = 20;
const START_STEP = 0.045;

function argValue(flag, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${flag}=`));
  return raw ? Number(raw.split('=')[1]) : fallback;
}

/** Radius covering the whole square, so subdividing never leaves a hole. */
function coveringRadius(square) {
  const midLat = (square.minLat + square.maxLat) / 2;
  const latMeters = (square.maxLat - square.minLat) * 111_320;
  const lngMeters = (square.maxLng - square.minLng) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  return Math.sqrt(latMeters ** 2 + lngMeters ** 2) / 2;
}

function centerOf(square) {
  return {
    lat: (square.minLat + square.maxLat) / 2,
    lng: (square.minLng + square.maxLng) / 2,
  };
}

function quarters(square) {
  const midLat = (square.minLat + square.maxLat) / 2;
  const midLng = (square.minLng + square.maxLng) / 2;
  return [
    { minLat: square.minLat, maxLat: midLat, minLng: square.minLng, maxLng: midLng },
    { minLat: square.minLat, maxLat: midLat, minLng: midLng, maxLng: square.maxLng },
    { minLat: midLat, maxLat: square.maxLat, minLng: square.minLng, maxLng: midLng },
    { minLat: midLat, maxLat: square.maxLat, minLng: midLng, maxLng: square.maxLng },
  ];
}

/** `--bbox=minLat,minLng,maxLat,maxLng`, for densifying one neighborhood. */
function boundsFromArgs() {
  const raw = process.argv.find((arg) => arg.startsWith('--bbox='))?.split('=')[1];
  if (!raw) return COUNTY_BOUNDS;
  const [minLat, minLng, maxLat, maxLng] = raw.split(',').map(Number);
  return { minLat, minLng, maxLat, maxLng };
}

function initialSquares(bounds, step = START_STEP) {
  const squares = [];
  for (let lat = bounds.minLat; lat < bounds.maxLat; lat += step) {
    for (let lng = bounds.minLng; lng < bounds.maxLng; lng += step) {
      squares.push({
        minLat: lat,
        maxLat: Math.min(lat + step, bounds.maxLat),
        minLng: lng,
        maxLng: Math.min(lng + step, bounds.maxLng),
      });
    }
  }
  return squares;
}

async function main() {
  const maxCalls = argValue('max-calls', 2000);
  const minRadius = argValue('min-radius', 120);

  const store = readJson(CANDIDATES_PATH, { places: {}, meta: {} });
  const places = store.places || {};
  const startCount = Object.keys(places).length;

  // One queue per type: a square that caps on "restaurant" says nothing about
  // whether it caps on "brewery", and subdividing both wastes calls.
  const queue = [];
  for (const square of initialSquares(boundsFromArgs())) {
    for (const includedType of SEARCH_TYPES) queue.push({ square, includedType, depth: 0 });
  }

  let calls = 0;
  let capped = 0;
  let floored = 0;
  let deepest = 0;

  console.log(`Adaptive discovery: ${queue.length} starting searches, budget ${maxCalls} calls.\n`);

  while (queue.length && calls < maxCalls) {
    const job = queue.shift();
    const radius = coveringRadius(job.square);
    const { lat, lng } = centerOf(job.square);

    let results;
    try {
      results = await nearbySearch({ lat, lng, radiusMeters: Math.max(radius, 50), includedType: job.includedType });
    } catch (error) {
      console.warn(`  search failed at ${lat.toFixed(4)},${lng.toFixed(4)} (${job.includedType}): ${error.message}`);
      continue;
    }
    calls += 1;
    deepest = Math.max(deepest, job.depth);

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
        primaryType: place.primaryType || job.includedType,
        discoveredAt: places[id]?.discoveredAt || new Date().toISOString(),
      };
    }

    // A full page means Google had more to give. Anything short is complete.
    if (results.length >= PAGE_SIZE) {
      capped += 1;
      if (radius / 2 >= minRadius) {
        for (const child of quarters(job.square)) {
          queue.push({ square: child, includedType: job.includedType, depth: job.depth + 1 });
        }
      } else {
        floored += 1;
      }
    }

    if (calls % 50 === 0) {
      writeJson(CANDIDATES_PATH, {
        meta: { ...store.meta, updatedAt: new Date().toISOString(), adaptiveCalls: calls },
        places,
      });
      console.log(
        `  ${calls} calls · ${Object.keys(places).length} places (+${Object.keys(places).length - startCount}) · ${queue.length} queued · depth ${deepest}`
      );
    }
  }

  writeJson(CANDIDATES_PATH, {
    meta: {
      ...store.meta,
      updatedAt: new Date().toISOString(),
      adaptiveCalls: calls,
      placeCount: Object.keys(places).length,
    },
    places,
  });

  const added = Object.keys(places).length - startCount;
  console.log('\n' + '='.repeat(64));
  console.log(`${calls} searches · ${added} new places · ${Object.keys(places).length} total`);
  console.log(`${capped} came back full and were subdivided; ${floored} hit the ${minRadius}m floor still full.`);
  console.log(`${queue.length} squares still queued${queue.length ? ' — budget ran out, re-run to continue' : ' (county exhausted)'}.`);
  console.log(`Yield: ${(added / Math.max(calls, 1)).toFixed(1)} new places per call.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
