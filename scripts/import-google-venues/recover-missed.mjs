#!/usr/bin/env node
// Recover the venues audit:missed found, and fold them back into the pipeline.
//
// Reads the audit report, then for each shortlisted venue:
//   confirmed  already has a locator-published happy hour — taken as-is
//   signal     the site claims a happy hour the shallow scrape could not read,
//              so run the AI deep extract on it
//
// The AI runs only against sites that already claim a happy hour, which is the
// whole point of the prefilter: 31 venues instead of ~4,700.
//
// With --apply the results are written back into with-happy-hour.json, so the
// normal stage/promote path picks them up like any other discovery.
//
// Usage:
//   npm run recover:missed             # dry run, shows what it would set
//   npm run recover:missed -- --apply

import { WITH_HH_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { extractWebsiteHappyHourWithAi, hasUsableSchedule } from './lib/happy-hour.mjs';
import { finalizeDeals } from './lib/deals.mjs';

const REPORT_PATH = '.data/import/google/missed-happy-hours.json';
const AI_CONCURRENCY = 3;

/**
 * San Diego County cities that show up as path segments on chain sites. A
 * Cinépolis venue in La Costa was extracted from the Vista theater's page,
 * which is the same brand-wide leak the locator matching guards against:
 * plausible text about the wrong store.
 */
const CITY_SLUGS = [
  'vista', 'carlsbad', 'encinitas', 'oceanside', 'escondido', 'poway', 'santee',
  'la-costa', 'la-jolla', 'la-mesa', 'chula-vista', 'el-cajon', 'san-marcos',
  'del-mar', 'coronado', 'national-city', 'imperial-beach', 'solana-beach',
  'rancho-bernardo', 'point-loma', 'pacific-beach', 'mission-valley', 'temecula',
];

function citiesIn(text) {
  const haystack = String(text || '').toLowerCase().replace(/[\s_]+/g, '-');
  return CITY_SLUGS.filter((city) => haystack.includes(city));
}

/** True when the page we extracted from is clearly about a different branch. */
function sourceCityConflicts(sourcePage, place) {
  const fromUrl = citiesIn(sourcePage);
  if (!fromUrl.length) return false;
  const fromVenue = citiesIn(`${place.formattedAddress || ''} ${place.displayName?.text || ''}`);
  if (!fromVenue.length) return false;
  return !fromUrl.some((city) => fromVenue.includes(city));
}

/**
 * A result can come back "found" with no usable schedule — a page title that
 * says Happy Hour, or a line like "Come by for a Happy Hour". Those are not
 * listings, and importing them would put empty times on a venue page.
 */
function rejectReason(result, deals, place) {
  if (!hasUsableSchedule(result)) return 'no usable start/end time';
  if (!deals.length) return 'no deal text';
  if (deals.length === 1 && /^come by|^happy hour$/i.test(deals[0]) && result.confidence !== 'high') {
    return 'deal text is just a mention, not an offer';
  }
  if (sourceCityConflicts(result.sourcePage, place)) {
    return `extracted from another branch's page (${result.sourcePage})`;
  }
  return null;
}

function venueContextOf(place) {
  return {
    name: place.displayName?.text || place.displayName || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
  };
}

async function pool(items, worker, size) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index]);
      }
    })
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const report = readJson(REPORT_PATH, null);
  if (!report) {
    console.error(`No report at ${REPORT_PATH}. Run npm run audit:missed first.`);
    process.exit(1);
  }

  const store = readJson(WITH_HH_PATH, { places: {} });
  const places = store.places || {};
  const byId = new Map();
  for (const [key, place] of Object.entries(places)) {
    byId.set(place.googlePlaceId || place.id || key, key);
  }

  const updates = [];

  for (const row of report.confirmed) {
    const key = byId.get(row.placeId);
    if (!key) continue;
    updates.push({
      key,
      name: row.name,
      via: 'locator',
      happyHour: {
        startTime: row.startTime,
        endTime: row.endTime,
        days: row.days,
        deals: row.deals,
        source: 'website',
        sourcePage: row.source,
        confidence: 'medium',
      },
      summary: `${row.startTime}-${row.endTime}, ${row.deals.join('; ') || 'no deal text'}`,
    });
  }

  const signals = report.signals.filter((row) => byId.has(row.placeId));
  console.log(`${report.confirmed.length} locator-confirmed, ${signals.length} to run through the AI extract.\n`);

  let done = 0;
  const failures = [];
  await pool(signals, async (row) => {
    const key = byId.get(row.placeId);
    const place = places[key];
    const context = { ...venueContextOf(place), sourceUrl: row.foundOn };
    let result = null;
    try {
      result = await extractWebsiteHappyHourWithAi(place.websiteUri, context);
    } catch (error) {
      failures.push({ name: row.name, reason: error.message });
    }
    done += 1;
    if (!result?.found) {
      failures.push({ name: row.name, reason: result?.reason || 'no schedule extracted' });
      console.log(`  ✗ ${row.name} — ${result?.reason || 'no schedule extracted'}`);
      return;
    }
    const deals = finalizeDeals(result.deals || []);
    const reject = rejectReason(result, deals, place);
    if (reject) {
      failures.push({ name: row.name, reason: reject });
      console.log(`  ✗ ${row.name} — rejected: ${reject}`);
      return;
    }
    updates.push({
      key,
      name: row.name,
      via: 'ai',
      happyHour: {
        startTime: result.startTime,
        endTime: result.endTime,
        days: result.days,
        windows: result.windows,
        deals,
        source: 'website',
        sourcePage: result.sourcePage,
        confidence: result.confidence,
      },
      summary: `${result.startTime}-${result.endTime}, ${deals.join('; ') || 'no deal text'}`,
    });
    console.log(`  ✓ ${row.name} — ${result.startTime}-${result.endTime} (${result.confidence})`);
  }, AI_CONCURRENCY);

  console.log('\n' + '='.repeat(64));
  console.log(`Recovered ${updates.length} venues (${updates.filter((u) => u.via === 'locator').length} locator, ${updates.filter((u) => u.via === 'ai').length} AI):\n`);
  for (const update of updates) {
    console.log(`  [${update.via}] ${update.name}`);
    console.log(`         ${update.summary}`);
  }
  console.log(`\n${failures.length} could not be parsed even with the model.`);

  if (!apply) {
    console.log('\nDry run — pass --apply to write these into with-happy-hour.json.');
    return;
  }

  for (const update of updates) {
    places[update.key] = {
      ...places[update.key],
      happyHour: update.happyHour,
      hasHappyHour: true,
      happyHourCheckedAt: new Date().toISOString(),
      recoveredVia: update.via,
    };
  }
  writeJson(WITH_HH_PATH, { ...store, places });
  console.log(`\nWrote ${updates.length} recoveries into ${WITH_HH_PATH}.`);
  console.log('Next: npm run import:venues:stage');
}

main();
