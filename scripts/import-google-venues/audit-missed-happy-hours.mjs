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
import { extractLocatorHappyHour, fetchPageHtml, htmlToText } from './lib/happy-hour.mjs';

const REPORT_PATH = '.data/import/google/missed-happy-hours.json';
const SIGNAL_PATHS = ['', '/happy-hour', '/specials', '/menu'];
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

/** Does this site mention a happy hour anywhere obvious? One pass per domain. */
const signalCache = new Map();
async function siteMentionsHappyHour(websiteUri) {
  const host = hostOf(websiteUri);
  if (!host) return null;
  if (signalCache.has(host)) return signalCache.get(host);

  let hit = null;
  try {
    const origin = new URL(websiteUri).origin;
    for (const suffix of SIGNAL_PATHS) {
      const url = suffix ? `${origin}${suffix}` : websiteUri;
      const html = await fetchPageHtml(url);
      if (!html) continue;
      const text = htmlToText(html);
      const match = /happy\s*hour/i.exec(text);
      if (!match) continue;
      hit = { url, excerpt: text.slice(Math.max(0, match.index - 90), match.index + 160).replace(/\s+/g, ' ').trim() };
      break;
    }
  } catch {
    // Unreachable sites are simply not candidates.
  }

  signalCache.set(host, hit);
  return hit;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tier = process.argv.find((arg) => arg.startsWith('--tier='))?.split('=')[1] || 'all';

  const data = readJson(WITH_HH_PATH, { places: {} }).places || {};
  let candidates = Object.values(data).filter((place) => {
    if (place.hasHappyHour || !place.qualified) return false;
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
          days: found.days.length,
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

  confirmed.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
  signals.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));

  writeJson(REPORT_PATH, {
    meta: {
      generatedAt: new Date().toISOString(),
      candidates: candidates.length,
      confirmed: confirmed.length,
      signals: signals.length,
    },
    confirmed,
    signals,
  });

  console.log('='.repeat(64));
  console.log(`Ready to import now (locator-confirmed): ${confirmed.length}`);
  for (const row of confirmed.slice(0, 25)) {
    console.log(`  ${row.name} — ${row.address}`);
    console.log(`      ${row.startTime}-${row.endTime}, ${row.days} days: ${row.deals.join('; ') || '(no deal text)'}`);
  }
  console.log(`\nWorth an AI pass (site says happy hour, we could not parse it): ${signals.length}`);
  for (const row of signals.slice(0, 25)) {
    console.log(`  ${row.name} (${row.reviews} reviews) — ${row.foundOn}`);
    console.log(`      "${row.excerpt.slice(0, 120)}"`);
  }
  console.log(`\nEstimated deep-extract cost for those ${signals.length}: $${(signals.length * 0.0085).toFixed(2)}`);
  console.log(`Full report: ${REPORT_PATH}`);
}

main();
