#!/usr/bin/env node
// Seed venues from the store locators of brands we already know about.
//
// Discovery is a grid of nearby-searches, which only returns what ranks highly
// in each circle. Board & Brew has 14 San Diego County locations and the grid
// found 6 of them, so 8 stores that publish their own address and happy hour
// were never even considered. We were asking Google to find places a brand
// hands us directly.
//
// So: for every multi-location domain in the enrich cache, read its locator,
// drop the records we already have, and look the rest up by address. Google
// still decides whether a place is real, in-county, and popular enough — this
// only changes which addresses we think to ask about.
//
// Usage:
//   npm run seed:locators                      # dry run
//   npm run seed:locators -- --apply
//   npm run seed:locators -- --domain=boardandbrew.com --apply

import { ENRICHED_PATH, WITH_HH_PATH, MIN_RATING, MIN_REVIEWS } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { textSearch, placeDetails, placeIdKey, displayName } from './lib/google-places.mjs';
import { locatorRecordsForSite, happyHourFromLocatorText } from './lib/happy-hour.mjs';
import { classifyCounty } from './lib/county.mjs';
import { finalizeDeals } from './lib/deals.mjs';

const NEARBY_METERS = 150;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}

function alreadyKnown(record, knownPoints) {
  if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) return false;
  return knownPoints.some(
    (point) => distanceMeters(record.lat, record.lng, point.lat, point.lng) < NEARBY_METERS
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const scopeOnly = process.argv.includes('--scope');
  let lookupsNeeded = 0;
  const onlyDomain = process.argv.find((arg) => arg.startsWith('--domain='))?.split('=')[1];

  const enrichedStore = readJson(ENRICHED_PATH, { places: {}, meta: {} });
  const enriched = enrichedStore.places || {};
  const whStore = readJson(WITH_HH_PATH, { places: {}, meta: {} });
  const withHappyHour = whStore.places || {};

  // Group known places by domain so we can tell a chain from a one-off, and
  // know which of its stores we already hold.
  const byDomain = new Map();
  for (const place of Object.values(enriched)) {
    const host = place.websiteUri ? hostOf(place.websiteUri) : null;
    if (!host) continue;
    byDomain.set(host, (byDomain.get(host) || []).concat(place));
  }

  let domains = [...byDomain.entries()].filter(([, places]) => places.length > 1);
  if (onlyDomain) domains = domains.filter(([host]) => host === onlyDomain);
  domains.sort((a, b) => b[1].length - a[1].length);

  console.log(`Scanning ${domains.length} multi-location domains for a store locator.\n`);

  const found = [];
  const skipped = { known: 0, noOffer: 0, noMatch: 0, outOfCounty: 0, belowBar: 0, closed: 0 };

  for (const [host, places] of domains) {
    const seed = places.find((place) => place.websiteUri);
    let records = [];
    try {
      records = await locatorRecordsForSite(seed.websiteUri, { name: displayName(seed) });
    } catch {
      continue;
    }
    if (!records.length) continue;

    const knownPoints = places
      .map((place) => ({
        lat: place.location?.latitude,
        lng: place.location?.longitude,
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

    const brand = displayName(seed).replace(/\s*[-–|].*$/, '').trim();
    const newRecords = records.filter((record) => {
      if (alreadyKnown(record, knownPoints)) {
        skipped.known += 1;
        return false;
      }
      if (!happyHourFromLocatorText(record.offerText, seed.websiteUri)) {
        skipped.noOffer += 1;
        return false;
      }
      return true;
    });

    if (!newRecords.length) continue;
    console.log(`${host}: ${records.length} locations, ${newRecords.length} unknown with a happy hour`);

    // --scope counts the Google lookups a real run would make without making
    // any of them, since Places calls are billed and locator reads are not.
    if (scopeOnly) {
      lookupsNeeded += newRecords.length;
      continue;
    }

    for (const record of newRecords) {
      const query = `${brand} ${record.address || record.name || ''}`.trim();
      let hits = [];
      try {
        hits = await textSearch(query);
      } catch (error) {
        console.log(`  ! lookup failed for ${record.name}: ${error.message}`);
        continue;
      }

      // Trust the address, not the name: take the nearest result to the
      // locator's own coordinates rather than whatever Google ranked first.
      const hit = hits
        .filter((candidate) => candidate.location)
        .map((candidate) => ({
          candidate,
          meters: Number.isFinite(record.lat)
            ? distanceMeters(record.lat, record.lng, candidate.location.latitude, candidate.location.longitude)
            : 0,
        }))
        .sort((a, b) => a.meters - b.meters)
        .find((row) => row.meters < 400)?.candidate;

      if (!hit) {
        skipped.noMatch += 1;
        console.log(`  ✗ ${record.name}: no Google place within 400m of the published address`);
        continue;
      }

      const id = placeIdKey(hit);
      if (enriched[id]) {
        skipped.known += 1;
        continue;
      }

      let details;
      try {
        details = await placeDetails(id);
      } catch (error) {
        console.log(`  ! details failed for ${record.name}: ${error.message}`);
        continue;
      }

      const county = classifyCounty(details);
      if (!county.inCounty) {
        skipped.outOfCounty += 1;
        continue;
      }
      if ((details.businessStatus || 'OPERATIONAL') !== 'OPERATIONAL') {
        skipped.closed += 1;
        continue;
      }
      const rating = details.rating ?? 0;
      const reviews = details.userRatingCount ?? 0;
      if (rating < MIN_RATING || reviews < MIN_REVIEWS) {
        skipped.belowBar += 1;
        console.log(`  – ${displayName(details)}: ${rating}★ / ${reviews} reviews, below the bar`);
        continue;
      }

      const happyHour = happyHourFromLocatorText(record.offerText, record.sourceUrl || seed.websiteUri);
      found.push({
        id,
        details,
        county: county.county,
        happyHour: { ...happyHour, deals: finalizeDeals(happyHour.deals || []) },
      });
      console.log(`  ✓ ${displayName(details)} — ${details.formattedAddress}`);
      console.log(`      ${happyHour.startTime}-${happyHour.endTime}: ${finalizeDeals(happyHour.deals).join('; ')}`);
    }
  }

  if (scopeOnly) {
    console.log('\n' + '='.repeat(64));
    console.log(`${lookupsNeeded} addresses would need a Google lookup.`);
    console.log(`That is ${lookupsNeeded} Text Search calls plus up to ${lookupsNeeded} Place Details calls.`);
    console.log(`Skipped without any Google call: ${skipped.known} already known, ${skipped.noOffer} with no happy hour.`);
    return;
  }

  console.log('\n' + '='.repeat(64));
  console.log(`${found.length} new venues to add.`);
  console.log(
    `Skipped: ${skipped.known} already known, ${skipped.noOffer} no happy hour, ` +
      `${skipped.noMatch} unmatched, ${skipped.outOfCounty} out of county, ` +
      `${skipped.belowBar} below rating/review bar, ${skipped.closed} not operational.`
  );

  if (!apply) {
    console.log('\nDry run — pass --apply to add these to the enrich cache.');
    return;
  }

  for (const row of found) {
    enriched[row.id] = {
      ...row.details,
      googlePlaceId: row.id,
      displayName: displayName(row.details),
      county: row.county,
      qualified: true,
      detailsFetchedAt: new Date().toISOString(),
      seededFrom: 'locator',
    };
    withHappyHour[row.id] = {
      ...enriched[row.id],
      happyHour: row.happyHour,
      hasHappyHour: true,
      happyHourCheckedAt: new Date().toISOString(),
      recoveredVia: 'locator-seed',
    };
  }

  writeJson(ENRICHED_PATH, { ...enrichedStore, places: enriched });
  writeJson(WITH_HH_PATH, { ...whStore, places: withHappyHour });
  console.log(`\nAdded ${found.length} venues. Next: npm run import:venues:stage`);
}

main();
