#!/usr/bin/env node
// Remove corporate fast-food outlets from the catalog.
//
// They cannot have the kind of happy hour this site is about, and their
// franchise marketing never runs through an owner claiming a listing, so they
// are pure noise in both the public catalog and the claim search. See
// lib/chain-blocklist.mjs for what counts and, just as importantly, what does
// not — sit-down chains with real happy hours stay.
//
// Deletes rather than unlists: an unlisted venue still occupies the claim
// search, which is the one surface these were hurting most.
//
// Usage:
//   npm run purge:chains -- --dry-run
//   npm run purge:chains

import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { isCorporateFastFood } from './lib/chain-blocklist.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(HAPPY_HOURS_PATH, []);

  const doomed = catalog.filter((venue) => isCorporateFastFood(venue.name));
  const keep = catalog.filter((venue) => !isCorporateFastFood(venue.name));

  const byBrand = new Map();
  for (const venue of doomed) {
    byBrand.set(venue.name, (byBrand.get(venue.name) || 0) + 1);
  }

  console.log(`Catalog: ${catalog.length} listings`);
  console.log(`Corporate fast-food outlets: ${doomed.length}`);
  for (const [name, count] of [...byBrand].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name} × ${count}`);
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
