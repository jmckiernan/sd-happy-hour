#!/usr/bin/env node
// Re-check venues that discovery discarded, now that Google's flag isn't the only gate.
//
// Every venue in with-happy-hour.json was judged under the old rules: Google's
// HAPPY_HOUR flag, or a shallow regex read of a handful of guessed paths. A
// miss recorded nothing about *why* it missed, so the only way to find the
// recoverable ones is to probe again.
//
// Two tiers, both free — no model calls:
//
//   confirmed  A locator widget publishes a happy hour for this exact address.
//              Ready to import as-is.
//   signal     The site says "happy hour" somewhere but the shallow scrape
//              could not pull a schedule out of it. These are the candidates
//              for the AI deep extract, and counting them first is what turns
//              "should we spend $40?" into a decision with a number behind it.
//
// Usage:
//   npm run audit:missed                 # both tiers
//   npm run audit:missed -- --tier=locator
//   npm run audit:missed -- --limit=100

import { WITH_HH_PATH } from './lib/constants.mjs';
import { readJson, writeJson, parseArgs } from './lib/io.mjs';
import { classifyCounty } from './lib/county.mjs';
import { isUsableVenueWebsite } from './lib/website-ownership.mjs';
import { extractLocatorHappyHour, siteMentionsHappyHour } from './lib/happy-hour.mjs';

const REPORT_PATH = '.data/import/google/missed-happy-hours.json';
const CONCURRENCY = 8;

/** Chains whose "happy hour" hits are franchise boilerplate, not a local offer. */
const NOT_A_BAR = /^(starbucks|chick-fil-a|in-n-out|dennys|raisingcanes|mcdonalds|dunkindonuts|subway|tacobell|jackinthebox|wendys|kfc|popeyes|paneraread|panerabread)\b/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function venueContextOf(place) {
  return {
    name: place.displayName?.text || place.displayName || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
  };
}

async function pool(items, worker, size = CONCURRENCY) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tier = process.argv.find((arg) => arg.startsWith('--tier='))?.split('=')[1] || 'all';

  const data = readJson(WITH_HH_PATH, { places: {} }).places || {};
  // A recovered venue is no longer a "miss", so it drops out of the pool. Pass
  // --include-recovered to re-check them anyway, which is what you want when
  // re-verifying an earlier recovery rather than hunting for new ones.
  const includeRecovered = process.argv.includes('--include-recovered');

  let candidates = Object.values(data).filter((place) => {
    const alreadyRecovered = includeRecovered && place.recoveredVia;
    if (!alreadyRecovered && (place.hasHappyHour || !place.qualified)) return false;
    if (!classifyCounty(place).inCounty) return false;
    if (!place.websiteUri || !isUsableVenueWebsite(place.websiteUri)) return false;
    const host = hostOf(place.websiteUri);
    return host && !NOT_A_BAR.test(host);
  });

  candidates.sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
  if (options.limit) candidates = candidates.slice(0, Number(options.limit));

  console.log(`Re-checking ${candidates.length} discarded in-county venues with a usable website.\n`);

  const confirmed = [];
  const signals = [];

  if (tier === 'all' || tier === 'locator') {
    // Only chains can have a locator, and the fetch is cached per domain, so
    // this is a few hundred requests no matter how many venues share a brand.
    const byHost = new Map();
    for (const place of candidates) {
      const host = hostOf(place.websiteUri);
      byHost.set(host, (byHost.get(host) || []).concat(place));
    }
    const chainVenues = [...byHost.values()].filter((group) => group.length > 1).flat();
    console.log(`Tier 1 — locator: ${chainVenues.length} venues across multi-location domains...`);

    await pool(chainVenues, async (place) => {
      try {
        const found = await extractLocatorHappyHour(place.websiteUri, venueContextOf(place));
        if (!found) return;
        confirmed.push({
          placeId: place.googlePlaceId || place.id,
          name: venueContextOf(place).name,
          address: place.formattedAddress,
          rating: place.rating,
          reviews: place.userRatingCount,
          startTime: found.startTime,
          endTime: found.endTime,
          days: found.days,
          deals: found.deals,
          source: found.sourcePage,
        });
      } catch {
        // Never let one bad site stop the audit.
      }
    });
    console.log(`  ${confirmed.length} venues have a locator-published happy hour.\n`);
  }

  if (tier === 'all' || tier === 'signal') {
    const remaining = candidates.filter(
      (place) => !confirmed.some((row) => row.placeId === (place.googlePlaceId || place.id))
    );
    console.log(`Tier 2 — signal: probing ${remaining.length} venues for any mention of a happy hour...`);

    let done = 0;
    await pool(remaining, async (place) => {
      const hit = await siteMentionsHappyHour(place.websiteUri);
      done += 1;
      if (done % 200 === 0) console.log(`  … ${done}/${remaining.length}`);
      if (!hit) return;
      signals.push({
        placeId: place.googlePlaceId || place.id,
        name: venueContextOf(place).name,
        address: place.formattedAddress,
        rating: place.rating,
        reviews: place.userRatingCount,
        foundOn: hit.url,
        excerpt: hit.excerpt,
      });
    });
    console.log(`  ${signals.length} sites mention a happy hour we failed to parse.\n`);
  }

  // Running one tier keeps the other tier's results rather than blanking them,
  // so a cheap locator re-check does not throw away an expensive signal sweep.
  const previous = readJson(REPORT_PATH, { confirmed: [], signals: [] });
  const finalConfirmed = tier === 'signal' ? previous.confirmed || [] : confirmed;
  const finalSignals = tier === 'locator' ? previous.signals || [] : signals;

  finalConfirmed.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
  finalSignals.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));

  writeJson(REPORT_PATH, {
    meta: {
      generatedAt: new Date().toISOString(),
      candidates: candidates.length,
      confirmed: finalConfirmed.length,
      signals: finalSignals.length,
    },
    confirmed: finalConfirmed,
    signals: finalSignals,
  });

  console.log('='.repeat(64));
  console.log(`Ready to import now (locator-confirmed): ${finalConfirmed.length}`);
  for (const row of finalConfirmed.slice(0, 25)) {
    console.log(`  ${row.name} — ${row.address}`);
    console.log(`      ${row.startTime}-${row.endTime}, ${row.days.length} days: ${row.deals.join('; ') || '(no deal text)'}`);
  }
  console.log(`\nWorth an AI pass (site says happy hour, we could not parse it): ${finalSignals.length}`);
  for (const row of finalSignals.slice(0, 25)) {
    console.log(`  ${row.name} (${row.reviews} reviews) — ${row.foundOn}`);
    console.log(`      "${row.excerpt.slice(0, 120)}"`);
  }
  console.log(`\nEstimated deep-extract cost for those ${finalSignals.length}: $${(finalSignals.length * 0.0085).toFixed(2)}`);
  console.log(`Full report: ${REPORT_PATH}`);
}

main();
