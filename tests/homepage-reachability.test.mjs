/**
 * Can a visitor actually find a published venue?
 *
 * The bug this guards against leaves no trace anywhere else: the record is
 * present, correct and validated, its page renders, and nothing links to it.
 * 83 venues sat in that state because an import flag that means "keep this out
 * of search" was also read as "keep this out of navigation", and no test asked
 * whether a published venue can be reached.
 *
 * The owner's rule is that the homepage is the navigation surface — it is
 * where the search box and every filter live — so every published venue has to
 * appear there and be findable through it. Reachability from *somewhere* is
 * not the bar; a venue that only a neighborhood page links to is one a visitor
 * searching for it by name will never see.
 */

import assert from 'node:assert/strict';
import happyHours from '../public/data/happy-hours.json' with { type: 'json' };
import { getPublicVenues, hasSchedule, getVenues } from '../src/lib/venues';
import { isPubliclyListed } from '../src/lib/listingVisibility';
import { venueSearchText } from '../src/lib/venueSearchText';
import { getNeighborhoodProfiles } from '../src/lib/neighborhoods';
import { isVerifiedForIndexing } from '../scripts/import-google-venues/lib/seo-visibility.mjs';

const tests = [];
const label = (venue) => `${venue.name} (${venue.id})`;

/**
 * The venues the homepage grid renders, by the page's own rule.
 *
 * `src/pages/index.astro` fetches the dataset in the browser and keeps
 * `isPubliclyListed`, nothing else. Stated here as its own function so a
 * change to that filter has to be mirrored deliberately, with these
 * assertions to answer to.
 */
function homepageGridVenues() {
  return getVenues().filter((venue) => isPubliclyListed(venue));
}

/** The homepage's search box, which matches on `venueSearchText`. */
function homepageSearchMatches(venue, query) {
  return venueSearchText(venue).join(' ').toLowerCase().includes(query.trim().toLowerCase());
}

function testEveryPublishedVenueIsOnTheHomepage() {
  const published = happyHours.filter((venue) => venue.listingStatus !== 'unlisted');
  const onHomepage = new Set(homepageGridVenues().map((venue) => venue.id));
  const missing = published.filter((venue) => !onHomepage.has(venue.id)).map(label);
  assert.deepEqual(missing, []);

  // Nothing beyond listing status may remove a published venue from the grid.
  // A deals requirement, an image requirement or `seoHidden` applied here
  // would each hide a real venue for failing a test about something else.
  const withoutDeals = published.filter((venue) => !(venue.deals || []).length);
  const withoutImage = published.filter((venue) => !venue.image);
  const flaggedHidden = published.filter((venue) => venue.seoHidden);
  assert.ok(withoutDeals.length > 0 && withoutDeals.every((venue) => onHomepage.has(venue.id)));
  assert.ok(withoutImage.length > 0 && withoutImage.every((venue) => onHomepage.has(venue.id)));
  assert.ok(flaggedHidden.every((venue) => onHomepage.has(venue.id)));
}

function testEveryPublishedVenueCanBeFoundBySearchingItsOwnName() {
  const unfindable = homepageGridVenues()
    .filter((venue) => !homepageSearchMatches(venue, venue.name))
    .map(label);
  assert.deepEqual(unfindable, []);

  // The search reads more than the name, which is the point of it, but a name
  // that matches nothing would be invisible to the one query certain to be
  // typed. Neighborhood has to work too: it is how the homepage answers the
  // question the neighborhood pages answer.
  const wrongNeighborhood = homepageGridVenues()
    .filter((venue) => venue.neighborhood && !homepageSearchMatches(venue, venue.neighborhood))
    .map(label);
  assert.deepEqual(wrongNeighborhood, []);
}

function testEveryPublishedVenueSurvivesEveryFilterFacet() {
  const venues = homepageGridVenues();
  // The facet options are built from the rendered venues themselves
  // (`populateSelect` in index.astro), so every venue has to be selectable by
  // at least one option of each facet it can be filtered by.
  const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const neighborhoodOptions = new Set(venues.map((venue) => venue.neighborhood));
  const dealOptions = new Set(venues.flatMap((venue) => venue.dealTypes || []));

  const unfilterable = venues
    .filter((venue) => {
      const byDay = (venue.days || []).some((day) => dayOptions.includes(day));
      const byNeighborhood = neighborhoodOptions.has(venue.neighborhood);
      // "All deals" is the default, so a venue with no deal types is reachable;
      // one that carries a type the facet never offers is not.
      const byDeal = (venue.dealTypes || []).every((type) => dealOptions.has(type));
      return !(byDay && byNeighborhood && byDeal);
    })
    .map(label);
  assert.deepEqual(unfilterable, []);

  // The day filter opens on today's weekday rather than "All days", so a
  // window is what puts a venue in the default view at all.
  const withoutWindow = venues.filter((venue) => !hasSchedule(venue)).map(label);
  assert.deepEqual(withoutWindow, []);
}

function testAConfirmedVenueIsNeverKeptOutOfTheIndexOrItsNeighborhoodPage() {
  // Two prerendered surfaces do read `seoHidden`: the homepage's ItemList
  // structured data and the neighborhood pages. A venue whose happy-hour
  // window we have confirmed belongs in both, and the import rule that clears
  // the flag and the surfaces that honour it have to agree about which venues
  // those are.
  const indexable = new Set(getPublicVenues().filter((venue) => !venue.seoHidden).map((venue) => venue.id));
  const onNeighborhoodPage = new Set(
    getNeighborhoodProfiles().flatMap((profile) => profile.venues.map((venue) => venue.id))
  );

  const confirmed = happyHours.filter(isVerifiedForIndexing);
  assert.ok(confirmed.length > 0);
  assert.deepEqual(confirmed.filter((venue) => !indexable.has(venue.id)).map(label), []);
  assert.deepEqual(confirmed.filter((venue) => !onNeighborhoodPage.has(venue.id)).map(label), []);

  // And the converse: a published venue may only be held back from those
  // surfaces by the one rule allowed to hold it back. Anything else hidden
  // there is hidden for a reason nobody wrote down.
  const heldBack = happyHours
    .filter((venue) => venue.listingStatus === 'published' && !indexable.has(venue.id))
    .filter((venue) => isVerifiedForIndexing(venue))
    .map(label);
  assert.deepEqual(heldBack, []);
}

function testABuildingFullOfTenantsIsNotAPublishedVenue() {
  // A food hall's happy hour belongs to its tenants, so its listing is wrong
  // rather than merely unhelpful. Hiding it from search would leave the wrong
  // record on a browsable page; it has to be unlisted.
  const buildings = happyHours.filter((venue) =>
    /\b(?:food hall|public market)\b/i.test(venue.name || '')
  );
  assert.ok(buildings.length > 0);
  assert.deepEqual(
    buildings.filter((venue) => venue.listingStatus !== 'unlisted').map(label),
    []
  );
}

tests.push(
  testEveryPublishedVenueIsOnTheHomepage,
  testEveryPublishedVenueCanBeFoundBySearchingItsOwnName,
  testEveryPublishedVenueSurvivesEveryFilterFacet,
  testAConfirmedVenueIsNeverKeptOutOfTheIndexOrItsNeighborhoodPage,
  testABuildingFullOfTenantsIsNotAPublishedVenue,
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
console.log(`All ${tests.length} homepage reachability tests passed.`);
