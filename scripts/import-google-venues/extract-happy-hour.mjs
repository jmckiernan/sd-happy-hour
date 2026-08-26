#!/usr/bin/env node
// Resolve happy hour from Google secondary hours or venue website menus.
//
// Usage:
//   npm run import:venues:extract
//   npm run import:venues:extract -- --limit=10

import { ENRICHED_PATH, WITH_HH_PATH } from './lib/constants.mjs';
import { resolveHappyHour } from './lib/happy-hour.mjs';
import { displayName } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const enriched = readJson(ENRICHED_PATH);
  if (!enriched?.places) {
    console.error('No enriched data. Run npm run import:venues:enrich first.');
    process.exit(1);
  }

  const existing = readJson(WITH_HH_PATH, { places: {}, meta: {} });
  const output = existing.places || {};

  const qualified = Object.values(enriched.places).filter((place) => place.qualified);
  const todo = options.limit ? qualified.slice(0, options.limit) : qualified;

  console.log(`Extracting happy hour for ${todo.length} qualified venues...`);

  let checked = 0;
  let found = 0;
  for (const place of todo) {
    const id = place.googlePlaceId || place.id?.replace(/^places\//, '');
    if (!id) continue;
    if (options.resume && output[id]?.happyHourCheckedAt) continue;

    checked += 1;
    let happyHour = null;
    try {
      happyHour = await resolveHappyHour(place);
    } catch (error) {
      console.warn(`Happy hour extraction failed for ${displayName(place)}:`, error.message);
    }

    output[id] = {
      ...place,
      happyHour,
      hasHappyHour: Boolean(happyHour),
      happyHourCheckedAt: new Date().toISOString(),
    };
    if (happyHour) {
      found += 1;
      console.log(`  ✓ ${displayName(place)} (${happyHour.source}, ${happyHour.confidence})`);
    }

    if (checked % 10 === 0) {
      writeJson(WITH_HH_PATH, {
        meta: { updatedAt: new Date().toISOString(), checked, found },
        places: output,
      });
    }
  }

  const withHappyHour = Object.values(output).filter((place) => place.hasHappyHour);
  writeJson(WITH_HH_PATH, {
    meta: {
      updatedAt: new Date().toISOString(),
      checked,
      withHappyHour: withHappyHour.length,
      bySource: {
        google: withHappyHour.filter((place) => place.happyHour?.source === 'google').length,
        website: withHappyHour.filter((place) => place.happyHour?.source === 'website').length,
      },
    },
    places: output,
  });

  console.log(`Done. ${withHappyHour.length} venues with happy hour data saved to ${WITH_HH_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
