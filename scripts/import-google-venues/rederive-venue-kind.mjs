#!/usr/bin/env node
// Re-derive the `vibe` field — what kind of place a venue is — from the venue's
// name and Google's committed primary type.
//
// The field it replaces was produced by matching a chain of unanchored regexes
// against Google's whole `types` array with a `Restaurant` fallback at the end.
// Measured against `primaryType`, that made `Cocktail bar` right on 17 of 506
// rows and `Nightlife spot` right on 10 of 112, and it put `Restaurant` on 998
// rows that nobody had looked at. docs/vibe-field-audit.md has the numbers.
//
// Two things this script will not do:
//
// - It never invents a kind. A venue whose name and primary type both decline
//   to say what it is ends with no `vibe` key, and every surface is built to
//   render nothing there.
// - It never overwrites a value a person wrote. The 19 original seed listings
//   carry hand-typed kinds — "Tiki bar", "Arcade bar", "Vegan metal bar" — and
//   so does any listing an owner has claimed and filled in. Those are the only
//   values on this field that were ever read off something. Pass
//   --replace-human to override that, which is only right when re-running
//   against a catalog this script has already written.
//
// Usage:
//   npm run rederive:venue-kind -- --dry-run
//   npm run rederive:venue-kind

import { execSync } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR, ENRICHED_PATH, HAPPY_HOURS_PATH, ROOT_DIR, WITH_HH_PATH } from './lib/constants.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { deriveVenueKind } from './lib/venue-kind.mjs';

// The eight labels the old `inferVibe()` could produce. These are the only
// stored values this script is allowed to replace: every one of them was
// written by a regex over Google's `types` array rather than read off anything,
// including the four whose spelling survives into the new vocabulary. Anything
// else on the field was typed by a person — the 19 seed listings, and any
// listing an owner has claimed — and a person's answer outranks a derivation.
const RETIRED_LABELS = new Set([
  'Restaurant',
  'Cocktail bar',
  'Cafe',
  'Brewery',
  'Wine bar',
  'Nightlife spot',
  'Seafood spot',
  'Pizza spot',
]);

const ATMOSPHERE_PATH = path.join(DATA_DIR, 'atmosphere.json');

// Every place record we hold, keyed by the id the catalog stores. Three caches
// because they were fetched by three passes and none covers the whole catalog
// on its own; together they answer for 2,590 of 3,006 rows.
function loadPrimaryTypes() {
  const byId = new Map();
  for (const file of [ENRICHED_PATH, WITH_HH_PATH, ATMOSPHERE_PATH]) {
    const cache = readJson(file, null);
    for (const record of Object.values(cache?.places || {})) {
      const id = record.googlePlaceId || record.id;
      if (id && record.primaryType && !byId.has(id)) byId.set(id, record.primaryType);
    }
  }
  return byId;
}

function distribution(venues) {
  const counts = {};
  for (const venue of venues) {
    const key = venue.vibe || '(none)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatDistribution(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => (after[right] || 0) - (after[left] || 0));
  return keys
    .map((key) => `  ${key.padEnd(20)} ${String(before[key] || 0).padStart(4)} -> ${String(after[key] || 0).padStart(4)}`)
    .join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const replaceHuman = process.argv.includes('--replace-human');
  const primaryTypes = loadPrimaryTypes();

  // Refuse to run without the caches, for the reason rederive-deal-types.mjs
  // refuses: with no primary types every venue falls back to its name alone,
  // which strips the kind off around 700 listings and reports success.
  if (primaryTypes.size === 0) {
    console.error(`No cached place records under ${DATA_DIR}.`);
    console.error('Refusing to run: name matching alone would silently drop the kind');
    console.error('from every venue whose name does not announce it.');
    process.exit(1);
  }

  // Read the catalog as late as possible and write it back immediately below.
  // Another job may be editing menus or photos on the same file, and a long
  // gap between the read and the write is how one run silently reverts
  // another's (docs/lessons-and-invariants.md §2.8).
  const catalog = readJson(HAPPY_HOURS_PATH, []);

  let gained = 0;
  let lost = 0;
  let changed = 0;
  let keptHuman = 0;
  const samples = [];

  const rederived = catalog.map((venue) => {
    const stored = venue.vibe;
    if (stored && !RETIRED_LABELS.has(stored) && !replaceHuman) {
      keptHuman += 1;
      return venue;
    }

    const derived = deriveVenueKind({ name: venue.name, primaryType: primaryTypes.get(venue.placeId) });
    if (derived === stored) return venue;

    changed += 1;
    if (!stored && derived) gained += 1;
    if (stored && !derived) lost += 1;
    if (samples.length < 15) {
      samples.push(`  ${venue.name.padEnd(40)} ${String(stored || '-').padEnd(18)} -> ${derived || '-'}`);
    }

    const next = { ...venue };
    if (derived) next.vibe = derived;
    else delete next.vibe;
    return next;
  });

  const published = (venues) => venues.filter((venue) => venue.listingStatus === 'published');
  console.log(`Listings: ${catalog.length} (${published(catalog).length} published)`);
  console.log(`  vibe changed: ${changed} (${gained} gained a kind, ${lost} lost one)`);
  console.log(`  hand-written values left alone: ${keptHuman}`);
  console.log(`  carrying a kind after: ${rederived.filter((venue) => venue.vibe).length}`);
  console.log(`  published carrying a kind after: ${published(rederived).filter((venue) => venue.vibe).length}`);
  console.log('\nDistribution (before -> after):');
  console.log(formatDistribution(distribution(catalog), distribution(rederived)));
  console.log('\nPublished distribution (before -> after):');
  console.log(formatDistribution(distribution(published(catalog)), distribution(published(rederived))));
  console.log('\nSamples:');
  console.log(samples.join('\n'));

  if (options.dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, rederived);
  console.log(`\nWrote ${rederived.length} listings.`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed. Review happy-hours.json.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
