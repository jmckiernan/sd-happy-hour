#!/usr/bin/env node
// Download Google Places photos and save them under public/images/venues/.
//
// Usage:
//   npm run import:venues:photos
//   npm run import:venues:photos -- --limit=25

import fs from 'node:fs/promises';
import path from 'node:path';
import { ENRICHED_PATH, HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { downloadPlacePhoto } from './lib/google-places.mjs';
import {
  buildPlaceLookup,
  findPlaceForVenue,
  placeIdFor,
} from './lib/match-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

const VENUE_IMAGE_DIR = path.join(ROOT_DIR, 'public', 'images', 'venues');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const enriched = readJson(ENRICHED_PATH, { places: {} });
  const lookup = buildPlaceLookup(Object.values(enriched.places || {}));

  const todo = venues.filter((venue) => !venue.image);
  const batch = options.limit ? todo.slice(0, options.limit) : todo;
  console.log(`Fetching photos for ${batch.length}/${todo.length} venues without images...`);

  await fs.mkdir(VENUE_IMAGE_DIR, { recursive: true });

  let attached = 0;
  let missing = 0;
  let failed = 0;
  for (const venue of batch) {
    const place = findPlaceForVenue(venue, lookup);
    const placeId = place ? placeIdFor(place) : null;
    if (!placeId) {
      missing += 1;
      continue;
    }
    try {
      const photo = await downloadPlacePhoto(placeId);
      if (!photo?.bytes?.length) {
        failed += 1;
        continue;
      }
      const ext = extensionFor(photo.contentType);
      const filename = `${venue.id}-${slugify(venue.name)}.${ext}`;
      const relativePath = `/images/venues/${filename}`;
      await fs.writeFile(path.join(VENUE_IMAGE_DIR, filename), photo.bytes);
      venue.image = relativePath;
      attached += 1;
      if (attached % 10 === 0) {
        writeJson(HAPPY_HOURS_PATH, venues);
        console.log(`  … ${attached} photos attached`);
      }
    } catch (error) {
      failed += 1;
      console.warn(`  ! ${venue.name}: ${error.message}`);
    }
  }

  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`Done. Attached ${attached} photos (${missing} unmatched, ${failed} failed).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
