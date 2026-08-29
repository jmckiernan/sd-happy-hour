#!/usr/bin/env node
/**
 * Backfill happy-hour times from cached Google Places data and mark which
 * listings are trustworthy enough to publish.
 *
 * Google's `HAPPY_HOUR` secondary hours are structured and authoritative for
 * *timing*, but never contain deal text. So this pass:
 *
 *   - fills times/days (and multi-window schedules) from Google
 *   - records provenance for what it wrote
 *   - replaces the generic "Happy hour" placeholder with an explicit unknown
 *   - unlists venues we can't back with real data, keeping them claimable
 *
 * Usage:
 *   npm run backfill:google-hh              # dry run
 *   npm run backfill:google-hh -- --apply
 */

import { ENRICHED_PATH, HAPPY_HOURS_PATH } from './import-google-venues/lib/constants.mjs';
import { readJson, writeJson } from './import-google-venues/lib/io.mjs';
import { hasRealDeals } from './import-google-venues/lib/venue-quality.mjs';
import {
  happyHourFromPlace,
  indexPlacesByName,
  matchVenueToPlace,
} from './import-google-venues/lib/google-happy-hour.mjs';

/**
 * Which listings reach the public site:
 *   'verified-hours' — we know when happy hour runs, even if the deals aren't
 *                      published anywhere (the UI says so explicitly)
 *   'real-deals'     — stricter: also requires concrete deal text
 */
const PUBLISH_RULES = new Set(['verified-hours', 'real-deals']);

function parseBackfillArgs(argv) {
  const options = { apply: false, verbose: false, publishRule: 'verified-hours' };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg.startsWith('--publish-rule=')) options.publishRule = arg.slice(15);
  }
  if (!PUBLISH_RULES.has(options.publishRule)) {
    console.error(`--publish-rule must be one of: ${[...PUBLISH_RULES].join(', ')}`);
    process.exit(1);
  }
  return options;
}

function loadCachedPlaces() {
  const cache = readJson(ENRICHED_PATH, null);
  const places = cache?.places;
  if (!places) return [];
  return Array.isArray(places) ? places : Object.values(places);
}

function sameWindow(venue, hh) {
  return venue.startTime === hh.startTime && venue.endTime === hh.endTime;
}

const DEDICATED_HH_URL_RE = /happy[-_/ ]?hour|happyhour|specials/i;

/**
 * A venue's own happy-hour page outranks Google: it's where the deals came
 * from, and its times belong to the same reading. Google still gets recorded
 * as a cross-check, but it doesn't overwrite.
 */
function websiteSourceWins(venue) {
  return hasRealDeals(venue.deals) && DEDICATED_HH_URL_RE.test(venue.sourceUrl || '');
}

/**
 * Unlisted venues stay in the database as claimable profiles; they're just kept
 * out of public browse surfaces until we can back them with real data.
 */
function resolveListingStatus(venue, publishRule) {
  // An owner claimed and verified this listing, which outranks anything this
  // script can conclude from scraped evidence. Never take it back down.
  if (venue.publishedByClaim === true) return 'published';
  if (venue.verified === true) return 'published';
  if (!venue.hasHappyHourData) return 'unlisted';
  if (publishRule === 'real-deals' && !hasRealDeals(venue.deals)) return 'unlisted';
  return 'published';
}

