#!/usr/bin/env node
// Buy Atmosphere-tier Place Details for the venues already in the catalog.
//
// `enrich.mjs` cannot do this job. It walks `candidates.json` (3,745 places
// clear its prefilter) and it skips anything carrying a `detailsFetchedAt`,
// which by now is all of them. So the only way to widen the mask through that
// script is `--no-resume`, and that re-buys all 3,745 at $25/1k whether or not
// the place ever reached the catalog. This script exists to buy the smaller,
// deliberate set instead: the venues the site actually publishes.
//
// The input is `public/data/happy-hours.json`, not the candidate cache. A
// venue that never made the catalog has nowhere to display an amenity, so
// paying Atmosphere rates for it is spending money on a row nobody can see.
//
// Usage:
//   IMPORT_CAPTURE_ALL=1 GOOGLE_PLACES_API_KEY=... node scripts/import-google-venues/backfill-atmosphere.mjs --dry-run
//   IMPORT_CAPTURE_ALL=1 GOOGLE_PLACES_API_KEY=... node scripts/import-google-venues/backfill-atmosphere.mjs

import path from 'node:path';
import { DATA_DIR, HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { placeDetails } from './lib/google-places.mjs';
import { parseArgs, readJson, writeJson, sleep } from './lib/io.mjs';

export const ATMOSPHERE_PATH = path.join(DATA_DIR, 'atmosphere.json');

const PRICE_PER_1K = 25;
// Every checkpoint is money made safe. A call already paid for but not yet
// written to disk is a call we buy again after a crash, so this is deliberately
// frequent: the store is small and rewriting it costs nothing next to $0.025.
const CHECKPOINT_EVERY = 10;
const MAX_ATTEMPTS = 3;

/**
 * The venues we are willing to pay for, deduplicated.
 *
 * Five catalog rows are second listings of a venue that already appears under
 * the same `placeId` (Ironside, False Idol, The Rose, The Crack Shack, Coin-Op),
 * so 2,792 rows carrying an id resolve to 2,787 distinct places. Google would
 * charge per call, not per row, so collapsing them here is five calls saved and
 * no data lost — both rows read the same response at merge time.
 */
export function catalogPlaceIds(rows) {
  const ids = rows.map((row) => row.placeId).filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * Persisted separately from `enriched.json` on purpose.
 *
 * `enriched.json` is a 19 MB file that other parts of the pipeline read and
 * rewrite wholesale. Checkpointing a long paid run into it means every
 * checkpoint is a chance to lose someone else's concurrent write, and a crash
 * mid-write risks the cache that records what we have already bought. Raw
 * responses land here instead, keyed by place id, and a merge into
 * `enriched.json` is a separate deliberate step once the tree is quiet.
 */
function loadStore() {
  return readJson(ATMOSPHERE_PATH, { meta: {}, places: {} });
}

function saveStore(store, extraMeta = {}) {
  writeJson(ATMOSPHERE_PATH, {
    meta: { ...store.meta, updatedAt: new Date().toISOString(), ...extraMeta },
    places: store.places,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // The mask is what we are paying for. If the flag is not set, `placeDetails`
  // silently uses the $20/1k mask with no Atmosphere fields in it, and the run
  // would spend real money to re-fetch data we already hold. Refuse instead.
  if (process.env.IMPORT_CAPTURE_ALL !== '1') {
    console.error('Refusing to run without IMPORT_CAPTURE_ALL=1.');
    console.error('Without it the call uses the default mask and buys no Atmosphere fields.');
    process.exit(1);
  }

  const rows = readJson(HAPPY_HOURS_PATH);
  if (!Array.isArray(rows)) {
    console.error(`Expected an array of venues at ${HAPPY_HOURS_PATH}`);
    process.exit(1);
  }

  const ids = catalogPlaceIds(rows);
  const store = loadStore();

  // Resume is the default and it is what stops a crash costing twice. A place
  // is only stamped once its response is safely in the store, so anything
  // missing the stamp was never successfully bought.
  const pending = options.resume
    ? ids.filter((id) => !store.places[id]?.atmosphereFetchedAt)
    : ids;
  const todo = options.limit ? pending.slice(0, options.limit) : pending;

  const withId = rows.filter((row) => row.placeId).length;
  console.log(`Catalog rows:            ${rows.length}`);
  console.log(`  carrying a placeId:    ${withId}`);
  console.log(`  distinct place ids:    ${ids.length}`);
  console.log(`  already bought:        ${ids.length - pending.length}`);
  console.log(`  to fetch this run:     ${todo.length}`);
  console.log(`Estimated cost:          $${((todo.length * PRICE_PER_1K) / 1000).toFixed(2)} at $${PRICE_PER_1K}/1k`);
  console.log(`  less 1,000 free calls: $${(Math.max(0, todo.length - 1000) * PRICE_PER_1K / 1000).toFixed(2)}`);

  if (options.dryRun) {
    console.log('\nDry run: no calls made, nothing spent.');
    return;
  }
  if (!todo.length) {
    console.log('\nNothing to fetch.');
    return;
  }

  let fetched = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const id of todo) {
    let saved = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt += 1) {
      try {
        const details = await placeDetails(id, 250, { captureAll: true });
        // Store the response whole. The point of paying Atmosphere rates once
        // is that fields nothing reads today are still here when something
        // does, so nothing gets dropped to fit a current schema.
        store.places[id] = { ...details, atmosphereFetchedAt: new Date().toISOString() };
        saved = true;
        fetched += 1;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          failed += 1;
          // Deliberately not stamped, so the next run retries it rather than
          // recording a paid-for gap as complete.
          console.warn(`  ! ${id} failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
        } else {
          await sleep(1000 * attempt);
        }
      }
    }

    const done = fetched + failed;
    if (done % CHECKPOINT_EVERY === 0) {
      saveStore(store, { lastRunFetched: fetched, lastRunFailed: failed });
      const rate = done / ((Date.now() - startedAt) / 1000);
      const remaining = Math.round((todo.length - done) / Math.max(rate, 0.01));
      console.log(
        `  … ${done}/${todo.length} fetched (${failed} failed), ` +
        `$${((fetched * PRICE_PER_1K) / 1000).toFixed(2)} spent, ~${Math.round(remaining / 60)} min left`
      );
    }
  }

  saveStore(store, {
    catalogRows: rows.length,
    distinctPlaceIds: ids.length,
    totalBought: Object.keys(store.places).length,
    lastRunFetched: fetched,
    lastRunFailed: failed,
  });

  console.log(`\nDone. ${fetched} fetched, ${failed} failed.`);
  console.log(`Spent this run: $${((fetched * PRICE_PER_1K) / 1000).toFixed(2)} at list price.`);
  console.log(`Store: ${ATMOSPHERE_PATH} (${Object.keys(store.places).length} places)`);
  if (failed) console.log('Re-run to retry the failures; bought places are skipped.');
}

// Only run when invoked directly, so the id-selection logic can be unit tested.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
