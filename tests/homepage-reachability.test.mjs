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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import happyHours from '../public/data/happy-hours.json' with { type: 'json' };
import { alertMatchesVenue, getPublicVenues, hasSchedule, getVenues, venueMatchesTimeRange, venueSlug } from '../src/lib/venues';
import { buildVenueSlugMap, slugFromMap } from '../src/lib/venueSlug';
import { OFFERS_UNKNOWN_FILTER } from '../src/lib/directoryFilters';
import { isPubliclyListed, isSitemapEligible } from '../src/lib/listingVisibility';
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
      // Every venue is selectable by some option of the deal facet: one with
      // deal types by those types, one without by "Offers not listed".
      // Reachable only while the facet sits at its default is not reachable —
      // that was the bug.
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

async function testVenuesWithNoDealTypesAreReachableThroughTheDealFilter() {
  // 140 published venues publish their happy hour times and nothing about what
  // is on offer, so they carry no deal types and every deal-type selection
  // excluded them. Tagging them with a type to keep them in those results
  // would be a fabricated offer, so the homepage carries an explicit option for
  // the state instead, plus a count of what a deal-type selection leaves out.
  //
  // Read from the repository root: this file runs bundled, so a path relative
  // to it points into .data/tests rather than at the source.
  const homepage = await readFile(path.join(process.cwd(), 'src', 'pages', 'index.astro'), 'utf8');
  const offersUnknown = homepageGridVenues().filter((venue) => !(venue.dealTypes || []).length);
  assert.ok(offersUnknown.length > 0);

  assert.match(homepage, /<option value="offers-unknown">Offers not listed<\/option>/);
  // Selected by the absence of deal types rather than by a value written onto
  // the venues, so nothing in the catalog has to claim an offer.
  assert.match(homepage, /dealFilter === OFFERS_UNKNOWN_FILTER[\s\S]*?!\(h\.dealTypes \|\| \[\]\)\.length/);
  assert.match(homepage, /publish happy hour times but not what is on offer/);
  // And the automatic day filter says what it is hiding, since the page chose
  // that filter rather than the visitor.
  assert.match(homepage, /!dayFilterTouched && dayFilter === automaticDayFilter/);
  assert.match(homepage, /no happy hour on \$\{dayFilter\}/);

  // An alert saved off the filter bar has to mean the same thing the bar did.
  const filters = { days: [], neighborhood: '', dealType: OFFERS_UNKNOWN_FILTER, query: '' };
  const withTypes = homepageGridVenues().find((venue) => (venue.dealTypes || []).length);
  assert.equal(alertMatchesVenue(filters, offersUnknown[0]), true);
  assert.equal(alertMatchesVenue(filters, withTypes), false);
}

