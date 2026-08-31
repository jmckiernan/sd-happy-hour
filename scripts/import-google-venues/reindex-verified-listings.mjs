#!/usr/bin/env node
// Reconcile who can find a listing, on both surfaces that decide it.
//
// `seoHidden` keeps a venue out of search indexes. `browseHold` keeps it off
// browse surfaces and says why. Three passes, all of which `applyScrape` now
// performs as part of a normal import; this script exists to settle listings
// whose last scrape predates the rules and which would otherwise wait for
// their next crawl.
//
//   1. Lift both hedges off published venues whose happy-hour window we have
//      confirmed. Imports apply them whenever Google was unsure, and until
//      recently nothing took them back off.
//   2. Record a reason on published venues that are still hidden. A listing
//      held back with no stated reason is one nobody can audit or fix.
//   3. Unlist buildings that are not venues. A shopping centre, a public
//      market or a food hall has no happy hour of its own — everything on its
//      page belongs to a tenant — so it should not be browsable at all.
//
// Usage: npm run import:venues:reindex-verified [-- --apply]

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { isVerifiedForIndexing, unverifiedWindowHold } from './lib/seo-visibility.mjs';
import { isMultiTenantListing } from './lib/window-only.mjs';

const apply = process.argv.includes('--apply');
const venues = readJson(HAPPY_HOURS_PATH, []);
const published = venues.filter((venue) => venue.listingStatus === 'published');

const nonVenues = published.filter((venue) => isMultiTenantListing(venue));
const confirmed = published.filter(
  (venue) => (venue.seoHidden || venue.browseHold) && isVerifiedForIndexing(venue)
);
// A venue kept out of search because we could not source its window is held
// off browse for that same reason, stated rather than inferred from the flag.
const needsReason = published.filter(
  (venue) => venue.seoHidden && !venue.browseHold && !isVerifiedForIndexing(venue)
);

const row = (venue, extra) => `  ${venue.id}\t${venue.neighborhood}\t${venue.name}${extra ? `\t${extra}` : ''}`;

console.log(`${published.filter((venue) => venue.seoHidden).length} published venues are seoHidden; ${confirmed.length} of them are confirmed.`);
for (const venue of confirmed) console.log(row(venue));

console.log(`\n${needsReason.length} held-back listings have no recorded reason.`);
for (const venue of needsReason) console.log(row(venue, 'unverified_window'));

console.log(`\n${nonVenues.length} published listings are buildings rather than venues.`);
for (const venue of nonVenues) console.log(row(venue));

if (!apply) {
  console.log('\nDry run — pass --apply to write the changes above.');
  process.exit(0);
}

for (const venue of confirmed) {
  venue.seoHidden = false;
  delete venue.browseHold;
}
for (const venue of needsReason) venue.browseHold = unverifiedWindowHold();
for (const venue of nonVenues) {
  venue.listingStatus = 'unlisted';
  venue.seoHidden = true;
  delete venue.browseHold;
}
writeJson(HAPPY_HOURS_PATH, venues);
console.log(
  `\nConfirmed ${confirmed.length} venues, recorded a reason on ${needsReason.length}, unlisted ${nonVenues.length} non-venues.`
);
