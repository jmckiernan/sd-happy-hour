#!/usr/bin/env node
// Clear seoHidden on published venues whose own site has since confirmed their
// happy hour at high confidence. Imports hide anything Google was unsure about,
// and until now nothing took the flag back off, so verified venues stayed off
// the homepage index and their neighborhood page.
//
// Usage: npm run import:venues:reindex-verified [-- --apply]

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { isVerifiedForIndexing } from './lib/seo-visibility.mjs';

const apply = process.argv.includes('--apply');
const venues = readJson(HAPPY_HOURS_PATH, []);
const hidden = venues.filter((venue) => venue.seoHidden && venue.listingStatus === 'published');
const verified = hidden.filter(isVerifiedForIndexing);

console.log(`${hidden.length} published venues are seoHidden; ${verified.length} of them are verified.`);
for (const venue of verified) {
  console.log(`  ${venue.id}\t${venue.neighborhood}\t${venue.name}`);
}

if (!apply) {
  console.log('\nDry run — pass --apply to clear seoHidden on the verified venues.');
  process.exit(0);
}

for (const venue of verified) venue.seoHidden = false;
writeJson(HAPPY_HOURS_PATH, venues);
console.log(`\nCleared seoHidden on ${verified.length} venues.`);
