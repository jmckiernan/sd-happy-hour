#!/usr/bin/env node
// Remove corporate chains and non-venue categories from the catalog.
//
// They cannot have the kind of happy hour this site is about, and their
// franchise marketing never runs through an owner claiming a listing, so they
// are pure noise in both the public catalog and the claim search. See
// lib/chain-blocklist.mjs and lib/category-rules.mjs for what counts and, just
// as importantly, what does not — sit-down chains with real happy hours stay,
// and so do local coffee shops and boba shops with no happy hour at all.
//
// Deletes rather than unlists: an unlisted venue still occupies the claim
// search, which is the one surface these were hurting most.
//
// The category half reads the primary type out of the enriched cache, because
// the catalog does not store it. A listing we never enriched is left alone
// rather than guessed at.
//
// Usage:
//   npm run purge:chains -- --dry-run
//   npm run purge:chains

import { execSync } from 'node:child_process';
import { ENRICHED_PATH, HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { isBlockedChain } from './lib/chain-blocklist.mjs';
import { isExcludedCategory } from './lib/category-rules.mjs';

/** Primary type per Google place id, so a catalog listing can be judged on it. */
function primaryTypesByPlaceId() {
  const places = readJson(ENRICHED_PATH, { places: {} })?.places || {};
  const byId = new Map();
  for (const [key, place] of Object.entries(places)) {
    const id = String(place.googlePlaceId || place.id || key).replace(/^places\//, '');
    if (place.primaryType) byId.set(id, place.primaryType);
  }
  return byId;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(HAPPY_HOURS_PATH, []);
  const primaryTypes = primaryTypesByPlaceId();

  const reasonFor = (venue) => {
    if (isBlockedChain(venue.name)) return 'chain';
    const placeId = String(venue.placeId || venue.googlePlaceId || '').replace(/^places\//, '');
    const primaryType = placeId ? primaryTypes.get(placeId) : null;
    if (isExcludedCategory(primaryType, venue.name)) return primaryType;
    return null;
  };

  const doomed = catalog.filter((venue) => reasonFor(venue));
  const keep = catalog.filter((venue) => !reasonFor(venue));

  const byBrand = new Map();
  const byCategory = new Map();
  for (const venue of doomed) {
    const reason = reasonFor(venue);
    if (reason === 'chain') byBrand.set(venue.name, (byBrand.get(venue.name) || 0) + 1);
    else byCategory.set(reason, (byCategory.get(reason) || 0) + 1);
  }

  console.log(`Catalog: ${catalog.length} listings`);
  console.log(`Corporate chains: ${[...byBrand.values()].reduce((sum, n) => sum + n, 0)}`);
  for (const [name, count] of [...byBrand].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name} × ${count}`);
  }
  console.log(`Excluded categories: ${[...byCategory.values()].reduce((sum, n) => sum + n, 0)}`);
  for (const [type, count] of [...byCategory].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type} × ${count}`);
  }

  // Anything here with a window is a false positive the extractor produced, so
  // it is worth seeing rather than deleting silently.
  const withHappyHour = doomed.filter((venue) => venue.startTime);
  if (withHappyHour.length) {
    console.log('\nHad a happy hour extracted (false positives):');
    for (const venue of withHappyHour) {
      console.log(`  ${venue.name} — ${venue.startTime}-${venue.endTime} [${venue.listingStatus}]`);
    }
  }

  if (options.dryRun) {
    console.log(`\nDry run — would leave ${keep.length} listings.`);
    return;
  }

  writeJson(HAPPY_HOURS_PATH, keep);
  console.log(`\nRemoved ${doomed.length}; ${keep.length} listings remain.`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed after purge. Review happy-hours.json.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
