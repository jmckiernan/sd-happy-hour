#!/usr/bin/env node
// Re-derive dealTypes from the deal text already in the catalog.
//
// `inferDealTypes` runs at import, so a listing keeps whatever it was labelled
// at the time — and until this was fixed, the derivation read Google's place
// `types` alongside the deal text and defaulted to `food`, which put `food` on
// 767 of 800 scheduled venues. The stored values then went stale as deal text
// was cleaned, compressed and refreshed by clean-deal-text.mjs,
// compress-deals.mjs and refresh-deals.mjs, so they disagreed with the deal
// text on the same venue page: 210 venues advertised beer and could not be
// found by filtering for beer.
//
// Google's cached servesBeer/servesWine/servesCocktails supplement the text
// where it names no drink at all (see inferDealTypes). A venue we can derive
// nothing for keeps what it has: the catalog requires a non-empty dealTypes,
// and silence is no reason to overwrite a hand-curated value.
//
// Usage:
//   npm run rederive:deal-types -- --dry-run
//   npm run rederive:deal-types

import { execSync } from 'node:child_process';
import { DEAL_TYPES, ENRICHED_PATH, HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { inferDealTypes } from './lib/normalize.mjs';

/** A stub has no window, so it carries no deals and no dealTypes by design. */
function isStub(venue) {
  return venue.hasHappyHourData === false && !venue.startTime && !venue.endTime;
}

function union(...lists) {
  const all = new Set(lists.flat());
  return DEAL_TYPES.filter((type) => all.has(type));
}

function distribution(venues) {
  const counts = {};
  for (const venue of venues) {
    for (const type of venue.dealTypes || []) counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function formatDistribution(before, after) {
  const types = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return types
    .map((type) => `  ${type.padEnd(15)} ${String(before[type] || 0).padStart(4)} → ${String(after[type] || 0).padStart(4)}`)
    .join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(HAPPY_HOURS_PATH, []);
  // Left over from before the alcohol booleans were dropped from the Details
  // field mask, so it covers the venues enriched to date and no new ones.
  const places = readJson(ENRICHED_PATH, {})?.places || {};

  let changed = 0;
  let noDealText = 0;
  let fromBooleans = 0;
  const samples = [];

  const rederived = catalog.map((venue) => {
    if (isStub(venue)) return venue;

    const deals = venue.deals || [];
    const alcohol = venue.placeId ? places[venue.placeId] || {} : {};
    const stored = venue.dealTypes || [];

    // With deal text to read, the derivation replaces what is stored — that is
    // the whole point. Without it there is nothing to overrule, so the cached
    // booleans add to the stored value rather than standing in for it; a games
    // bar with no published offers should not lose its `entertainment`.
    const fromText = inferDealTypes(deals);
    const fromAlcohol = inferDealTypes([], alcohol);
    const derived = fromText.length ? inferDealTypes(deals, alcohol) : union(stored, fromAlcohol);
    if (!derived.length) return venue;

    if (!fromText.length) noDealText += 1;
    if (fromAlcohol.some((type) => !stored.includes(type) && derived.includes(type))) fromBooleans += 1;

    if (derived.length === stored.length && derived.every((type) => stored.includes(type))) return venue;

    changed += 1;
    if (samples.length < 15) {
      samples.push(
        `  ${venue.name}\n      deals: ${JSON.stringify(deals)}\n      was: ${JSON.stringify(stored)}\n      now: ${JSON.stringify(derived)}`
      );
    }
    return { ...venue, dealTypes: derived };
  });

  const scheduled = catalog.filter((venue) => !isStub(venue));
  console.log(`Listings: ${catalog.length} (${scheduled.length} with a window)`);
  console.log(`  dealTypes changed: ${changed}`);
  console.log(`  no deal text to read (stored value kept, booleans added): ${noDealText}`);
  console.log(`  gained a drink type from the cached Google booleans: ${fromBooleans}`);
  console.log('\nDistribution (before → after):');
  console.log(formatDistribution(distribution(scheduled), distribution(rederived.filter((venue) => !isStub(venue)))));
  console.log('\nSamples:');
  console.log(samples.join('\n'));

  if (options.dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, rederived);
  console.log(`\nWrote ${rederived.length} listings.`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed. Review happy-hours.json.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