async function testHeroLiveCounterActivatesOnlyRecurringHappyHoursNow() {
  const homepage = await readFile(path.join(process.cwd(), 'src', 'pages', 'index.astro'), 'utf8');

  // The hero count stays in an explicit loading state until canonical server
  // time arrives; a false zero is never painted during startup.
  assert.match(homepage, /<button class="live-counter" id="live-counter-button" type="button" disabled aria-busy="true"/);
  assert.match(homepage, /id="live-count-big"><img class="drink-loader drink-loader--sm live-count-loader" src="\/cocktail-loader\.svg"/);
  assert.match(homepage, /if \(!feedSnapshot\.data\) \{/);
  assert.match(homepage, /feedSnapshot\.error[\s\S]*?Count temporarily unavailable/);
  assert.match(homepage, /liveCounterButton\.disabled = happyHoursNow === 0/);
  assert.match(homepage, /if \(getHappyHoursNowCount\(venueStates\) === 0\) return;/);

  // The CTA clears every exclusionary facet before selecting the existing,
  // visible recurring-status filter. Live Deals are not the definition of
  // "Happy Hour Now"; the canonical consumer state occurrence is.
  assert.match(homepage, /\['day-filter', 'neighborhood-filter', 'deal-filter', 'status-filter', 'trust-filter', 'start-time-filter', 'end-time-filter'\]/);
  assert.match(homepage, /getElementById\('search-input'\)[\s\S]*?\.value = ''/);
  assert.match(homepage, /statusFilter\.value = 'happy-hour-now'/);
  assert.match(
    homepage,
    /if \(statusFilter === 'happy-hour-now'\) \{\s*filtered = filtered\.filter\(\(h\) => Boolean\(venueStates\.get\(h\.id\)\?\.happyHourOccurrence\)\);/,
  );

  // The selected filter remains visible and the scroll respects the visitor's
  // reduced-motion preference. Distance and view mode are presentation/sort
  // controls, so activating the CTA deliberately leaves them intact.
  assert.match(homepage, /<option value="happy-hour-now">Happy Hour Now<\/option>/);
  assert.match(homepage, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(homepage, /scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth', block: 'start' \}\)/);
  assert.match(homepage, /Near Me and list\/map are retained/);
}

async function testHomepageGridShowsLoadingBeforeItsTrueEmptyState() {
  const homepage = await readFile(path.join(process.cwd(), 'src', 'pages', 'index.astro'), 'utf8');

  // The directory fetch can finish after the live-promotion feed's first
  // render. Until it does, the permanent loading state must win over the
  // zero-length filtered array and its genuine post-load empty message.
  assert.match(
    homepage,
    /<div class="directory-loading" id="directory-loading" role="status" aria-live="polite" aria-label="Loading happy hour venues">[\s\S]*?drink-loader drink-loader--lg[\s\S]*?\/cocktail-loader\.svg/,
  );
  assert.doesNotMatch(homepage, /live-count-spin|save-list-spin|directory-cocktail-fill/);
  assert.match(homepage, /if \(!venueDirectoryLoaded\) \{[\s\S]*?directoryLoading\.hidden = false;[\s\S]*?empty as HTMLElement\)\.style\.display = 'none';[\s\S]*?return;/);
  assert.match(homepage, /directoryLoading\.hidden = true;[\s\S]*?if \(filtered\.length === 0\) \{[\s\S]*?empty as HTMLElement\)\.style\.display = 'block';/);
}

async function testHomepageTimeBoundsAndNeighborhoodLinksStayConsistent() {
  const homepage = await readFile(path.join(process.cwd(), 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(homepage, /id="start-time-filter" type="time"/);
  assert.match(homepage, /id="end-time-filter" type="time"/);
  assert.match(homepage, /startTime:\s*\(document\.getElementById\('start-time-filter'\)/);
  assert.match(homepage, /endTime:\s*\(document\.getElementById\('end-time-filter'\)/);
  assert.match(homepage, /<a class="card-image-link" href="\/venues\/\$\{slug\}\/">/);
  assert.match(homepage, /venueSlugMap = buildVenueSlugMap\(baseHappyHours\)/);
  assert.doesNotMatch(homepage, /venueSlugMap = buildVenueSlugMap\(happyHours\)/);
  assert.match(homepage, /<a class="neighborhood-tag" href="\$\{escapeHTML\(neighborhoodPath\(h\.neighborhood\)/);
  assert.match(
    homepage,
    /<a class="card-image-link" href="\/venues\/\$\{slug\}\/">[\s\S]*?<\/a>\s*<div class="card-location-tags"[\s\S]*?<a class="neighborhood-tag"/,
  );

  const venue = {
    startTime: '15:00', endTime: '18:00',
    windows: [
      { days: ['Monday'], startTime: '15:00', endTime: '18:00' },
      { days: ['Friday'], startTime: '20:00', endTime: '00:00' },
    ],
  };
  assert.equal(venueMatchesTimeRange(venue, '14:00', '19:00', ['Monday']), true);
  assert.equal(venueMatchesTimeRange(venue, '16:00', '19:00', ['Monday']), false);
  assert.equal(venueMatchesTimeRange(venue, '19:00', '00:00', ['Friday']), true);
  assert.equal(venueMatchesTimeRange(venue, '14:00', '19:00', ['Friday']), false);
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

/**
 * A page is never both advertised to Google and told not to be indexed.
 *
 * The sitemap filter in astro.config.mjs excluded `unlisted` but not
 * `seoHidden`, while VenueHappyHourPage renders `noindex` for both — so 83
 * listings were submitted for crawling and then refused indexing on arrival.
 * Both sides now read `isSitemapEligible`, and this holds them to it: the
 * sitemap's answer must be exactly the negation of the page's noindex rule.
 */
function testHomepageCardSlugsMatchPrerenderedVenuePages() {
  // The homepage builds card links client-side. Slugs must come from the full
  // catalog — including unlisted claim stubs — or duplicate chain names lose
  // their neighborhood suffix and link to pages that were never generated.
  const fullCatalogSlugs = buildVenueSlugMap(getVenues());
  const homepageGrid = getVenues().filter((venue) => isPubliclyListed(venue));
  const mismatches = homepageGrid
    .filter((venue) => slugFromMap(venue, fullCatalogSlugs) !== venueSlug(venue))
    .map((venue) => ({
      id: venue.id,
      name: venue.name,
      cardSlug: slugFromMap(venue, fullCatalogSlugs),
      pageSlug: venueSlug(venue),
    }));
  assert.deepEqual(mismatches, []);

  const wrongSlugMap = buildVenueSlugMap(homepageGrid);
  assert.notEqual(
    slugFromMap({ id: 178, name: 'On The Border Mexican Grill & Cantina', neighborhood: 'Mira Mesa' }, wrongSlugMap),
    venueSlug(getVenues().find((venue) => venue.id === 178)),
  );
}

function testTheSitemapAndTheNoindexTagAgree() {
  // VenueHappyHourPage: noindex={venue.seoHidden || !isPubliclyListed(venue)}
  const pageIsNoIndex = (venue) => Boolean(venue.seoHidden) || !isPubliclyListed(venue);
  const disagreements = happyHours.filter(
    (venue) => isSitemapEligible(venue) === pageIsNoIndex(venue)
  );
  assert.deepEqual(disagreements.map(label), []);

  // And the flag has to still be doing something, or this passes vacuously.
  assert.ok(happyHours.some((venue) => venue.seoHidden && isPubliclyListed(venue)));
}

async function testAlertMatchCountsOnlyPublicVenues() {
  const account = await readFile(path.join(process.cwd(), 'src', 'pages', 'account.astro'), 'utf8');
  const sharedAlertsApi = await readFile(
    path.join(process.cwd(), 'src', 'pages', 'api', 'shared-alerts', '[shareId]', '[alertId].ts'),
    'utf8',
  );

  // The account page's "N spots match right now" preview must use the same
  // public catalog as the homepage grid, not the full import backlog.
  assert.match(account, /mergePublicVenues/);
  assert.match(account, /isPubliclyListed\(venue, published\)/);
  assert.doesNotMatch(account, /happyHoursCache = await res\.json\(\);\s*return happyHoursCache;/);

  // Shared alert previews and notification dispatch both read public venues only.
  assert.match(sharedAlertsApi, /getPublicMergedVenues\(\)/);

  const emptyFilters = {};
  const fromAll = getVenues().filter((venue) => alertMatchesVenue(emptyFilters, venue)).length;
  const fromPublic = homepageGridVenues().filter((venue) => alertMatchesVenue(emptyFilters, venue)).length;
  assert.ok(fromAll > fromPublic, 'catalog still includes hidden venues alerts must exclude');
  assert.equal(fromPublic, homepageGridVenues().length);
}

tests.push(
  testHomepageCardSlugsMatchPrerenderedVenuePages,
  testTheSitemapAndTheNoindexTagAgree,
  testEveryPublishedVenueIsOnTheHomepage,
  testEveryPublishedVenueCanBeFoundBySearchingItsOwnName,
  testEveryPublishedVenueSurvivesEveryFilterFacet,
  testVenuesWithNoDealTypesAreReachableThroughTheDealFilter,
  testHeroLiveCounterActivatesOnlyRecurringHappyHoursNow,
  testHomepageGridShowsLoadingBeforeItsTrueEmptyState,
  testHomepageTimeBoundsAndNeighborhoodLinksStayConsistent,
  testAConfirmedVenueIsNeverKeptOutOfTheIndexOrItsNeighborhoodPage,
  testABuildingFullOfTenantsIsNotAPublishedVenue,
  testAlertMatchCountsOnlyPublicVenues,
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
