#!/usr/bin/env node
// Stamp `placeId` on catalog rows that never got one, by matching against the
// local Google caches (enriched + candidates). No Places API calls — the IDs
// are already paid for and sitting on disk.
//
// Match rule is deliberately narrow: exact normalized name AND nearest
// candidate within ~1.1 km (0.01°). Anything that fails either gate stays
// unmatched. Guessing a near-name or a far pin would attach the wrong venue's
// Atmosphere answers to a page, so leftovers are reported rather than forced.
//
// Usage:
//   node scripts/import-google-venues/link-place-ids.mjs --dry-run
//   node scripts/import-google-venues/link-place-ids.mjs

import {
  CANDIDATES_PATH,
  ENRICHED_PATH,
  HAPPY_HOURS_PATH,
} from './lib/constants.mjs';
import {
  buildPlaceLookup,
  findPlaceForVenue,
  placeIdFor,
  placeCoords,
  distanceDegrees,
  normalizePlaceName,
} from './lib/match-places.mjs';
import { displayName } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

/** Degrees. Same default as photo matching; ~1.1 km at San Diego latitude. */
const MAX_DISTANCE = 0.01;

function loadPlaces() {
  const enriched = readJson(ENRICHED_PATH, { places: {} });
  const candidates = readJson(CANDIDATES_PATH, { places: {} });
  // Prefer enriched records when both caches hold the same id — they carry
  // fuller address/coord fields from Place Details.
  const byId = new Map();
  for (const place of Object.values(candidates.places || {})) {
    const id = placeIdFor(place);
    if (id) byId.set(id, place);
  }
  for (const place of Object.values(enriched.places || {})) {
    const id = placeIdFor(place);
    if (id) byId.set(id, place);
  }
  return [...byId.values()];
}

function unmatchedReason(venue, lookup) {
  const name = normalizePlaceName(venue.name);
  const candidates = lookup.get(name) || [];
  if (!candidates.length) return 'no-name-match';
  return 'distance';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = readJson(HAPPY_HOURS_PATH);
  if (!Array.isArray(rows)) {
    console.error(`Expected an array of venues at ${HAPPY_HOURS_PATH}`);
    process.exit(1);
  }

  const places = loadPlaces();
  const lookup = buildPlaceLookup(places);
  const missing = rows.filter((row) => !row.placeId);

  const linked = [];
  const leftovers = [];

  const updated = rows.map((row) => {
    if (row.placeId) return row;
    const place = findPlaceForVenue(row, lookup, MAX_DISTANCE);
    const placeId = place ? placeIdFor(place) : null;
    if (!placeId) {
      leftovers.push({
        id: row.id,
        name: row.name,
        listingStatus: row.listingStatus || null,
        seoHidden: !!row.seoHidden,
        reason: unmatchedReason(row, lookup),
      });
      return row;
    }

    const { lat, lng } = placeCoords(place);
    const distance = distanceDegrees(row.lat, row.lng, lat, lng);
    linked.push({
      id: row.id,
      name: row.name,
      placeId,
      distance,
      listingStatus: row.listingStatus || null,
      seoHidden: !!row.seoHidden,
      placeName: displayName(place),
    });
    return { ...row, placeId };
  });

  const publishedLinked = linked.filter((row) => row.listingStatus === 'published');
  const publishedVisible = publishedLinked.filter((row) => !row.seoHidden);
  const publishedLeftovers = leftovers.filter((row) => row.listingStatus === 'published');

  console.log(`Catalog rows:              ${rows.length}`);
  console.log(`  missing placeId:         ${missing.length}`);
  console.log(`  linked this run:         ${linked.length}`);
  console.log(`    published:             ${publishedLinked.length}`);
  console.log(`    published, visible:    ${publishedVisible.length}`);
  console.log(`  leftovers:               ${leftovers.length}`);
  console.log(`    published leftovers:   ${publishedLeftovers.length}`);
  console.log(`Match rate:                ${missing.length ? ((linked.length / missing.length) * 100).toFixed(1) : '100.0'}%`);

  if (leftovers.length) {
    console.log('\nLeftovers (not stamped):');
    for (const row of leftovers) {
      const flags = [
        row.listingStatus || 'no-status',
        row.seoHidden ? 'seoHidden' : null,
        row.reason,
      ].filter(Boolean).join(', ');
      console.log(`  - ${row.name} (#${row.id}) [${flags}]`);
    }
  }

  if (options.dryRun) {
    console.log('\nDry run: catalog not written.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, updated);
  console.log(`\nWrote ${HAPPY_HOURS_PATH}`);
}

main();
