#!/usr/bin/env node
// Reconcile which listings the site's own navigation can reach.
//
// Two passes, both of which `applyScrape` now performs as part of a normal
// import; this script exists to settle listings whose last scrape predates the
// rules and which would otherwise wait for their next crawl.
//
//   1. Clear `seoHidden` on published venues whose happy-hour window we have
//      confirmed. Imports hide anything Google was unsure about, and a hidden
//      venue is off the homepage index and its neighborhood page, so nothing
//      links to it.
//   2. Unlist buildings that are not venues. A shopping centre, a public
//      market or a food hall has no happy hour of its own — everything on its
//      page belongs to a tenant — so it should not be browsable at all.
//
// Usage: npm run import:venues:reindex-verified [-- --apply]

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { isVerifiedForIndexing } from './lib/seo-visibility.mjs';
import { isMultiTenantListing } from './lib/window-only.mjs';

const apply = process.argv.includes('--apply');
const venues = readJson(HAPPY_HOURS_PATH, []);
const published = venues.filter((venue) => venue.listingStatus === 'published');

const nonVenues = published.filter((venue) => isMultiTenantListing(venue));
const hidden = published.filter((venue) => venue.seoHidden);
const verified = hidden.filter(isVerifiedForIndexing);

console.log(`${hidden.length} published venues are seoHidden; ${verified.length} of them are verified.`);
for (const venue of verified) {
  console.log(`  ${venue.id}\t${venue.neighborhood}\t${venue.name}`);
}

console.log(`\n${nonVenues.length} published listings are buildings rather than venues.`);
for (const venue of nonVenues) {
  console.log(`  ${venue.id}\t${venue.neighborhood}\t${venue.name}`);
}

if (!apply) {
  console.log('\nDry run — pass --apply to clear seoHidden on the verified venues and unlist the non-venues.');
  process.exit(0);
}

for (const venue of verified) venue.seoHidden = false;
for (const venue of nonVenues) {
  venue.listingStatus = 'unlisted';
  venue.seoHidden = true;
}
writeJson(HAPPY_HOURS_PATH, venues);
console.log(`\nCleared seoHidden on ${verified.length} venues and unlisted ${nonVenues.length} non-venues.`);