function main() {
  const options = parseBackfillArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const places = loadCachedPlaces();

  if (!places.length) {
    console.error(`No cached Google places found at ${ENRICHED_PATH}`);
    process.exit(1);
  }

  const index = indexPlacesByName(places);
  const stats = {
    total: venues.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    timesFromGoogle: 0,
    timesConfirmed: 0,
    timesCorrected: 0,
    multiWindow: 0,
    placeholderCleared: 0,
    noHappyHourEvidence: 0,
    published: 0,
    unlisted: 0,
    publishedStrict: 0,
    websitePreferred: 0,
    conflicts: 0,
  };
  const corrections = [];
  const unsupported = [];

  for (const venue of venues) {
    const { place, reason } = matchVenueToPlace(venue, index);
    if (!place) {
      stats.unmatched += 1;
      if (reason === 'ambiguous_multi_location') stats.ambiguous += 1;
    } else {
      stats.matched += 1;
    }

    const hh = place ? happyHourFromPlace(place) : null;
    const dealsAreReal = hasRealDeals(venue.deals);
    const sources = { ...(venue.hhSources || {}) };

    if (hh && websiteSourceWins(venue)) {
      stats.websitePreferred += 1;
      venue.hasHappyHourData = true;
      venue.placeId = hh.placeId || venue.placeId;
      sources.times = {
        source: 'website_hh_page',
        url: venue.sourceUrl,
        observedAt: venue.lastVerifiedAt || null,
      };
      if (!sameWindow(venue, hh)) {
        venue.hhConflicts = [
          { field: 'times', source: 'google_places', value: `${hh.startTime}-${hh.endTime}` },
        ];
        stats.conflicts += 1;
      } else {
        delete venue.hhConflicts;
      }
    } else if (hh) {
      stats.timesFromGoogle += 1;
      if (sameWindow(venue, hh)) {
        stats.timesConfirmed += 1;
      } else {
        stats.timesCorrected += 1;
        if (corrections.length < 15) {
          corrections.push({
            venue: venue.name,
            stored: `${venue.startTime}–${venue.endTime}`,
            google: `${hh.startTime}–${hh.endTime}`,
          });
        }
      }

      venue.startTime = hh.startTime;
      venue.endTime = hh.endTime;
      venue.days = hh.days;

      if (hh.windows.length > 1) {
        stats.multiWindow += 1;
        venue.windows = hh.windows;
      } else if (venue.windows) {
        delete venue.windows;
      }

      venue.hasHappyHourData = true;
      venue.placeId = hh.placeId || venue.placeId;
      sources.times = {
        source: 'google_places',
        url: hh.sourceUrl,
        observedAt: new Date().toISOString().slice(0, 10),
      };
    } else if (!dealsAreReal) {
      // No structured Google window and no real deals: the stored times have
      // no support behind them, so stop presenting them as fact.
      stats.noHappyHourEvidence += 1;
      venue.hasHappyHourData = false;
      if (unsupported.length < 15) {
        unsupported.push({ venue: venue.name, stored: `${venue.startTime}–${venue.endTime}` });
      }
    } else {
      // Real deals scraped from the venue's own site stand on their own.
      venue.hasHappyHourData = true;
      if (!sources.times && venue.sourceUrl) {
        sources.times = { source: 'website_hh_page', url: venue.sourceUrl, observedAt: venue.lastVerifiedAt || null };
      }
    }

    if (dealsAreReal) {
      venue.dealsUnknown = false;
      if (!sources.deals && venue.sourceUrl) {
        sources.deals = {
          source: 'website_hh_page',
          url: venue.sourceUrl,
          observedAt: venue.lastVerifiedAt || null,
        };
      }
    } else {
      if (venue.deals?.length) stats.placeholderCleared += 1;
      venue.deals = [];
      venue.dealsUnknown = true;
      delete sources.deals;
    }

    if (Object.keys(sources).length) venue.hhSources = sources;
    else delete venue.hhSources;

    venue.listingStatus = resolveListingStatus(venue, options.publishRule);
    if (venue.listingStatus === 'published') stats.published += 1;
    else stats.unlisted += 1;

    if (resolveListingStatus(venue, 'real-deals') === 'published') stats.publishedStrict += 1;
  }

  console.log('--- Google happy hour backfill ---');
  console.log(`Venues:                    ${stats.total}`);
  console.log(`Matched to Google cache:   ${stats.matched} (unmatched ${stats.unmatched}, of which ambiguous ${stats.ambiguous})`);
  console.log(`Times sourced from Google: ${stats.timesFromGoogle} (confirmed ${stats.timesConfirmed}, corrected ${stats.timesCorrected})`);
  console.log(`Website page kept over Google: ${stats.websitePreferred} (time conflicts recorded: ${stats.conflicts})`);
  console.log(`Multi-window schedules:    ${stats.multiWindow}`);
  console.log(`Placeholder deals cleared: ${stats.placeholderCleared}`);
  console.log(`No happy-hour evidence:    ${stats.noHappyHourEvidence}`);
  console.log(`\nPublish rule:              ${options.publishRule}`);
  console.log(`Published:                 ${stats.published}`);
  console.log(`Unlisted (claimable only): ${stats.unlisted}`);
  console.log(`  (strict "real-deals" rule would publish only ${stats.publishedStrict})`);

  if (corrections.length) {
    console.log('\nTime corrections (sample):');
    for (const row of corrections) {
      console.log(`  ${row.venue}: ${row.stored} -> ${row.google}`);
    }
  }

  if (options.verbose && unsupported.length) {
    console.log('\nUnsupported times now hidden (sample):');
    for (const row of unsupported) console.log(`  ${row.venue}: ${row.stored}`);
  }

  if (options.apply) {
    writeJson(HAPPY_HOURS_PATH, venues);
    console.log(`\nApplied to ${HAPPY_HOURS_PATH}`);
  } else {
    console.log('\nDry run — pass --apply to write changes.');
  }
}

main();
