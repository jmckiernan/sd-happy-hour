// Where a venue is placed, and whether that place has a page to be found on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { HAPPY_HOURS_PATH } from '../scripts/import-google-venues/lib/constants.mjs';
import { NEIGHBORHOOD_BOXES, assignNeighborhood } from '../scripts/import-google-venues/lib/neighborhood-assign.mjs';
import { applyScrape } from '../scripts/import-google-venues/lib/apply-scrape.mjs';
import { isVerifiedForIndexing } from '../scripts/import-google-venues/lib/seo-visibility.mjs';
import { isBrowseHoldReason, isHeldFromBrowse } from '../src/lib/listingVisibility.ts';

const venues = JSON.parse(fs.readFileSync(HAPPY_HOURS_PATH, 'utf8'));
const boxes = new Map(NEIGHBORHOOD_BOXES.map((box) => [box.name, box]));

// The neighborhood pages are built from a hand-kept list in a TypeScript module
// the .mjs suite cannot import, so read the vocabulary out of the source.
function neighborhoodsWithPages() {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../src/lib/neighborhoods.ts'), 'utf8');
  const block = source.split('const ALL_NEIGHBORHOODS = [')[1]?.split('];')[0];
  assert.ok(block, 'could not read ALL_NEIGHBORHOODS from src/lib/neighborhoods.ts');
  return new Set([...block.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

function milesOutsideBox(lat, lng, box) {
  const latMiles = Math.max(box.minLat - lat, 0, lat - box.maxLat) * 69;
  const lngMiles = Math.max(box.minLng - lng, 0, lng - box.maxLng) * 58;
  return Math.hypot(latMiles, lngMiles);
}

const tests = [];

function testCoordinatesInsideANeighborhoodBoxDecideTheAnswer() {
  assert.equal(assignNeighborhood(32.7215, -117.1690, '1654 India St, San Diego, CA 92101, USA'), 'Little Italy');
  // Cardiff sat inside the old Solana Beach box; its own box has to win.
  assert.equal(assignNeighborhood(33.0158, -117.2800, '2033 San Elijo Ave, Cardiff, CA 92007, USA'), 'Cardiff');
}

function testAStreetNameNeverOutranksTheCityItSitsIn() {
  // Avenida Del Mar is in San Clemente, 36 miles up the coast from Del Mar.
  assert.equal(assignNeighborhood(33.4237, -117.6169, '156 Avenida Del Mar, San Clemente, CA 92672, USA'), 'San Clemente');
  assert.equal(assignNeighborhood(33.4306, -117.6113, '225 W Avenida Vista Hermosa Ste G, San Clemente, CA 92672, USA'), 'San Clemente');
}

function testAStreetNameNeverOutranksASanDiegoZip() {
  // The reported bug: Scripps Poway Parkway is in Scripps Ranch, not Poway.
  assert.equal(assignNeighborhood(32.9357495, -117.0996036, '10585 Scripps Poway Pkwy Ste D, San Diego, CA 92131, USA'), 'Scripps Ranch');
  // El Cajon Boulevard runs the width of the city; Linda Vista Road is nowhere near Vista.
  assert.equal(assignNeighborhood(32.7645, -117.0713, '4717 El Cajon Blvd, San Diego, CA 92115, USA'), 'College Area');
  assert.equal(assignNeighborhood(32.8005, -117.1902, '6931 Linda Vista Rd, San Diego, CA 92111, USA'), 'Kearny Mesa');
}

function testAnUnrecognisedSanDiegoZipStaysVagueRatherThanGuessing() {
  // Cardiff Street is in southeastern San Diego. "San Diego" is unhelpful but
  // true; "Cardiff" would put the venue on a coastal page 24 miles away.
  assert.equal(assignNeighborhood(32.7016, -117.0453, '954 Cardiff St, San Diego, CA 92114, USA'), 'San Diego');
}

function testAnAddressWithNoCityOrZipStillFallsBackToItsPlaceName() {
  assert.equal(assignNeighborhood(NaN, NaN, 'Liberty Station, San Diego'), 'Point Loma');
  assert.equal(assignNeighborhood(NaN, NaN, ''), 'San Diego');
  assert.equal(assignNeighborhood(32.5, -117.0, 'Av. Revolución, Tijuana, B.C.'), 'Tijuana');
}

function testEveryCatalogedVenueAgreesWithTheAssignmentRule() {
  const disagree = venues
    .filter((venue) => venue.neighborhood !== assignNeighborhood(venue.lat, venue.lng, venue.address || ''))
    .map((venue) => `${venue.id} ${venue.name}: ${venue.neighborhood}`);
  assert.deepEqual(disagree, [], 'run npm run import:venues:classify-neighborhoods');
}

function testNoVenueSitsAbsurdlyFarFromTheNeighborhoodItIsFiledUnder() {
  // Cities are wider than their boxes, so a few miles outside is normal. Tens of
  // miles means the venue has been filed under someone else's neighborhood.
  const stranded = venues
    .filter((venue) => Number.isFinite(venue.lat) && Number.isFinite(venue.lng) && boxes.has(venue.neighborhood))
    .map((venue) => ({ venue, miles: milesOutsideBox(venue.lat, venue.lng, boxes.get(venue.neighborhood)) }))
    .filter((row) => row.miles > 12)
    .map((row) => `${row.venue.id} ${row.venue.name}: ${row.venue.neighborhood} is ${row.miles.toFixed(0)}mi away`);
  assert.deepEqual(stranded, []);
}

function testEveryVisibleVenueHasANeighborhoodPageToAppearOn() {
  const pages = neighborhoodsWithPages();
  const orphaned = venues
    .filter((venue) => venue.listingStatus === 'published' && !venue.browseHold)
    .filter((venue) => !pages.has(venue.neighborhood))
    .map((venue) => `${venue.id} ${venue.name}: ${venue.neighborhood}`);
  assert.deepEqual(orphaned, [], 'a listed venue whose neighborhood has no page appears nowhere');
}

function testOnlyANamedHoldKeepsAVenueOffItsNeighborhoodPage() {
  // `seoHidden` is search — noindex, the sitemap, the homepage's ItemList —
  // and `browseHold` is navigation. They were one boolean until the split
  // recorded in docs/homepage-reachability.md, and conflating them is what
  // left 83 published venues with real schedules unreachable.
  assert.equal(isHeldFromBrowse({ seoHidden: true }), false);
  assert.equal(isHeldFromBrowse({ browseHold: { reason: 'unverified_window', since: '2026-08-31' } }), true);
  assert.equal(isHeldFromBrowse({}), false);

  // Every hold in the catalog names a reason the codebase knows how to handle
  // and dates it. A hold nobody can act on hides a venue and explains nothing,
  // which is the state the split was made to end.
  const held = venues.filter((venue) => venue.browseHold);
  assert.ok(held.length > 0);
  assert.deepEqual(
    held
      .filter((venue) => !isBrowseHoldReason(venue.browseHold.reason) || !venue.browseHold.since)
      .map((venue) => `${venue.id} ${venue.name}`),
    []
  );

  // And the reason has to still be true: a venue we have since confirmed but
  // which is still held back as unverified is the original bug wearing a label.
  assert.deepEqual(
    venues
      .filter((venue) => venue.browseHold?.reason === 'unverified_window')
      .filter((venue) => isVerifiedForIndexing(venue))
      .map((venue) => `${venue.id} ${venue.name}`),
    []
  );
}

function testAVerifiedHappyHourStopsBeingHiddenFromTheNeighborhoodPage() {
  const venue = {
    id: 1,
    name: 'Verified Spot',
    seoHidden: true,
    browseHold: { reason: 'unverified_window', since: '2026-08-01' },
    hasHappyHourData: true,
    days: ['Monday'],
    startTime: '15:00',
    endTime: '18:00',
    deals: ['$6 beers'],
  };
  const result = applyScrape(venue, {
    found: true,
    confidence: 'high',
    source: 'website',
    sourcePage: 'https://example.com/happy-hour',
    days: ['Monday', 'Tuesday'],
    startTime: '15:00',
    endTime: '18:00',
    deals: ['$6 craft beers', '$8 wine'],
    evidence: [
      { field: 'times', quote: 'Happy hour 3-6pm Monday and Tuesday', url: 'https://example.com/happy-hour' },
      { field: 'deals', quote: '$6 craft beers, $8 wine', url: 'https://example.com/happy-hour' },
    ],
  });
  // Both hedges come off: the search flag and the browse hold were answering
  // the same question, and the scrape has now answered it.
  assert.equal(venue.seoHidden, false);
  assert.equal(venue.browseHold, undefined);
  assert.ok(result.changes.includes('seoHidden cleared'));
  assert.ok(result.changes.includes('browse hold released'));
}

function testAnUnprovenHappyHourStaysHidden() {
  // What has to be proven is that the place is real and its window is ours:
  // a quote we read off the venue's own happy-hour page. Whether the venue
  // also publishes offers is a question about content, not existence, and
  // window-only listings stay published — see docs/window-only-listings.md.
  const sourced = {
    listingStatus: 'published',
    name: 'Sourced Spot',
    days: ['Monday'],
    startTime: '15:00',
    endTime: '18:00',
    deals: [],
    lastScrape: { outcome: 'found', confidence: 'high' },
    hhSources: {
      times: {
        source: 'website_hh_page',
        evidence: [{ quote: 'Happy hour 3-6pm Monday', url: 'https://example.com/happy-hour' }],
      },
    },
  };
  assert.equal(isVerifiedForIndexing(sourced), true);
  assert.equal(isVerifiedForIndexing({ ...sourced, lastScrape: { outcome: 'not_published' } }), true);
  assert.equal(isVerifiedForIndexing({ ...sourced, listingStatus: 'unlisted' }), false);

  // A window with no provenance at all is an unverified claim, not a venue we
  // have confirmed, and deals do not substitute for the missing source.
  const { hhSources, ...unsourced } = sourced;
  assert.equal(isVerifiedForIndexing(unsourced), false);
  assert.equal(isVerifiedForIndexing({ ...unsourced, deals: ['$6 beers'] }), false);

  // Google's HAPPY_HOUR opening hours carry times and never a quote, so they
  // prove the window on their own.
  assert.equal(
    isVerifiedForIndexing({ ...unsourced, hhSources: { times: { source: 'google_places' } } }),
    true
  );

  // The pages we read described another brand or another branch, so the
  // window quoted off them is not evidence about this venue.
  assert.equal(isVerifiedForIndexing({ ...sourced, lastScrape: { outcome: 'wrong_website' } }), false);
  assert.equal(isVerifiedForIndexing({ ...sourced, lastScrape: { outcome: 'other_location' } }), false);

  // A food hall's window belongs to its tenants.
  assert.equal(isVerifiedForIndexing({ ...sourced, name: 'Windmill Food Hall' }), false);

  // An incomplete window is nothing to show.
  assert.equal(isVerifiedForIndexing({ ...sourced, days: [] }), false);
}

tests.push(
  testCoordinatesInsideANeighborhoodBoxDecideTheAnswer,
  testAStreetNameNeverOutranksTheCityItSitsIn,
  testAStreetNameNeverOutranksASanDiegoZip,
  testAnUnrecognisedSanDiegoZipStaysVagueRatherThanGuessing,
  testAnAddressWithNoCityOrZipStillFallsBackToItsPlaceName,
  testEveryCatalogedVenueAgreesWithTheAssignmentRule,
  testNoVenueSitsAbsurdlyFarFromTheNeighborhoodItIsFiledUnder,
  testEveryVisibleVenueHasANeighborhoodPageToAppearOn,
  testOnlyANamedHoldKeepsAVenueOffItsNeighborhoodPage,
  testAVerifiedHappyHourStopsBeingHiddenFromTheNeighborhoodPage,
  testAnUnprovenHappyHourStaysHidden,
);

let failed = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}: ${error.message}`);
  }
}

if (failed) process.exit(1);
console.log(`All ${tests.length} neighborhood assignment tests passed.`);
